import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem, FamilyAdapter, LimitHit, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import { detectClaudeLimit } from "./limits";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredAccount, type StoredState } from "./state";
import { preferences } from "../shared/preferences";

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";
const AGENT = "agent-1";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-failover-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root; // saved usage lands here, never in the real ~/.paseo
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

function account(id: string, label: string, kind: "main" | "managed") {
  return { id, family: "claude" as const, label, kind, home: kind === "main" ? null : join(tmpdir(), id), createdAt: "2026-09-23T00:00:00.000Z" };
}

/** A Claude adapter whose every failed turn is a session limit resetting at `resetsAt`. */
function claudeAdapter(hit: () => LimitHit): FamilyAdapter {
  const reading = (): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null });
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async () => null,
    usage: async () => reading(),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: (event: { outcome: { kind: string } }) => (event.outcome.kind === "failed" ? hit() : null),
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

/** A row of the agent's timeline as Paseo pages it: the item, and the turn Paseo tagged it with. */
type Row = { item: AgentTimelineItem; turnId?: string };

/** The rows Paseo tags with `turnId` while that turn runs. */
function inTurn(turnId: string, ...items: AgentTimelineItem[]): Row[] {
  return items.map((item) => ({ item, turnId }));
}

/** `recent` is what Paseo hands back when the plugin pages the agent's timeline from its tail, or how it answers. */
function fakePaseo(recent: readonly Row[] | (() => Promise<{ entries: readonly Row[] }>) = []) {
  const sent: string[] = [];
  const notes: Array<{ from: string | null; to: string; outcome: string; detail: string | null }> = [];
  const refetches: Array<{ direction?: string; limit?: number }> = [];
  const agent = { id: AGENT, provider: "claude", status: "idle", archivedAt: null, lastUserMessageAt: "2026-09-23T07:00:00.000Z" };
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({
        refresh: async () => ({ agent }),
        send: async (text: string) => void sent.push(text),
        timeline: {
          append: async (item: { data: { from: string | null; to: string; outcome: string; detail: string | null } }) =>
            void notes.push(item.data),
          refetch: async (options: { direction?: string; limit?: number } = {}) => {
            refetches.push(options);
            return typeof recent === "function" ? recent() : { entries: recent };
          },
        },
      }),
    },
  };
  return { paseo, sent, notes, refetches };
}

interface SetUpOptions {
  /** How `paseo agent reload` ends. */
  reload?: "works" | "fails" | "times out";
  /** Reads turns with a real detector instead of taking every failed turn for a limit. */
  detectLimit?: FamilyAdapter["detectLimit"];
  /** The tail of the agent's timeline as Paseo returns it when asked. */
  recent?: Parameters<typeof fakePaseo>[0];
  /** What every usage reading returns. */
  usage?: () => UsageRead;
}

async function setUp(state: Partial<StoredState>, hit: () => LimitHit, options: SetUpOptions = {}) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => Object.assign(draft, state));
  const reopened: string[] = [];
  const fake = fakePaseo(options.recent);
  const context = { paseo: fake.paseo } as never;
  // Paseo asks for the new session's environment before it closes the old session, so the hook has
  // run by the time `paseo agent reload` returns, even when the reload then failed.
  const reopenedSession = () =>
    service.onSessionOpen({ agentId: AGENT, provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never, context);
  const reopener = {
    locate: async () => "/usr/local/bin/paseo",
    reopen: async (id: string) => {
      reopened.push(id);
      await reopenedSession();
      if (options.reload === "fails") {
        return { ok: false as const, error: "Timed out closing previous session during refresh", timedOut: false };
      }
      if (options.reload === "times out") return { ok: false as const, error: "Command failed: paseo agent reload", timedOut: true };
      return { ok: true as const };
    },
  };
  const families = { resolve: async () => ({ claude: "claude" as const }) };
  const claude = {
    ...claudeAdapter(hit),
    ...(options.detectLimit ? { detectLimit: options.detectLimit } : {}),
    ...(options.usage ? { usage: async () => options.usage!() } : {}),
  };
  const service = new Service(
    { claude, codex: claudeAdapter(hit) },
    store,
    families as unknown as FamilyResolver,
    reopener as unknown as Reopener,
  );
  const limitTurn = () =>
    service.onTurnEnded(
      { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
      context,
    );
  return { service, store, reopened, limitTurn, ...fake };
}

const inFuture = () => new Date(Date.now() + 30 * 60_000).toISOString();
const inPast = () => new Date(Date.now() - 60_000).toISOString();

describe("failover", () => {
  it("blames the CLI login for a session ZeroSub never routed, even when the agent is bound elsewhere", async () => {
    // Today's incident: the agent's session predates zerosub, and a switch to "hello" was waiting.
    const { store, reopened, sent, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: new Date().toISOString() } },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" }),
    );
    await limitTurn();
    const state = await store.read();
    expect(state.accounts.find((a) => a.id === MAIN)?.limitedUntil).not.toBeNull();
    expect(state.accounts.find((a) => a.id === HELLO)?.limitedUntil).toBeNull();
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
    expect(sent).toHaveLength(1);
  });

  it("moves on again when the next account runs out too", async () => {
    let resetsAt = inPast(); // marketing's window has already reset when hello runs out
    const { store, reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt, message: "You've hit your session limit" }),
    );
    await limitTurn(); // marketing → hello
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
    resetsAt = inFuture();
    await limitTurn(); // hello runs out → back to marketing
    expect(reopened).toHaveLength(2);
    expect(notes.at(-1)).toMatchObject({ from: "hello", to: "marketing", outcome: "switched" });
  });

  it("explains in the timeline when it stops switching an agent that keeps bouncing", async () => {
    const { reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt: inPast(), message: "You've hit your session limit" }),
    );
    for (let turn = 0; turn < 5; turn += 1) await limitTurn();
    expect(reopened).toHaveLength(4);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
    expect(notes.at(-1)?.detail).toMatch(/stopped switching it for now/);
  });

  it("doesn't blame the new account for the old one's limit when a message fails before its turn starts", async () => {
    // A real incident: marketing's weekly limit moved the agent to hello, then a message hit a closed
    // session. Paseo never started that turn, so the timeline still ended with marketing's notice.
    const notice = "You've hit your weekly limit · resets Sep 25 at 3:30pm (Asia/Calcutta)";
    const { service, store, reopened, notes, paseo } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: {},
      },
      () => {
        throw new Error("unused: the real detector reads the turns");
      },
      { detectLimit: detectClaudeLimit },
    );
    const context = { paseo } as never;
    const agent = { id: AGENT, provider: "claude" };
    const earlier: AgentTimelineItem[] = [
      { type: "user_message", text: "fix the bug" },
      { type: "assistant_message", text: notice },
    ];
    await service.onTurnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: earlier } as never, context);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);

    const closed = "Claude session is closed";
    await service.onTurnEnded(
      {
        agent,
        turnId: null,
        outcome: { kind: "failed", error: { message: closed } },
        timeline: [...earlier, { type: "assistant_message", text: `[System Error] ${closed}` }],
      } as never,
      context,
    );
    expect((await store.read()).accounts.find((a) => a.id === HELLO)?.limitedUntil).toBeNull();
    expect(reopened).toHaveLength(1);
    expect(notes).toHaveLength(1);
  });

  // Paseo 0.13 (getpaseo/paseo#7477) stopped copying the conversation into turn-ended hooks: `timeline`
  // is always `[]`. Claude reports its limits as an ordinary reply, so the plugin has to page the
  // tail of the timeline itself or it never sees them again.
  describe("when the hook arrives without the turn's timeline", () => {
    const notice = "You've hit your session limit · resets 3pm (UTC)";
    const twoAccounts = () => ({
      accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
      defaults: { claude: MAIN, codex: null },
      sessions: {},
    });
    const unused = () => {
      throw new Error("unused: the real detector reads the turns");
    };
    const agent = { id: AGENT, provider: "claude" };

    it("reads the finished turn from Paseo and still switches on a limit", async () => {
      const recent = inTurn("t1", { type: "user_message", text: "fix the bug" }, { type: "assistant_message", text: notice });
      const { service, store, reopened, notes, refetches, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      await service.onTurnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: [] } as never, { paseo } as never);
      expect(refetches).toHaveLength(1);
      expect(refetches[0]).toMatchObject({ direction: "tail" });
      expect(refetches[0]?.limit).toBeGreaterThan(0);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
      expect(reopened).toEqual([AGENT]);
      expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
    });

    it("trusts a timeline the hook did send instead of reading it again", async () => {
      // Paseo 0.12 still sends the turn; a second read would see older rows and could blame the account twice.
      const recent = inTurn("t1", { type: "assistant_message", text: notice });
      const { service, store, refetches, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      const sent: AgentTimelineItem[] = [
        { type: "user_message", text: "fix the bug" },
        { type: "assistant_message", text: "Done, all tests pass." },
      ];
      await service.onTurnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: sent } as never, { paseo } as never);
      expect(refetches).toHaveLength(0);
      expect((await store.read()).sessions[AGENT]?.accountId ?? MAIN).toBe(MAIN);
    });

    it("leaves Paseo alone for turns that never started, have no id, or were canceled", async () => {
      const recent = inTurn("t2", { type: "assistant_message", text: notice });
      const { service, store, refetches, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      const context = { paseo } as never;
      await service.onTurnEnded({ agent, turnId: null, outcome: { kind: "failed", error: { message: "Claude session is closed" } }, timeline: [] } as never, context);
      // Without an id there's nothing to tell this turn's rows by: untagged rows include replayed history.
      await service.onTurnEnded({ agent, outcome: { kind: "completed" }, timeline: [] } as never, context);
      await service.onTurnEnded({ agent, turnId: "t2", outcome: { kind: "canceled" }, timeline: [] } as never, context);
      expect(refetches).toHaveLength(0);
      expect((await store.read()).sessions[AGENT]?.accountId ?? MAIN).toBe(MAIN);
    });

    it("doesn't read an earlier turn's limit again", async () => {
      // The page reaches back into the turn that hit the limit. A turn Claude Code starts by itself,
      // such as after a background task finishes, has no message to stop at, so only the turn ids
      // keep the old notice (a reply, or Paseo's untagged error row) from moving the agent again.
      const endings: Row[][] = [
        inTurn("t1", { type: "assistant_message", text: notice }),
        [{ item: { type: "assistant_message", text: `[System Error] ${notice}` } }],
      ];
      for (const ending of endings) {
        const recent = [
          ...inTurn("t1", { type: "user_message", text: "fix the bug" }),
          ...ending,
          ...inTurn("t2", { type: "assistant_message", text: "The background build finished." }),
        ];
        const { service, store, reopened, notes, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
        await service.onTurnEnded({ agent, turnId: "t2", outcome: { kind: "completed" }, timeline: [] } as never, { paseo } as never);
        expect((await store.read()).accounts.find((a) => a.id === MAIN)?.limitedUntil).toBeNull();
        expect(reopened).toEqual([]);
        expect(notes).toEqual([]);
      }
    });

    it("doesn't take an earlier turn with the same id for this one", async () => {
      // Providers count turns per session, and some session restarts keep the timeline (a voice-mode
      // toggle does), so an earlier turn can carry this turn's id. The prompt between them ends the turn.
      const recent = [
        ...inTurn("autonomous-turn-2", { type: "assistant_message", text: notice }),
        ...inTurn("foreground-turn-1", { type: "user_message", text: "continue" }, { type: "assistant_message", text: "Restarted the build." }),
        ...inTurn("autonomous-turn-2", { type: "assistant_message", text: "The build finished." }),
      ];
      const { service, store, reopened, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      const turn = { agent, turnId: "autonomous-turn-2", outcome: { kind: "completed" }, timeline: [] };
      await service.onTurnEnded(turn as never, { paseo } as never);
      expect((await store.read()).accounts.find((a) => a.id === MAIN)?.limitedUntil).toBeNull();
      expect(reopened).toEqual([]);
    });

    it("still finds the limit when the next turn starts before the page is read", async () => {
      // Another plugin's follow-up, or a queued message, can start the next turn while the hook is on its way.
      const recent = [
        ...inTurn("t1", { type: "user_message", text: "fix the bug" }, { type: "assistant_message", text: notice }),
        ...inTurn("t2", { type: "user_message", text: "Try again." }),
      ];
      const { service, store, reopened, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      await service.onTurnEnded({ agent, turnId: "t1", outcome: { kind: "completed" }, timeline: [] } as never, { paseo } as never);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
      expect(reopened).toEqual([AGENT]);
    });

    it("goes on with the turn's own failure when the page can't be read", async () => {
      const failed = { kind: "failed", error: { message: notice } };
      const recent = () => Promise.reject(new Error("The daemon went away"));
      const { service, store, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
      await service.onTurnEnded({ agent, turnId: "t1", outcome: failed, timeline: [] } as never, { paseo } as never);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
    });

    it("doesn't wait for a page that never comes", async () => {
      // The SDK would wait 60 s for an answer, holding up the switch and anything else waiting for the turn to end.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        let asked = () => {};
        const reading = new Promise<void>((resolve) => (asked = resolve));
        const recent = () => {
          asked();
          return new Promise<never>(() => {});
        };
        const failed = { kind: "failed", error: { message: notice } };
        const { service, store, paseo } = await setUp(twoAccounts(), unused, { detectLimit: detectClaudeLimit, recent });
        const ended = service.onTurnEnded({ agent, turnId: "t1", outcome: failed, timeline: [] } as never, { paseo } as never);
        await Promise.race([reading, ended]); // the page is asked for, or the turn needed none
        await vi.advanceTimersByTimeAsync(10_000);
        await ended;
        expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("keeps an agent's session where it was when Paseo can't reload it", async () => {
    const openedAt = "2026-09-23T07:00:00.000Z";
    const { store, reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your weekly limit" }),
      { reload: "fails" },
    );
    await limitTurn();
    const state = await store.read();
    expect(reopened).toEqual([AGENT]);
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO); // where it goes when its session next opens
    expect(state.sessions[AGENT]).toEqual({ accountId: MAIN, family: "claude", openedAt });
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "pending" });
  });

  it("keeps the new session when the reload only ran out of time", async () => {
    // The daemon may still finish a reload that the command-line tool stopped waiting for.
    const { store, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt: "2026-09-23T07:00:00.000Z" } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your weekly limit" }),
      { reload: "times out" },
    );
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });
});

describe("forking to the other provider", () => {
  const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
  const MODES: Record<string, Array<{ id: string; label: string; colorTier: string }>> = {
    claude: [
      { id: "plan", label: "Plan Mode", colorTier: "planning" },
      { id: "default", label: "Always Ask", colorTier: "safe" },
      { id: "acceptEdits", label: "Accept File Edits", colorTier: "moderate" },
      { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
    ],
    codex: [
      { id: "auto", label: "Default Permissions", colorTier: "moderate" },
      { id: "full-access", label: "Full Access", colorTier: "dangerous" },
    ],
  };

  /** `conversation` is the agent's timeline, which Paseo pages from its tail. */
  async function setUpFork(modeId: string, conversation: readonly Row[] = []) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) =>
      Object.assign(draft, {
        accounts: [account(MAIN, "marketing", "main"), { ...account(CODEX_MAIN, "hello", "main"), family: "codex" }],
        defaults: { claude: MAIN, codex: CODEX_MAIN },
      }),
    );
    const source = {
      id: AGENT,
      provider: "claude",
      status: "idle",
      title: "Fix the build",
      model: "claude-opus-5-5",
      currentModeId: modeId,
      workspaceId: "ws-1",
      archivedAt: null,
      lastUserMessageAt: "2026-09-23T07:00:00.000Z",
      labels: {},
    };
    const agents: Array<Record<string, unknown>> = [source];
    const created: Array<{ agentId: string; config: { provider: string; modeId?: string }; title: string; prompt: string; labels: Record<string, string> }> = [];
    const notes: Array<{ to: string; outcome: string; toFamily: string | null; detail: string | null; continuedIn: { agentId: string } | null }> = [];
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      providers: {
        listAvailable: async () => ({ providers: [{ provider: "claude", available: true }, { provider: "codex", available: true }] }),
        listModes: async (provider: string) => ({ modes: MODES[provider] }),
        listModels: async (provider: string) => ({ models: [{ id: provider === "codex" ? "gpt-5.6-sol" : "claude-opus-5-5", isDefault: true }] }),
      },
      workspaces: {
        ref: () => ({
          agents: {
            create: async (request: (typeof created)[number]) => {
              created.push(request);
              agents.push({ id: request.agentId, provider: "codex", status: "running", title: request.title, archivedAt: null, labels: request.labels });
            },
          },
        }),
      },
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
        ref: () => ({
          refresh: async () => ({ agent: source }),
          send: async () => undefined,
          timeline: {
            append: async (item: { data: (typeof notes)[number] }) => void notes.push(item.data),
            refetch: async ({ limit = 0 }: { limit?: number } = {}) => ({ entries: limit > 0 ? conversation.slice(-limit) : conversation }),
          },
        }),
      },
    };
    const service = new Service(
      {
        claude: claudeAdapter(() => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" })),
        codex: { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), family: "codex", portable: false } as FamilyAdapter,
      },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo", reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    );
    service.setPreferences(preferences.schema.parse({ forkOtherProvider: true }));
    const context = { paseo } as never;
    const limitTurn = () =>
      service.onTurnEnded(
        { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
        context,
      );
    return { store, created, notes, limitTurn };
  }

  it("carries the work on with the other provider, at the same permission level", async () => {
    const { store, created, notes, limitTurn } = await setUpFork("bypassPermissions");
    await limitTurn();
    expect(created).toHaveLength(1);
    const fork = created[0];
    expect(fork?.config).toEqual({ provider: "codex/gpt-5.6-sol", modeId: "full-access" });
    expect(fork?.title).toBe("Fix the build (continued on ChatGPT)");
    expect(fork?.labels).toEqual({ "zerosub.continued-from": AGENT });
    expect(fork?.prompt).toMatch(/earlier Claude Code session that stopped because every Claude account reached its usage limit/);
    expect((await store.read()).bindings[fork?.agentId ?? ""]).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", toFamily: "codex", to: "hello", continuedIn: { agentId: fork?.agentId } });
  });

  it("points at the earlier fork instead of starting another", async () => {
    const { created, notes, limitTurn } = await setUpFork("bypassPermissions");
    await limitTurn();
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", continuedIn: { agentId: created[0]?.agentId } });
  });

  it("won't fork into a mode more permissive than the original's", async () => {
    const { created, notes, limitTurn } = await setUpFork("default");
    await limitTurn();
    expect(created).toHaveLength(0);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
    expect(notes.at(-1)?.detail).toMatch(/no mode as careful as this agent's \(“Always Ask”\)/);
  });

  it("hands the fork the whole conversation when the hook sends none", async () => {
    // Paseo 0.13 sends turn-ended hooks no timeline. The fork pages the conversation itself instead
    // of taking the rows the limit was read from, so it still gets the request from 48 rows back.
    const steps = Array.from({ length: 45 }, (_, step): AgentTimelineItem => ({ type: "assistant_message", text: `Step ${step + 1} done.` }));
    const conversation = [
      ...inTurn("t0", { type: "user_message", text: "Fix the build" }, ...steps),
      ...inTurn("t", { type: "user_message", text: "Now run the linter" }, { type: "assistant_message", text: "You've hit your session limit · resets 3pm (UTC)" }),
    ];
    const { created, limitTurn } = await setUpFork("bypassPermissions", conversation);
    await limitTurn();
    const prompt = created[0]?.prompt ?? "";
    expect(prompt.match(/User: Fix the build/g) ?? []).toHaveLength(1);
    expect(prompt).toContain("Step 45 done.");
    expect(prompt).toContain("User: Now run the linter");
  });
});

describe("disabling an account", () => {
  it("moves its agents off and back, and won't disable the last usable account", async () => {
    const { service, store, reopened } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: new Date().toISOString() } },
        sessions: { [AGENT]: { accountId: HELLO, family: "claude", openedAt: new Date().toISOString() } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "" }),
    );
    const paseo = fakePaseo().paseo as never;

    const off = await service.setAccountEnabled(paseo, HELLO, false);
    expect(off.reopened).toEqual([AGENT]);
    let state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(MAIN);
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO); // kept for when it's enabled again

    await expect(service.setAccountEnabled(paseo, MAIN, false)).rejects.toThrow(/only Claude account in use/);

    const on = await service.setAccountEnabled(paseo, HELLO, true);
    expect(on.reopened).toEqual([AGENT]);
    state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toHaveLength(2);
  });
});

describe("usage readings", () => {
  const CREDITS = { balance: 57714.93, unlimited: false };
  const USE_CREDITS = preferences.schema.parse({ useCredits: true });
  const NEW_AGENT = "agent-new";
  const full = (credits: UsageRead["credits"]) => (): UsageRead => ({
    fetchedAt: new Date().toISOString(),
    windows: [{ id: "primary", label: "Weekly", usedPercent: 100, resetsAt: inFuture() }],
    error: null,
    cached: false,
    resets: null,
    credits,
  });
  const state = (limit: Partial<StoredAccount> = {}) => ({
    accounts: [{ ...account(MAIN, "marketing", "main"), ...limit }, account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null },
  });
  const limitedUntil = async (store: StateStore) => (await store.read()).accounts.find((a) => a.id === MAIN)?.limitedUntil ?? null;
  const unused = () => ({ kind: "window" as const, resetsAt: inFuture(), message: "" });
  /** Dates the account's limit an hour back, so usage readings may second-guess it. */
  const settle = (store: StateStore) =>
    store.update((draft) => {
      const main = draft.accounts.find((a) => a.id === MAIN);
      if (main) main.limitedAt = new Date(Date.now() - 60 * 60_000).toISOString();
    });
  /** The account a brand-new agent's session opens on. */
  const newAgentOpensOn = async (service: Service, store: StateStore, paseo: unknown) => {
    await service.onSessionOpen(
      { agentId: NEW_AGENT, provider: "claude", reason: "create", purpose: "interactive", env: {} } as never,
      { paseo } as never,
    );
    return (await store.read()).sessions[NEW_AGENT]?.accountId;
  };

  it("takes a full window without credits for a limit, whatever the setting", async () => {
    for (const prefs of [preferences.schema.parse({}), USE_CREDITS]) {
      const { service, store } = await setUp(state(), unused, { usage: full(null) });
      service.setPreferences(prefs);
      await service.refreshUsage(MAIN, true);
      expect(await limitedUntil(store)).not.toBeNull();
    }
  });

  it("still takes a full window for a limit while credits are left, so new agents start elsewhere", async () => {
    const { service, store, paseo } = await setUp(state(), unused, { usage: full(CREDITS) });
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).not.toBeNull();
    expect(await newAgentOpensOn(service, store, paseo)).toBe(HELLO);
  });

  it("keeps an account going on its credits when told to use them", async () => {
    const { service, store, paseo } = await setUp(state(), unused, { usage: full(CREDITS) });
    service.setPreferences(USE_CREDITS);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).toBeNull();
    expect(await newAgentOpensOn(service, store, paseo)).toBe(MAIN);
  });

  it("clears a limit a reading found once told to use the credits", async () => {
    const { service, store } = await setUp(state(), unused, { usage: full({ balance: null, unlimited: true }) });
    await service.refreshUsage(MAIN, true);
    await settle(store);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).not.toBeNull(); // not while the setting is off

    service.setPreferences(USE_CREDITS);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).toBeNull();
  });

  it("leaves a limit a turn ran into until it resets, credits or not", async () => {
    // The provider stopped the turn, so the credits didn't cover it: clearing the limit would only send new agents back.
    const { service, store, limitTurn } = await setUp(
      state(),
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your usage limit" }),
      { usage: full(CREDITS) },
    );
    service.setPreferences(USE_CREDITS);
    await limitTurn();
    await settle(store);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).not.toBeNull();
  });

  it("takes a limit saved without its source for a turn's", async () => {
    const { service, store } = await setUp(state({ limitedUntil: inFuture(), limitKind: "window" }), unused, { usage: full(CREDITS) });
    service.setPreferences(USE_CREDITS);
    await settle(store);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).not.toBeNull();
  });

  it("stores a reading that leaves credits out as having none", async () => {
    const { service, paseo } = await setUp(state(), unused);
    await service.refreshUsage(MAIN, true);
    const shown = (await service.view(paseo as never)).accounts.find((a) => a.id === MAIN);
    expect(shown?.usage?.credits).toBeNull();
  });
});

describe("changing the default account", () => {
  const openedAt = "2026-09-23T07:00:00.000Z";
  const stateWithLiveAgent = () => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null },
    bindings: {},
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });

  it("moves agents that follow the default", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({
      kind: "window",
      resetsAt: inFuture(),
      message: "",
    }));
    const paseo = fakePaseo().paseo as never;

    const summary = await service.setDefault(paseo, HELLO);
    expect(summary.reopened).toEqual([AGENT]);
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).defaults.claude).toBe(HELLO);
  });

  it("leaves running agents where they are when that preference is off", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({
      kind: "window",
      resetsAt: inFuture(),
      message: "",
    }));
    service.setPreferences(preferences.schema.parse({ moveAgentsOnDefaultChange: false }));
    const paseo = fakePaseo().paseo as never;

    const summary = await service.setDefault(paseo, HELLO);
    expect(summary.reopened).toEqual([]);
    expect(reopened).toEqual([]);
    const state = await store.read();
    expect(state.defaults.claude).toBe(HELLO); // the default still changed, for new agents
    expect(state.sessions[AGENT]?.accountId).toBe(MAIN);
    // Pinned where it runs, so resuming it later doesn't drift to the new default either.
    expect(state.bindings[AGENT]).toMatchObject({ accountId: MAIN });
  });

  const WORK = "claude-work";
  const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
  const KEEP = preferences.schema.parse({ moveAgentsOnDefaultChange: false });
  const NOTHING_MOVED = { reopened: [], deferred: [], failed: [], continuedIn: null };
  const session = (accountId: string) => ({ accountId, family: "claude" as const, openedAt });

  /** Several agents, each answering for itself. `reopened` lists the ones Paseo was asked to reload. */
  async function setUpAgents(
    state: Partial<StoredState>,
    listed: Array<{ id: string; status: string; provider?: string; archived?: boolean }>,
    options: { claude?: Partial<FamilyAdapter>; onList?: (service: Service, context: never) => void } = {},
  ) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) => Object.assign(draft, state));
    const agents = listed.map(({ id, status, provider, archived }) => ({
      id,
      provider: provider ?? "claude",
      status,
      archivedAt: archived ? "2026-09-23T08:00:00.000Z" : null,
      lastUserMessageAt: openedAt,
    }));
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      agents: {
        list: async () => {
          options.onList?.(service, context);
          return { entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } };
        },
        ref: (id: string) => ({
          refresh: async () => ({ agent: agents.find((agent) => agent.id === id) }),
          send: async () => undefined,
          timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
        }),
      },
    };
    const context = { paseo } as never;
    const reopened: string[] = [];
    const hit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" });
    const service: Service = new Service(
      { claude: { ...claudeAdapter(hit), ...options.claude }, codex: { ...claudeAdapter(hit), family: "codex", portable: false } as FamilyAdapter },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      {
        locate: async () => "/usr/local/bin/paseo",
        reopen: async (id: string) => {
          reopened.push(id);
          const provider = agents.find((agent) => agent.id === id)?.provider;
          await service.onSessionOpen({ agentId: id, provider, reason: "refresh", purpose: "interactive", env: {} } as never, context);
          return { ok: true as const };
        },
      } as unknown as Reopener,
    );
    service.setPreferences(KEEP);
    return { service, store, paseo: paseo as never, context, reopened };
  }

  it("keeps each open agent that follows the default on the account it runs on, and nothing else", async () => {
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null },
        bindings: { chosen: { accountId: MAIN, source: "user", at: openedAt } },
        sessions: {
          idle: session(WORK),
          busy: session(WORK),
          chosen: session(MAIN),
          closed: session(WORK),
          there: session(HELLO),
        },
      },
      [
        { id: "idle", status: "idle" },
        { id: "busy", status: "running" },
        { id: "unrouted", status: "idle" }, // opened before ZeroSub routed anything, so on the CLI login
        { id: "chosen", status: "idle" },
        { id: "closed", status: "closed" },
        { id: "there", status: "idle" }, // already on the new default
        { id: "chatgpt", status: "idle", provider: "codex" }, // a Claude default isn't its concern
      ],
    );

    expect(await service.setDefault(paseo, HELLO)).toEqual(NOTHING_MOVED);
    expect(reopened).toEqual([]);
    const state = await store.read();
    expect(state.defaults.claude).toBe(HELLO);
    const { bindings } = state;
    expect(bindings.idle).toMatchObject({ accountId: WORK, source: "auto" });
    expect(bindings.busy).toMatchObject({ accountId: WORK, source: "auto" });
    expect(bindings.unrouted).toMatchObject({ accountId: MAIN, source: "auto" });
    expect(bindings.chosen).toMatchObject({ accountId: MAIN, source: "user" });
    expect(bindings.closed).toBeUndefined();
    expect(bindings.there).toBeUndefined();
    expect(bindings.chatgpt).toBeUndefined();

    // Kept agents read as pinned, so their account button offers "Follow default"; the rest follow it.
    const routes = new Map((await service.view(paseo)).agents.map((route) => [route.agentId, route]));
    expect(routes.get("idle")).toMatchObject({ accountId: WORK, pinned: true, pendingAccountId: null });
    expect(routes.get("closed")).toMatchObject({ accountId: HELLO, pinned: false });
    expect(routes.get("there")).toMatchObject({ accountId: HELLO, pinned: false });
  });

  it("moves an agent whose account it can't stay on, as it would with the switch on", async () => {
    const cases: Array<[string, Partial<StoredAccount> | null]> = [
      ["at its limit", { limitedUntil: inFuture(), limitKind: "window" }],
      ["signed out", { signedIn: false }],
      ["disabled", { disabled: true }],
      ["removed", null],
    ];
    for (const [why, work] of cases) {
      const { service, store, paseo, reopened } = await setUpAgents(
        {
          accounts: [
            account(MAIN, "marketing", "main"),
            ...(work ? [{ ...account(WORK, "work", "managed"), ...work }] : []),
            account(HELLO, "hello", "managed"),
          ] as never,
          defaults: { claude: MAIN, codex: null },
          bindings: {},
          sessions: { stuck: session(WORK), fine: session(MAIN) },
        },
        [
          { id: "stuck", status: "idle" },
          { id: "fine", status: "idle" },
        ],
      );
      // Without automatic switching, changing the default is how a stuck agent gets out.
      service.setPreferences({ ...KEEP, autoSwitch: false });
      expect(await service.setDefault(paseo, HELLO), why).toEqual({ ...NOTHING_MOVED, reopened: ["stuck"] });
      expect(reopened, why).toEqual(["stuck"]);
      const state = await store.read();
      expect(state.sessions.stuck?.accountId, why).toBe(HELLO);
      expect(state.bindings.stuck, why).toBeUndefined();
      expect(state.bindings.fine, why).toMatchObject({ accountId: MAIN, source: "auto" });
    }
  });

  it("changes nothing when the account is already the default", async () => {
    const accounts = [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never;
    const agents = [
      { id: "idle", status: "idle" },
      { id: "busy", status: "running" },
    ];
    for (const prefs of [KEEP, preferences.schema.parse({})]) {
      const { service, store, paseo, reopened } = await setUpAgents(
        { accounts, defaults: { claude: WORK, codex: null }, bindings: {}, sessions: { idle: session(WORK), busy: session(WORK) } },
        agents,
      );
      service.setPreferences(prefs);
      expect(await service.setDefault(paseo, WORK)).toEqual(NOTHING_MOVED);
      expect((await store.read()).bindings).toEqual({});
      expect(reopened).toEqual([]);
    }

    // Until another account is chosen, the CLI login is the default.
    const { service, store, paseo, reopened } = await setUpAgents(
      { accounts, defaults: { claude: null, codex: null }, bindings: {}, sessions: { idle: session(MAIN), busy: session(MAIN) } },
      agents,
    );
    expect(await service.setDefault(paseo, MAIN)).toEqual(NOTHING_MOVED);
    const state = await store.read();
    expect(state.defaults.claude).toBe(MAIN);
    expect(state.bindings).toEqual({});
    expect(reopened).toEqual([]);
  });

  it("keeps an agent whose session is still being routed on the account it opens on", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let preparing = false;
    const { service, store, paseo, context, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null },
      },
      [{ id: "starting", status: "initializing" }],
      {
        claude: {
          prepareHome: async () => {
            if (preparing) return;
            preparing = true;
            await gate;
          },
        },
      },
    );
    // Routed by the old default, but it hasn't recorded where it opens yet.
    const opening = service.onSessionOpen(
      { agentId: "starting", provider: "claude", reason: "create", purpose: "interactive", env: {} } as never,
      context,
    );
    await vi.waitFor(() => expect(preparing).toBe(true));
    // A history session opened for the same agent meanwhile mustn't hide the one still being routed.
    await service.onSessionOpen({ agentId: "starting", provider: "claude", reason: "resume", purpose: "history", env: {} } as never, context);
    const changing = service.setDefault(paseo, HELLO);
    await vi.waitFor(async () => expect((await store.read()).defaults.claude).toBe(HELLO));
    release();
    const [summary, opened] = await Promise.all([changing, opening]);

    expect(opened?.env).toMatchObject({ CLAUDE_CONFIG_DIR: join(tmpdir(), WORK) });
    const state = await store.read();
    expect(state.sessions.starting?.accountId).toBe(WORK);
    expect(state.bindings.starting).toMatchObject({ accountId: WORK, source: "auto" });
    expect(summary.reopened).toEqual([]);
    expect(reopened).toEqual([]);
  });

  it("leaves agents that are only starting now to the new default", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reloading: Promise<unknown> | undefined;
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null },
        bindings: {},
        sessions: { reloading: session(WORK) },
      },
      [
        { id: "fresh", status: "initializing" }, // listed before Paseo asked ZeroSub where to open it
        { id: "reloading", status: "idle" },
      ],
      {
        claude: { prepareHome: () => gate },
        // Paseo reloads this one after the default changed, while the open agents are being listed.
        onList: (service, context) => {
          reloading ??= service.onSessionOpen(
            { agentId: "reloading", provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never,
            context,
          );
        },
      },
    );
    expect(await service.setDefault(paseo, HELLO)).toEqual(NOTHING_MOVED);
    release();
    await reloading;
    const state = await store.read();
    expect(state.sessions.reloading?.accountId).toBe(HELLO);
    expect(state.bindings.reloading).toBeUndefined();
    expect(state.bindings.fresh).toBeUndefined();
    expect(reopened).toEqual([]);
  });

  it("keeps open agents on the CLI login when the first default is chosen", async () => {
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: null, codex: null },
        sessions: { routed: session(MAIN) },
      },
      [
        { id: "routed", status: "idle" },
        { id: "unrouted", status: "running" },
      ],
    );
    await service.setDefault(paseo, HELLO);
    const state = await store.read();
    expect(state.defaults.claude).toBe(HELLO);
    expect(state.bindings.routed).toMatchObject({ accountId: MAIN, source: "auto" });
    expect(state.bindings.unrouted).toMatchObject({ accountId: MAIN, source: "auto" });
    expect(reopened).toEqual([]);
  });

  it("still moves a kept agent when its account hits a limit", async () => {
    const { service, store, reopened, notes, limitTurn } = await setUp(stateWithLiveAgent(), () => ({
      kind: "window",
      resetsAt: inFuture(),
      message: "You've hit your session limit",
    }));
    service.setPreferences(KEEP);
    await service.setDefault(fakePaseo().paseo as never, HELLO);
    expect((await store.read()).bindings[AGENT]).toMatchObject({ accountId: MAIN, source: "auto" });

    await limitTurn();
    const state = await store.read();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: HELLO, source: "auto" });
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
  });

  it("moves a kept agent to the new default when asked to follow it", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({ kind: "window", resetsAt: inFuture(), message: "" }));
    service.setPreferences(KEEP);
    const paseo = fakePaseo().paseo as never;
    await service.setDefault(paseo, HELLO);
    expect(reopened).toEqual([]);

    await service.setAgentAccount(paseo, AGENT, null); // "Follow default" and `/account default`
    const state = await store.read();
    expect(state.bindings[AGENT]).toBeUndefined();
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
  });

  it("pins ChatGPT threads as before, since they can't move either way", async () => {
    const codex = (id: string, label: string, kind: "main" | "managed") => ({ ...account(id, label, kind), family: "codex" });
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [codex(CODEX_MAIN, "chatgpt", "main"), codex("codex-work", "work", "managed")] as never,
        defaults: { claude: null, codex: CODEX_MAIN },
        sessions: { thread: { accountId: CODEX_MAIN, family: "codex", openedAt } },
      },
      [
        { id: "thread", status: "idle", provider: "codex" },
        { id: "archived", status: "closed", provider: "codex", archived: true },
      ],
    );
    await service.setDefault(paseo, "codex-work");
    const { bindings } = await store.read();
    expect(bindings.thread).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(bindings.archived).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(reopened).toEqual([]);
  });
});

describe("a reading past its reset", () => {
  it("renews the sign-in, so an idle account that sat full is read again once it resets", async () => {
    const NOW = Date.parse("2026-10-24T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      const store = new StateStore(join(root, "state.json"));
      await store.update((draft) => Object.assign(draft, { accounts: [account(MAIN, "main", "main")], defaults: { claude: MAIN, codex: null } }));
      const windows = (weekly: number) => [{ id: "seven_day", label: "Weekly", usedPercent: weekly, resetsAt: new Date(NOW + 72 * 3_600_000).toISOString() }];
      // Like Claude with an expired sign-in: nothing is read unless the CLI renews it first.
      const renewals: boolean[] = [];
      let signedIn = true;
      const usage = async (_home: string | null, options: { renewLogin?: boolean } = {}): Promise<UsageRead> => {
        renewals.push(Boolean(options.renewLogin));
        const fetchedAt = new Date().toISOString();
        if (!signedIn && !options.renewLogin) return { fetchedAt, windows: [], error: "Usage shows up after this account is next used.", cached: false, resets: null };
        return { fetchedAt, windows: windows(signedIn ? 100 : 0), error: null, cached: false, resets: null };
      };
      const claude = { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), usage };
      const service = new Service(
        { claude, codex: { ...claude, family: "codex", portable: false } as FamilyAdapter },
        store,
        { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
        { locate: async () => "/usr/local/bin/paseo" } as unknown as Reopener,
      );
      service.setPreferences(preferences.schema.parse({}));
      await service.refreshUsage(MAIN, true);
      signedIn = false;
      vi.setSystemTime(NOW + 3_600_000);
      await service.refreshUsage(MAIN, true);
      vi.setSystemTime(NOW + 73 * 3_600_000);
      await service.refreshUsage(MAIN, true);
      expect(renewals).toEqual([false, false, true]);
      // The renewed reading replaces the stale one, so the card and Up next see the reset.
      const shown = (await service.view(fakePaseo().paseo as never)).accounts.find((entry) => entry.id === MAIN)?.usage;
      expect(shown?.error).toBeNull();
      expect(shown?.windows.map((window) => window.usedPercent)).toEqual([0]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("renewing an expired sign-in in the background", () => {
  const NOW = Date.parse("2026-10-24T12:00:00Z");
  const MINUTE = 60_000;
  const minutesIn = () => (Date.now() - NOW) / MINUTE;
  const fiveHour = (usedPercent: number, resetsAt: number) => ({ id: "five_hour", label: "5-hour", usedPercent, resetsAt: new Date(resetsAt).toISOString() });

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** A service whose one account is the Claude CLI login, read through `usage`. */
  async function setUpAccount(usage: FamilyAdapter["usage"], patch: Partial<StoredAccount> = {}) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) =>
      Object.assign(draft, { accounts: [{ ...account(MAIN, "main", "main"), ...patch }], defaults: { claude: MAIN, codex: null } }),
    );
    const claude = { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), usage };
    const service = new Service(
      { claude, codex: { ...claude, family: "codex", portable: false } as FamilyAdapter },
      store,
      { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo" } as unknown as Reopener,
    );
    service.setPreferences(preferences.schema.parse({}));
    return { service, store };
  }

  /**
   * An account read full two hours before NOW, in a 5-hour window that reset an hour before NOW.
   * Its sign-in has expired since, and renewing it never works (revoked, offline, or `claude`
   * missing), so the reading stays past its reset. `reads` and `asked` are the minutes after NOW at
   * which it was read, and at which a read asked to renew it.
   */
  async function setUpPastReset(patch: Partial<StoredAccount> = {}) {
    let expired = false;
    const reads: number[] = [];
    const asked: number[] = [];
    const { service, store } = await setUpAccount(async (_home, options = {}) => {
      const fetchedAt = new Date().toISOString();
      if (!expired) return { fetchedAt, windows: [fiveHour(100, NOW - 60 * MINUTE)], error: null, cached: false, resets: null };
      reads.push(minutesIn());
      if (options.renewLogin) asked.push(minutesIn());
      return { fetchedAt, windows: [], error: "Usage shows up after this account is next used.", cached: false, resets: null };
    }, patch);
    vi.setSystemTime(NOW - 120 * MINUTE);
    await service.refreshUsage(MAIN);
    expired = true;
    return { service, store, reads, asked };
  }

  /** A read nobody asked to renew the sign-in for, like the upkeep tick's, `minute` minutes after NOW. */
  async function readAt(service: Service, minute: number) {
    vi.setSystemTime(NOW + minute * MINUTE);
    await service.refreshUsage(MAIN);
  }

  it("asks to renew at most every 30 minutes when renewing never works", async () => {
    const { service, reads, asked } = await setUpPastReset();
    // The default account is read every 5 minutes.
    const minutes = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60];
    for (const minute of minutes) await readAt(service, minute);
    expect(reads).toEqual(minutes);
    expect(asked).toEqual([0, 30, 60]);
  });

  it("doesn't renew a disabled account's sign-in", async () => {
    const { service, store, asked } = await setUpPastReset({ disabled: true });
    for (const minute of [0, 20, 40, 60]) await readAt(service, minute);
    expect(asked).toEqual([]);
    // Enabled again, the next read renews it.
    await store.update((draft) => {
      draft.accounts[0]!.disabled = false;
    });
    await readAt(service, 65);
    expect(asked).toEqual([65]);
  });

  it("renews a window-limited account with no live reading, so a reset used elsewhere lifts the limit", async () => {
    // The 5-hour window filled 10 minutes before NOW and resets 4 hours after it. The sign-in has
    // expired since, so reads only get Claude Code's cached copy, older than the last live reading,
    // until one renews it. By then a reset used on another machine has emptied the window.
    const resetsAt = NOW + 240 * MINUTE;
    let fresh = true;
    let used = 100;
    const asked: number[] = [];
    const { service, store } = await setUpAccount(async (_home, options = {}) => {
      if (options.renewLogin) {
        asked.push(minutesIn());
        fresh = true;
      }
      if (!fresh) return { fetchedAt: new Date(NOW - 15 * MINUTE).toISOString(), windows: [fiveHour(100, resetsAt)], error: null, cached: true, resets: null };
      return { fetchedAt: new Date().toISOString(), windows: [fiveHour(used, resetsAt)], error: null, cached: false, resets: null };
    });
    const limitedUntil = async () => (await store.read()).accounts[0]!.limitedUntil;

    await readAt(service, -10); // full, so the reading records the window limit
    expect(await limitedUntil()).not.toBeNull();
    fresh = false;
    await readAt(service, 0); // only the cached copy
    used = 0;
    await readAt(service, 1); // renews and finds room, but a limit 11 minutes old is still trusted (LIMIT_TRUST_MS)
    expect(await limitedUntil()).not.toBeNull();
    await readAt(service, 6); // live without renewing now, and the limit is old enough to lift
    expect(await limitedUntil()).toBeNull();
    expect(asked).toEqual([1]);
  });

  it("still renews on every explicit refresh (↻)", async () => {
    const { service, asked } = await setUpPastReset();
    const paseo = fakePaseo().paseo as never;
    await readAt(service, 0);
    for (const minute of [1, 2]) {
      vi.setSystemTime(NOW + minute * MINUTE);
      await service.view(paseo, true);
    }
    // An explicit refresh counts as an attempt too, so the next background renewal waits 30 minutes from it.
    await readAt(service, 30);
    await readAt(service, 32);
    expect(asked).toEqual([0, 1, 2, 32]);
  });
});

describe("the account button's reason row", () => {
  it("names a near weekly reset as why an agent started on its account, only while it's still there", async () => {
    const { service, store } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "balance", at: new Date().toISOString(), selectionReason: "headroom" } },
        sessions: {},
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "" }),
    );
    const paseo = fakePaseo().paseo as never;
    const route = async () => (await service.view(paseo)).agents.find((entry) => entry.agentId === AGENT);

    // Most room left is how balancing always picks, so it gets no row.
    expect((await route())?.accountId).toBe(HELLO);
    expect((await route())?.selectionReason).toBeUndefined();

    await store.update((draft) => {
      draft.bindings[AGENT]!.selectionReason = "weekly_reset";
    });
    expect(await route()).toMatchObject({ accountId: HELLO, selectionReason: "weekly_reset" });

    // Moved off it for now, so the account the menu shows wasn't picked for its reset.
    await store.update((draft) => {
      draft.accounts.find((entry) => entry.id === HELLO)!.limitedUntil = inFuture();
    });
    expect((await route())?.accountId).toBe(MAIN);
    expect((await route())?.selectionReason).toBeUndefined();
  });
});
