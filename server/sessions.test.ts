import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FamilyAdapter } from "./adapter";
import { absentPi } from "./fakes.test-support";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";
import { preferences } from "../shared/preferences";

// Where ZeroSub records an agent's session must be where it really runs: the account button, the
// 30-second check and failover all go by that record.

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";
const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
const CODEX_WORK = "codex-work";
const AGENT = "agent-1";
const EARLIER = "2026-09-23T07:00:00.000Z";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-sessions-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

/** Every service a test set up, stopped before its directory goes so nothing it saves lands in the next test's. */
const services: Service[] = [];

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

function account(id: string, family: "claude" | "codex", label: string, kind: "main" | "managed") {
  return { id, family, label, kind, home: kind === "main" ? null : join(tmpdir(), id), createdAt: "2026-09-23T00:00:00.000Z" };
}

const claudeAccounts = () => [account(MAIN, "claude", "marketing", "main"), account(HELLO, "claude", "hello", "managed")] as never;
const codexAccounts = () => [account(CODEX_MAIN, "codex", "chatgpt", "main"), account(CODEX_WORK, "codex", "work", "managed")] as never;

/** Holds routing up where it asks for the account's environment, after it has recorded the session. */
function gate() {
  let reach = () => {};
  let release = () => {};
  const reached = new Promise<void>((resolve) => (reach = resolve));
  const released = new Promise<void>((resolve) => (release = resolve));
  return {
    reached,
    release,
    wait: async () => {
      reach();
      await released;
    },
  };
}

interface Agent {
  id: string;
  provider: "claude" | "codex";
  status: string;
  archivedAt: string | null;
  lastUserMessageAt: string | null;
}

interface Options {
  /** Runs when routing asks for an account's environment. */
  env?: () => Promise<void>;
  /** Paseo stops waiting for the reload's routing once it has recorded the session, and goes ahead. */
  abandonReload?: boolean;
  /** Agents Paseo finds by ID but leaves out of its list, as it does those in background workspaces. */
  unlisted?: Array<Agent & { internal?: boolean }>;
  /** Agents Paseo can't look up just now. */
  lookupFails?: string[];
  /** Answer an unknown ID, or a helper's, with an error, as Paseo 0.9 and 0.10 do. */
  notFoundError?: boolean;
}

async function setUp(state: Partial<StoredState>, agents: Agent[], options: Options = {}) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => Object.assign(draft, state));
  const notes: Array<{ from: string | null; to: string; outcome: string; detail: string | null }> = [];
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => {
          if (options.lookupFails?.includes(id)) throw new Error("Timeout waiting for message");
          const agent = [...agents, ...(options.unlisted ?? [])].find((entry) => entry.id === id);
          if (options.notFoundError && (!agent || (agent as { internal?: boolean }).internal)) throw new Error(`Agent not found: ${id}`);
          return { agent };
        },
        send: async () => undefined,
        timeline: {
          append: async (item: { data: (typeof notes)[number] }) => void notes.push(item.data),
          refetch: async () => ({ entries: [] }),
        },
      }),
    },
  };
  const context = { paseo } as never;
  const open = (agentId: string, reason: "create" | "resume" | "refresh", signal?: AbortSignal) => {
    const provider = agents.find((agent) => agent.id === agentId)?.provider ?? "claude";
    return service.onSessionOpen({ agentId, provider, reason, purpose: "interactive", env: {} } as never, context, signal);
  };
  const reopened: string[] = [];
  const background: Array<Promise<unknown>> = [];
  const adapter = (family: "claude" | "codex"): FamilyAdapter =>
    ({
      family,
      portable: family === "claude",
      usageSpacingMs: 0,
      available: async () => ({ ok: true, detail: null }),
      prepareHome: async () => undefined,
      env: async (home: string | null) => {
        await options.env?.();
        return home ? { [family === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: home } : {};
      },
      identity: async () => null,
      usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
      redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
      login: async () => {
        throw new Error("not in tests");
      },
      logout: async () => undefined,
      detectLimit: () => null,
      detectSignOut: () => null,
    }) as unknown as FamilyAdapter;
  const reopener = {
    locate: async () => "/usr/local/bin/paseo",
    reopen: async (agentId: string) => {
      reopened.push(agentId);
      if (!options.abandonReload) {
        await open(agentId, "refresh");
        return { ok: true as const };
      }
      const late = new AbortController();
      const routing = open(agentId, "refresh", late.signal);
      background.push(routing.catch(() => undefined));
      await gated?.reached;
      late.abort();
      gated?.release();
      return { ok: true as const };
    },
  };
  const gated = options.abandonReload ? gate() : undefined;
  if (gated) options.env = gated.wait;
  const service: Service = new Service(
    { claude: adapter("claude"), codex: adapter("codex"), pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
    reopener as unknown as Reopener,
  );
  services.push(service);
  service.setPreferences(preferences.schema.parse({}));
  service.attach(paseo as never);
  return { service, store, paseo: paseo as never, context, open, reopened, notes, background };
}

const live = (id: string, provider: "claude" | "codex" = "claude"): Agent => ({
  id,
  provider,
  status: "idle",
  archivedAt: null,
  lastUserMessageAt: EARLIER,
});

describe("a session that opens without ZeroSub's answer", () => {
  it("runs on the CLI login when routing takes too long, and shows the move still to come", async () => {
    const held = gate();
    const { service, store, paseo, open, reopened } = await setUp(
      {
        accounts: claudeAccounts(),
        defaults: { claude: MAIN, codex: null, pi: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: EARLIER } },
        sessions: {},
      },
      [live(AGENT)],
      { env: held.wait },
    );
    const late = new AbortController();
    const opening = open(AGENT, "resume", late.signal);
    await held.reached;
    late.abort(); // Paseo stopped waiting and opened the session as it was
    held.release();
    expect(await opening).toBeUndefined();

    expect((await store.read()).sessions[AGENT]).toBeUndefined();
    const route = (await service.view(paseo)).agents.find((entry) => entry.agentId === AGENT);
    expect(route).toMatchObject({ accountId: HELLO, pendingAccountId: MAIN });

    // The CLI login works, so nothing moves it unattended: a reload would cancel what it's doing.
    expect((await service.alignSessions(paseo)).reopened).toEqual([]);
    expect(reopened).toEqual([]);

    // Once it can't work there, the 30-second check moves it where it belongs.
    await store.update((draft) => {
      const login = draft.accounts.find((entry) => entry.id === MAIN);
      if (login) login.limitedUntil = new Date(Date.now() + 30 * 60_000).toISOString();
    });
    expect((await service.alignSessions(paseo)).reopened).toEqual([AGENT]);
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("forgets the account it ran on before when routing fails", async () => {
    let failing = true;
    const { store, open } = await setUp(
      {
        accounts: claudeAccounts(),
        defaults: { claude: MAIN, codex: null, pi: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: EARLIER } },
        sessions: { [AGENT]: { accountId: HELLO, family: "claude", openedAt: EARLIER } },
      },
      [live(AGENT)],
      {
        env: async () => {
          if (failing) throw new Error("EACCES: permission denied");
        },
      },
    );
    await expect(open(AGENT, "refresh")).rejects.toThrow(/EACCES/);
    expect((await store.read()).sessions[AGENT]).toBeUndefined();

    failing = false;
    await open(AGENT, "refresh");
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("doesn't count a reload as landed when Paseo opened it before routing answered", async () => {
    const { service, store, paseo, notes, background } = await setUp(
      {
        accounts: claudeAccounts(),
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt: EARLIER } },
      },
      [live(AGENT)],
      { abandonReload: true },
    );
    const summary = await service.setAgentAccount(paseo, AGENT, HELLO);
    expect(summary.reopened).toEqual([]);
    expect(summary.failed).toEqual([{ agentId: AGENT, error: expect.stringMatching(/CLI login/) }]);
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "pending" });
    await Promise.all(background);
    const state = await store.read();
    expect(state.sessions[AGENT]).toBeUndefined();
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO); // where it goes when its session next opens
    const route = (await service.view(paseo)).agents.find((entry) => entry.agentId === AGENT);
    expect(route).toMatchObject({ accountId: HELLO, pendingAccountId: MAIN, waiting: "restart" });
  });

  it("pins a new ChatGPT thread to the CLI login when it starts there", async () => {
    const held = gate();
    const { store, open } = await setUp(
      { accounts: codexAccounts(), defaults: { claude: null, codex: CODEX_WORK, pi: null }, sessions: {} },
      [{ ...live(AGENT, "codex"), lastUserMessageAt: null }],
      { env: held.wait },
    );
    const late = new AbortController();
    const opening = open(AGENT, "create", late.signal);
    await held.reached;
    late.abort();
    held.release();
    await opening;
    let state = await store.read();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(state.sessions[AGENT]).toBeUndefined();

    // It started on the CLI login, so that's where it reopens.
    await open(AGENT, "resume");
    state = await store.read();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
    expect(state.sessions[AGENT]?.accountId).toBe(CODEX_MAIN);
  });

  it("pins a ChatGPT hand-off to the CLI login when its first open goes unrouted", async () => {
    const held = gate();
    const { service, store, paseo, open, reopened } = await setUp(
      {
        accounts: codexAccounts(),
        defaults: { claude: null, codex: CODEX_MAIN, pi: null },
        // The hand-off pinned the new thread to work before it first opened.
        bindings: { [AGENT]: { accountId: CODEX_WORK, source: "thread", at: EARLIER } },
        sessions: {},
      },
      [{ ...live(AGENT, "codex"), lastUserMessageAt: null }],
      { env: held.wait },
    );
    const late = new AbortController();
    const opening = open(AGENT, "create", late.signal);
    await held.reached;
    late.abort();
    held.release();
    await opening;
    expect((await store.read()).bindings[AGENT]).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });

    // Its history is written on the CLI login, which work can't read, so it stays there.
    expect((await service.alignSessions(paseo)).reopened).toEqual([]);
    expect(reopened).toEqual([]);
    await open(AGENT, "resume");
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(CODEX_MAIN);
  });

  it("pins a ChatGPT thread with no history to the CLI login when a reload of it goes unrouted", async () => {
    const held = gate();
    const { store, open } = await setUp(
      {
        accounts: codexAccounts(),
        defaults: { claude: null, codex: CODEX_MAIN, pi: null },
        bindings: { [AGENT]: { accountId: CODEX_WORK, source: "thread", at: EARLIER } },
        sessions: { [AGENT]: { accountId: CODEX_WORK, family: "codex", openedAt: EARLIER } },
      },
      [{ ...live(AGENT, "codex"), lastUserMessageAt: null }],
      { env: held.wait },
    );
    const late = new AbortController();
    const opening = open(AGENT, "refresh", late.signal);
    await held.reached;
    late.abort();
    held.release();
    await opening;
    const state = await store.read();
    expect(state.sessions[AGENT]).toBeUndefined();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
  });

  it("leaves a ChatGPT thread with history pinned where its history is when it opens unrouted", async () => {
    const held = gate();
    const { store, open } = await setUp(
      {
        accounts: codexAccounts(),
        defaults: { claude: null, codex: CODEX_MAIN, pi: null },
        bindings: { [AGENT]: { accountId: CODEX_WORK, source: "thread", at: EARLIER } },
        sessions: { [AGENT]: { accountId: CODEX_WORK, family: "codex", openedAt: EARLIER } },
      },
      [live(AGENT, "codex")],
      { env: held.wait },
    );
    const late = new AbortController();
    const opening = open(AGENT, "refresh", late.signal);
    await held.reached;
    late.abort();
    held.release();
    await opening;
    expect((await store.read()).bindings[AGENT]).toMatchObject({ accountId: CODEX_WORK, source: "thread" });
  });
});

describe("closed agents", () => {
  it("forget where they ran, so one reopened while ZeroSub is off counts as on the CLI login", async () => {
    const { service, store, paseo } = await setUp(
      {
        accounts: claudeAccounts(),
        defaults: { claude: HELLO, codex: null, pi: null },
        sessions: { [AGENT]: { accountId: HELLO, family: "claude", openedAt: EARLIER } },
      },
      [live(AGENT)],
    );
    await service.onAgentClosed(AGENT);
    expect((await store.read()).sessions[AGENT]).toBeUndefined();
    const route = (await service.view(paseo)).agents.find((entry) => entry.agentId === AGENT);
    expect(route).toMatchObject({ accountId: HELLO, pendingAccountId: MAIN });
  });

  it("keep a session that opened after the close", async () => {
    const { service, store, open } = await setUp(
      { accounts: claudeAccounts(), defaults: { claude: HELLO, codex: null, pi: null }, sessions: {} },
      [live(AGENT)],
    );
    const closing = service.onAgentClosed(AGENT);
    await open(AGENT, "resume");
    await closing;
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("left from before ZeroSub started are forgotten once Paseo lists them as closed", async () => {
    const { service, store } = await setUp(
      {
        accounts: claudeAccounts(),
        defaults: { claude: HELLO, codex: null, pi: null },
        sessions: {
          closed: { accountId: HELLO, family: "claude", openedAt: EARLIER },
          archived: { accountId: HELLO, family: "claude", openedAt: EARLIER },
          open: { accountId: HELLO, family: "claude", openedAt: EARLIER },
        },
      },
      [
        { ...live("closed"), status: "closed" },
        { ...live("archived"), status: "closed", archivedAt: EARLIER },
        live("open"),
      ],
    );
    // Waits for the upkeep pass start() begins, so nothing of it runs on after the test.
    const target = service as unknown as { tick(): Promise<void> };
    const tick = target.tick.bind(service);
    const ticks: Array<Promise<void>> = [];
    target.tick = () => {
      const run = tick();
      ticks.push(run.catch(() => undefined));
      return run;
    };
    try {
      await service.start();
      await Promise.all(ticks);
      const { sessions } = await store.read();
      expect(sessions.closed).toBeUndefined();
      expect(sessions.archived).toBeUndefined();
      expect(sessions.open?.accountId).toBe(HELLO);
    } finally {
      await service.stop();
      await Promise.all(ticks);
    }
  });
});

describe("agents Paseo doesn't list", () => {
  it("keep their records while Paseo still knows them, as it does agents in background workspaces", async () => {
    const recorded = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { accountId: HELLO, family: "claude" as const, openedAt: EARLIER }]));
    const bound = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { accountId: HELLO, source: "user" as const, at: EARLIER }]));
    const { service, store, paseo } = await setUp(
      {
        accounts: claudeAccounts(),
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: recorded("background", "gone", "helper", "unsure"),
        bindings: bound("background", "gone", "helper", "unsure"),
      },
      [live("open")],
      { unlisted: [live("background"), { ...live("helper"), internal: true }], lookupFails: ["unsure"] },
    );
    await (service as unknown as { prune(paseo: unknown): Promise<void> }).prune(paseo);
    const { sessions, bindings } = await store.read();
    // Gone, or one of Paseo's hidden helpers: forgotten. Still there, or no answer yet: kept.
    expect(Object.keys(sessions).sort()).toEqual(["background", "unsure"]);
    expect(Object.keys(bindings).sort()).toEqual(["background", "unsure"]);
  });

  it("are forgotten when an older Paseo says it can't find them", async () => {
    const recorded = (...ids: string[]) => Object.fromEntries(ids.map((id) => [id, { accountId: HELLO, family: "claude" as const, openedAt: EARLIER }]));
    const { service, store, paseo } = await setUp(
      {
        accounts: claudeAccounts(),
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: recorded("background", "gone", "helper", "unsure"),
      },
      [live("open")],
      { unlisted: [live("background"), { ...live("helper"), internal: true }], lookupFails: ["unsure"], notFoundError: true },
    );
    await (service as unknown as { prune(paseo: unknown): Promise<void> }).prune(paseo);
    expect(Object.keys((await store.read()).sessions).sort()).toEqual(["background", "unsure"]);
  });
});

describe("ChatGPT threads with history", () => {
  it("go back to their own account when their session opened without ZeroSub", async () => {
    const { service, store, paseo, reopened } = await setUp(
      {
        accounts: codexAccounts(),
        defaults: { claude: null, codex: CODEX_MAIN, pi: null },
        bindings: { [AGENT]: { accountId: CODEX_WORK, source: "thread", at: EARLIER } },
        sessions: {},
      },
      [live(AGENT, "codex")],
    );
    expect((await service.alignSessions(paseo)).reopened).toEqual([AGENT]);
    expect(reopened).toEqual([AGENT]);
    const state = await store.read();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: CODEX_WORK, source: "thread" });
    expect(state.sessions[AGENT]?.accountId).toBe(CODEX_WORK);
  });

  it("stay where ZeroSub opened them when they gained history while waiting to move", async () => {
    const { service, store, paseo, reopened } = await setUp(
      {
        accounts: codexAccounts(),
        defaults: { claude: null, codex: CODEX_MAIN, pi: null },
        bindings: { [AGENT]: { accountId: CODEX_WORK, source: "thread", at: EARLIER } },
        sessions: { [AGENT]: { accountId: CODEX_MAIN, family: "codex", openedAt: EARLIER } },
      },
      [live(AGENT, "codex")],
    );
    expect((await service.alignSessions(paseo)).reopened).toEqual([]);
    expect(reopened).toEqual([]);
    expect((await store.read()).bindings[AGENT]).toMatchObject({ accountId: CODEX_MAIN, source: "thread" });
  });
});
