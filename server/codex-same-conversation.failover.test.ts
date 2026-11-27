import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem, FamilyAdapter } from "./adapter";
import { CODEX_FAST_METADATA_KEY, type CodexSpeedState } from "./codex-fast";
import { detectCodexLimit, detectCodexSignOut } from "./limits";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore, StoredAccountSchema, type StoredAccount } from "./state";
import { preferences } from "../shared/preferences";
import type { SwitchRow } from "../shared/timeline";
import { absentPi } from "./fakes.test-support";

type PaseoApi = PluginHookContext["paseo"];
type Create = Parameters<ReturnType<PaseoApi["workspaces"]["ref"]>["agents"]["create"]>[0];
type Snapshot = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"];
type Entry = { item: AgentTimelineItem; timestamp: string; seqStart: number; seqEnd: number; turnId?: string };

const LIMIT = "You've hit your usage limit. Try again at 3:45 PM.";
const CREDITS = "Your workspace is out of credits. Add credits to continue.";
const SPEND_CAP = "You hit your spend cap. Try again later.";
const DECRYPT = "invalid_encrypted_content: organization_id mismatch";
const FAST_CONTROLS = [{
  type: "select" as const, key: "service_tier", label: "Speed",
  choices: [{ value: "default", label: "Standard" }, { value: "priority", label: "Fast" }],
}];

let savedHome: string | undefined;
let savedPaseo: string | undefined;
const services: Service[] = [];
const dirs: string[] = [];

beforeEach(() => {
  savedHome = process.env.CODEX_HOME;
  savedPaseo = process.env.PASEO_HOME;
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  if (savedHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedHome;
  if (savedPaseo === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = savedPaseo;
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 5 })));
});

function account(id: string, identity: string, home: string | null, kind: "main" | "managed"): StoredAccount {
  return StoredAccountSchema.parse({
    id,
    family: "codex",
    label: id.toUpperCase(),
    kind,
    home,
    identity,
    email: `${id}@example.com`,
    createdAt: "2026-10-01T00:00:00.000Z",
  });
}

async function setup(options: {
  sameConversation?: boolean;
  identityA?: string;
  identityB?: string;
  linkSessions?: boolean;
  reload?: "works" | "fails";
  autoContinue?: boolean;
  speed?: "managed" | "manual";
  speedWriteFails?: boolean;
} = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zerosub-same-conversation-"));
  dirs.push(dir);
  process.env.CODEX_HOME = join(dir, "codex");
  process.env.PASEO_HOME = dir;
  const main = join(dir, "codex");
  const homeB = join(dir, "b");
  await mkdir(join(main, "sessions"), { recursive: true });
  await mkdir(homeB, { recursive: true });
  if (options.linkSessions === false) await mkdir(join(homeB, "sessions"), { recursive: true });
  else await symlink(join(main, "sessions"), join(homeB, "sessions"));

  const a = account("a", options.identityA ?? "chatgpt|ws|a@example.com", null, "main");
  const b = account("b", options.identityB ?? "chatgpt|ws|b@example.com", homeB, "managed");
  if (options.speed) a.codexFastUntil = "2099-12-31";
  const store = new StateStore(join(dir, "state.json"));
  await store.update((draft) => {
    draft.accounts = [a, b];
    draft.defaults.codex = "a";
    draft.bindings.root = { accountId: "a", source: "thread", at: "2026-10-01T00:00:00.000Z" };
    draft.sessions.root = { accountId: "a", family: "codex", openedAt: "2026-10-01T00:00:00.000Z" };
    draft.continuations.root = {
      activeAgentId: "root",
      members: { root: { accountId: "a", identity: a.identity, email: a.email, seen: {} } },
    };
  });

  const agents = new Map<string, Snapshot & CodexSpeedState>();
  const timelines = new Map<string, Entry[]>();
  let clock = 0;
  function addAgent(id: string, values: Partial<Snapshot & CodexSpeedState> = {}) {
    const agent = {
      id, provider: "codex", model: "synthetic-model", title: "Fix the build", cwd: dir, workspaceId: "workspace-1",
      status: "idle", currentModeId: "full-access", thinkingOptionId: "high", labels: {},
      features: [{ type: "toggle", id: "fast_mode", value: true, label: "Fast" }],
      archivedAt: null, lastUserMessageAt: "2026-10-01T00:00:00.000Z", pendingPermissions: [], ...values,
    } as Snapshot & CodexSpeedState;
    agents.set(id, agent);
    timelines.set(id, []);
    return agent;
  }
  function add(id: string, item: AgentTimelineItem) {
    const entries = timelines.get(id)!;
    const seq = entries.length + 1;
    entries.push({ item, timestamp: new Date(1_700_000_000_000 + clock++ * 1000).toISOString(), seqStart: seq, seqEnd: seq, turnId: "accepted-turn" });
    if (item.type === "user_message") agents.get(id)!.lastUserMessageAt = entries.at(-1)!.timestamp;
  }
  addAgent("root", options.speed ? {
    controls: FAST_CONTROLS,
    options: { service_tier: "priority" },
    metadata: options.speed === "managed" ? { [CODEX_FAST_METADATA_KEY]: true } : {},
  } : {});
  add("root", { type: "user_message", text: "Repair the build." });
  add("root", { type: "assistant_message", text: "The parser has been repaired." });

  const created: Create[] = [];
  const sent: Array<{ id: string; text: string }> = [];
  const speedEvents: Array<{ kind: "setOptions" | "send"; id: string; tier: unknown; accountId?: string }> = [];
  const notes: SwitchRow[] = [];
  let releaseSpeedScan = () => {};
  const speedScan = new Promise<void>((resolve) => { releaseSpeedScan = resolve; });
  const create = vi.fn(async (request: Create) => {
    created.push(request);
    addAgent(request.agentId!, { labels: request.labels, title: request.title, currentModeId: request.config.modeId ?? null, lastUserMessageAt: null });
    const binding = (await store.read()).bindings[request.agentId!];
    await store.update((draft) => {
      draft.sessions[request.agentId!] = { accountId: binding?.accountId ?? "b", family: "codex", openedAt: "now" };
    });
  });
  const refetch = async (id: string, options: { direction?: string; cursor?: { epoch: string; seq: number }; limit?: number }) => {
    const all = timelines.get(id) ?? [];
    const eligible = all.filter((entry) => options.direction !== "before" || entry.seqEnd < options.cursor!.seq);
    const entries = eligible.slice(-(options.limit ?? 500));
    return {
      epoch: "epoch-1", window: { minSeq: 1, maxSeq: all.length, nextSeq: all.length + 1 }, entries,
      startCursor: entries.length ? { epoch: "epoch-1", seq: entries[0]!.seqStart } : null,
      endCursor: entries.length ? { epoch: "epoch-1", seq: entries.at(-1)!.seqEnd } : null,
      hasOlder: eligible.length > entries.length, gap: false, staleCursor: false,
    };
  };
  const paseo = {
    providers: { listModels: async () => ({ models: [{ id: "synthetic-model", isDefault: true }] }) },
    workspaces: { ref: () => ({ agents: { create } }) },
    agents: {
      create,
      list: async (request?: { filter?: { includeBackground?: boolean } }) => {
        // A slow background scan must not be needed to make the carry-on safe.
        if (options.speed && request?.filter?.includeBackground) await speedScan;
        return { entries: [...agents.values()].map((agent) => ({ agent })), pageInfo: { hasMore: false } };
      },
      ref: (id: string) => ({
        refresh: async () => agents.has(id) ? { agent: structuredClone(agents.get(id)) } : null,
        setOptions: async (patch: { service_tier: "fast" | "default" }) => {
          if (options.speedWriteFails) throw new Error("speed unavailable");
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
          const agent = agents.get(id)!;
          agent.options = { ...agent.options, ...patch, service_tier: patch.service_tier === "fast" ? "priority" : patch.service_tier };
          speedEvents.push({ kind: "setOptions", id, tier: agent.options.service_tier });
        },
        setMetadata: async (patch: Record<string, true | null>) => {
          const agent = agents.get(id)!;
          agent.metadata = { ...agent.metadata, ...patch };
        },
        send: async (text: string) => {
          const event = { kind: "send" as const, id, tier: agents.get(id)?.options?.service_tier, accountId: undefined as string | undefined };
          speedEvents.push(event);
          event.accountId = (await store.read()).sessions[id]?.accountId;
          sent.push({ id, text });
        },
        timeline: {
          refetch: (refetchOptions: Parameters<typeof refetch>[1]) => refetch(id, refetchOptions),
          append: async (item: { data: SwitchRow }) => { notes.push(item.data); },
        },
      }),
    },
  } as unknown as PaseoApi;

  const reopened: string[] = [];
  let service: Service;
  const reopener = {
    locate: async () => "/usr/local/bin/paseo",
    reopen: async (id: string) => {
      reopened.push(id);
      await service.onSessionOpen({ agentId: id, provider: "codex", reason: "refresh", purpose: "interactive", env: {} } as never, { paseo } as never);
      if (options.reload === "fails") return { ok: false as const, error: "reload failed", timedOut: false };
      return { ok: true as const };
    },
  };
  const adapter = {
    family: "codex",
    portable: false,
    usageSpacingMs: 0,
    detectLimit: detectCodexLimit,
    detectSignOut: detectCodexSignOut,
    env: async (home: string | null) => (home ? { CODEX_HOME: home } : {}),
    prepareHome: async () => undefined,
    identity: async () => null,
    usage: async () => ({
      fetchedAt: new Date().toISOString(),
      windows: options.speed ? [{
        id: "secondary", label: "Weekly", minutes: 10_080, usedPercent: 20,
        resetsAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
      }] : [],
      error: null, cached: false, resets: null,
    }),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
  } as unknown as FamilyAdapter;
  service = new Service(
    { codex: adapter, claude: adapter, pi: absentPi() },
    store,
    { resolve: async () => ({ codex: "codex" as const }) } as unknown as FamilyResolver,
    reopener as unknown as Reopener,
  );
  services.push(service);
  service.setPreferences(preferences.schema.parse({ codexSameConversation: options.sameConversation === true, autoContinue: options.autoContinue }));
  if (options.speed) await service.refreshUsage(a.id);

  const endTurn = (message: string, kind: "failed" | "completed" = "failed", timeline: AgentTimelineItem[] = []) => service.onTurnEnded({
    agent: { id: "root", provider: "codex" },
    turnId: `turn-${clock++}`,
    outcome: kind === "failed" ? { kind, error: { message } } : { kind },
    timeline,
  } as never, { paseo } as never);

  return { service, store, paseo, created, sent, notes, reopened, endTurn, a, b, speedEvents, releaseSpeedScan };
}

describe("Codex same-conversation failover", () => {
  it("keeps today's new tab when the option is off", async () => {
    const t = await setup();
    await t.endTurn(LIMIT);
    expect(t.reopened).toEqual([]);
    expect(t.created).toHaveLength(1);
    const state = await t.store.read();
    expect(state.bindings.root).toMatchObject({ accountId: "a", source: "thread" });
    expect(state.continuations.root?.members.root).toMatchObject({ accountId: "a", email: "a@example.com" });
    expect(t.notes.at(-1)?.outcome).toBe("continued");
    expect(t.notes.at(-1)?.sameConversation).toBeUndefined();
  });

  it("reloads the same agent for two members of one workspace and updates the chain in that write", async () => {
    const t = await setup({ sameConversation: true });
    await t.endTurn(LIMIT);
    expect(t.reopened).toEqual(["root"]);
    expect(t.created).toEqual([]);
    expect(t.sent.map((entry) => entry.id)).toEqual(["root"]);
    const state = await t.store.read();
    expect(state.bindings.root).toMatchObject({ accountId: "b", source: "auto" });
    expect(state.sessions.root?.accountId).toBe("b");
    expect(state.continuations.root?.members.root).toMatchObject({
      accountId: "b",
      identity: "chatgpt|ws|b@example.com",
      email: "b@example.com",
    });
    expect(Object.keys(state.continuations.root?.members ?? {})).toEqual(["root"]);
    expect(t.notes.at(-1)).toMatchObject({ outcome: "switched", sameConversation: true, to: "B", continued: true });
  });

  it("uses Standard before carrying on after a spend-cap switch to an account not opted into Fast", async () => {
    const t = await setup({ sameConversation: true, speed: "managed" });
    try {
      expect(t.a.codexFastUntil).toBeDefined();
      expect(t.b.codexFastUntil).toBeUndefined();
      expect((await t.paseo.agents.ref("root").refresh())?.agent).toMatchObject({
        options: { service_tier: "priority" }, metadata: { [CODEX_FAST_METADATA_KEY]: true },
      });
      await t.endTurn(SPEND_CAP);
      expect(t.reopened).toEqual(["root"]);
      expect(t.created).toEqual([]);
      expect(t.speedEvents).toEqual([
        { kind: "setOptions", id: "root", tier: "default" },
        { kind: "send", id: "root", tier: "default", accountId: "b" },
      ]);
    } finally {
      t.releaseSpeedScan();
    }
  });

  it("preserves user-selected Fast when switching to an account not opted into Fast", async () => {
    const t = await setup({ sameConversation: true, speed: "manual" });
    try {
      expect((await t.paseo.agents.ref("root").refresh())?.agent).toMatchObject({
        options: { service_tier: "priority" }, metadata: {},
      });
      await t.endTurn(SPEND_CAP);
      expect(t.reopened).toEqual(["root"]);
      expect(t.created).toEqual([]);
      expect(t.speedEvents).toEqual([{ kind: "send", id: "root", tier: "priority", accountId: "b" }]);
    } finally {
      t.releaseSpeedScan();
    }
  });

  it("keeps the account switch but skips carry-on when managed Fast cannot be reset", async () => {
    const t = await setup({ sameConversation: true, speed: "managed", speedWriteFails: true });
    try {
      await t.endTurn(SPEND_CAP);
      expect((await t.store.read()).sessions.root?.accountId).toBe("b");
      expect(t.created).toEqual([]);
      expect(t.sent).toEqual([]);
      expect(t.notes.at(-1)).toMatchObject({
        outcome: "switched",
        continued: false,
        detail: expect.stringContaining("speed unavailable"),
      });
    } finally {
      t.releaseSpeedScan();
    }
  });

  it("opens a new tab when the workspace is out of credits", async () => {
    const t = await setup({ sameConversation: true });
    await t.endTurn(CREDITS);
    expect(t.reopened).toEqual([]);
    expect(t.created).toHaveLength(1);
    expect((await t.store.read()).bindings.root?.accountId).toBe("a");
  });

  it("opens a new tab for another workspace or an email-only key", async () => {
    const other = await setup({ sameConversation: true, identityB: "chatgpt|other|b@example.com" });
    await other.endTurn(LIMIT);
    expect(other.created).toHaveLength(1);
    expect(other.reopened).toEqual([]);

    const email = await setup({
      sameConversation: true,
      identityA: "chatgpt-email|a@example.com|ws",
      identityB: "chatgpt-email|b@example.com|ws",
    });
    await email.endTurn(LIMIT);
    expect(email.created).toHaveLength(1);
    expect(email.reopened).toEqual([]);
  });

  it("opens a new tab when the other home does not link sessions", async () => {
    const t = await setup({ sameConversation: true, linkSessions: false });
    await t.endTurn(LIMIT);
    expect(t.reopened).toEqual([]);
    expect(t.created).toHaveLength(1);
    expect((await t.store.read()).sessions.root?.accountId).toBe("a");
  });

  it("puts the binding back and opens a new tab when the reload fails", async () => {
    const t = await setup({ sameConversation: true, reload: "fails" });
    await t.endTurn(LIMIT);
    expect(t.reopened).toEqual(["root"]);
    expect(t.created).toHaveLength(1);
    const state = await t.store.read();
    expect(state.bindings.root).toMatchObject({ accountId: "a", source: "thread" });
    expect(state.continuations.root?.members.root?.accountId).toBe("a");
    expect(state.sessions.root?.accountId).toBe("a");
  });

  it("pins the agent back and opens a new tab when the first turn cannot resume the thread", async () => {
    const t = await setup({ sameConversation: true });
    await t.endTurn(LIMIT);
    await t.endTurn(DECRYPT);
    expect(t.reopened).toEqual(["root", "root"]);
    expect(t.created).toHaveLength(1);
    const state = await t.store.read();
    expect(state.bindings.root).toMatchObject({ accountId: "a", source: "thread" });
    expect(state.sessions.root?.accountId).toBe("a");
    expect(state.continuations.root?.members.root).toMatchObject({ accountId: "a", email: "a@example.com" });
    expect(t.notes.at(-1)).toMatchObject({ outcome: "continued", detail: "B could not resume this thread." });

    await t.endTurn(LIMIT);
    expect(t.reopened).toEqual(["root", "root"]);
    expect(t.created).toHaveLength(1);
  });

  it("keeps the switch after the first turn succeeds, and drops the probe on any other failure", async () => {
    const stayed = await setup({ sameConversation: true });
    await stayed.endTurn(LIMIT);
    await stayed.endTurn("done", "completed");
    await stayed.endTurn(DECRYPT);
    expect(stayed.created).toEqual([]);
    expect((await stayed.store.read()).bindings.root?.accountId).toBe("b");

    const other = await setup({ sameConversation: true });
    await other.endTurn(LIMIT);
    await other.endTurn("connection reset");
    await other.endTurn(DECRYPT);
    expect(other.created).toEqual([]);
    expect((await other.store.read()).bindings.root?.accountId).toBe("b");
    expect((await other.store.read()).sessions.root?.accountId).toBe("b");
  });

  // Paseo 0.12 and earlier send the whole conversation with the finished turn.
  it("ignores a decrypt error from an earlier turn when Paseo sends the whole conversation", async () => {
    const t = await setup({ sameConversation: true });
    await t.endTurn(LIMIT);
    await t.endTurn("done", "completed", [
      { type: "user_message", text: "Repair the build." },
      { type: "assistant_message", text: `[System Error] ${DECRYPT}` },
      { type: "user_message", text: "Carry on." },
      { type: "assistant_message", text: "The parser has been repaired." },
    ]);
    expect(t.reopened).toEqual(["root"]);
    expect(t.created).toEqual([]);
    const state = await t.store.read();
    expect(state.bindings.root?.accountId).toBe("b");
    expect(state.sessions.root?.accountId).toBe("b");
  });

  it("still pins the agent back when this turn's own row reports the decrypt failure", async () => {
    const t = await setup({ sameConversation: true });
    await t.endTurn(LIMIT);
    await t.endTurn("Codex stopped", "failed", [
      { type: "user_message", text: "Repair the build." },
      { type: "assistant_message", text: "The parser has been repaired." },
      { type: "user_message", text: "Carry on." },
      { type: "assistant_message", text: `[System Error] ${DECRYPT}` },
    ]);
    expect(t.reopened).toEqual(["root", "root"]);
    expect(t.created).toHaveLength(1);
    expect((await t.store.read()).bindings.root?.accountId).toBe("a");
  });

  it.each([
    ["on", true, 1, { outcome: "continued", continued: true, detail: "B could not resume this thread." }],
    ["off", false, 0, { outcome: "stayed", continued: false, detail: "New ChatGPT agents will use B." }],
  ])("pins the agent back and hands off as today when the resume fails, with Keep going after a switch %s", async (_name, autoContinue, tabs, row) => {
    const t = await setup({ sameConversation: true, autoContinue });
    await t.endTurn(LIMIT);
    await t.endTurn(DECRYPT);
    expect(t.reopened).toEqual(["root", "root"]);
    expect(t.created).toHaveLength(tabs);
    const state = await t.store.read();
    expect(state.bindings.root).toMatchObject({ accountId: "a", source: "thread" });
    expect(state.sessions.root?.accountId).toBe("a");
    expect(t.notes.at(-1)).toMatchObject(row);
  });
});
