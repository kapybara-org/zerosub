import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FamilyAdapter, Identity, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { chooseAccount } from "./routing";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, emptyState, findAccount, type StoredAccount, type StoredState } from "./state";
import { preferences } from "../shared/preferences";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const later = (ms: number) => new Date(NOW + ms).toISOString();

function account(id: string, family: "claude" | "codex" = "claude", kind: "main" | "managed" = "managed"): StoredAccount {
  return {
    id, family, label: id, autoLabel: false, kind, home: kind === "main" ? null : `/homes/${id}`, email: null, plan: null,
    organization: null, identity: null, signedIn: true, disabled: false, limitedUntil: null, limitKind: null,
    limitedAt: null, createdAt: "2026-09-01T00:00:00Z",
  } as StoredAccount;
}

const main = account("claude-main", "claude", "main");
const work = account("work");
const base = { agentId: "a1", family: "claude" as const, now: NOW, autoSwitch: true, balanceNewAgents: false, portable: true, usageOf: () => null };
const pick = { accountId: "work", until: later(60_000) };
const withPick = (next: StoredState["nextAgent"]["claude"], accounts = [main, work]): StoredState => ({
  ...emptyState(),
  accounts,
  nextAgent: { claude: next, codex: null, pi: null },
});
const limited = { ...work, limitedUntil: later(30 * 60_000), limitKind: "window" as const };

describe("next new agent pick", () => {
  it("starts a new agent on the picked account, even when spreading, and hands the pick back to spend", () => {
    for (const balanceNewAgents of [false, true]) {
      const d = chooseAccount(withPick(pick), { ...base, balanceNewAgents, reason: "create", allowNextPick: true });
      expect(d?.account.id).toBe("work");
      expect(d?.bind).toMatchObject({ accountId: "work", source: "user" });
      expect(d?.nextPick).toEqual(pick);
    }
  });

  it("leaves the pick alone for sessions that may not take it, resumed agents and agents with an account", () => {
    const state = withPick(pick);
    const helper = chooseAccount(state, { ...base, reason: "create", allowNextPick: false });
    expect(helper?.account.id).toBe("claude-main");
    expect(helper?.nextPick).toBeUndefined();
    expect(chooseAccount(state, { ...base, reason: "resume", allowNextPick: true })?.nextPick).toBeUndefined();
    const bound = { ...state, bindings: { a1: { accountId: "claude-main", source: "user" as const, at: "2026-11-09T11:00:00Z" } } };
    const own = chooseAccount(bound, { ...base, reason: "create", allowNextPick: true });
    expect(own?.account.id).toBe("claude-main");
    expect(own?.nextPick).toBeUndefined();
  });

  it("spends a pick whose account can't take the agent, which then routes as it would without one", () => {
    const cases: Array<[string, StoredState]> = [
      ["at its limit", withPick(pick, [main, limited])],
      ["signed out", withPick(pick, [main, { ...work, signedIn: false }])],
      ["disabled", withPick(pick, [main, { ...work, disabled: true }])],
      ["removed", withPick(pick, [main])],
      ["expired", withPick({ ...pick, until: later(-1) })],
    ];
    for (const [why, state] of cases) {
      const d = chooseAccount(state, { ...base, reason: "create", allowNextPick: true });
      expect(d?.account.id, why).toBe("claude-main");
      expect(d?.bind, why).toBeNull();
      expect(d?.skipped, why).toBeNull();
      expect(d?.nextPick, why).toEqual(state.nextAgent.claude);
    }
    const spread = chooseAccount(withPick(pick, [main, limited]), { ...base, balanceNewAgents: true, reason: "create", allowNextPick: true });
    expect(spread?.bind).toMatchObject({ accountId: "claude-main", source: "balance" });
  });

  it("with automatic switching off, still starts the agent on a picked account at its limit", () => {
    const d = chooseAccount(withPick(pick, [main, limited]), { ...base, autoSwitch: false, reason: "create", allowNextPick: true });
    expect(d?.account.id).toBe("work");
    expect(d?.bind).toMatchObject({ accountId: "work", source: "user" });
  });
});

// The same pick, as the daemon's sessions open: Paseo asks where each one goes as it starts.

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";
const WORK = "claude-work";
const WORKSPACE = "workspace-1";

let root: string;
let previousHome: string | undefined;
/** Every service a test set up, stopped before its directory goes so nothing it saves lands in the next test's. */
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-next-agent-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function stored(id: string, label: string, kind: "main" | "managed", fields: Partial<StoredAccount> = {}) {
  return { id, family: "claude", label, kind, home: kind === "main" ? null : join(tmpdir(), id), createdAt: "2026-09-23T00:00:00.000Z", ...fields };
}

const accounts = () => [stored(MAIN, "marketing", "main"), stored(HELLO, "hello", "managed")] as never;
const inFuture = () => new Date(Date.now() + 30 * 60_000).toISOString();

/** A registry of its own, holding `state`. */
async function storeWith(state: Partial<StoredState>): Promise<StateStore> {
  const store = new StateStore(join(await mkdtemp(join(root, "state-")), "state.json"));
  await store.update((draft) => Object.assign(draft, state));
  return store;
}

interface Options {
  /** Runs when routing prepares an added account's home, after it has decided and before it records where the agent opens. */
  prepareHome?: () => Promise<void>;
  /** What the CLI says about the sign-in of a home (`null`: the CLI login). */
  identity?: (home: string | null) => Promise<Identity>;
  /** What a usage reading of a home finds. */
  usage?: (home: string | null) => UsageRead;
}

function setUp(store: StateStore, options: Options = {}) {
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({
        refresh: async () => ({ agent: null }),
        timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  const claude = {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => options.prepareHome?.(),
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async (home: string | null) => options.identity?.(home) ?? null,
    usage: async (home: string | null) =>
      options.usage?.(home) ?? { fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null },
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
  const service = new Service(
    { claude, codex: claude, pi: claude },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  services.push(service);
  service.setPreferences(preferences.schema.parse({}));
  service.attach(paseo as never);
  const context = { paseo } as never;
  /** A new agent's first session, by default one the user starts in a workspace. Returns the account it opened on. */
  const open = async (agentId: string, request: { workspaceId?: string | null; background?: boolean } = {}) => {
    await service.onSessionOpen(
      { agentId, provider: "claude", cwd: "/repo", workspaceId: WORKSPACE, reason: "create", purpose: "interactive", env: {}, ...request } as never,
      context,
    );
    return (await store.read()).sessions[agentId]?.accountId;
  };
  return { service, store, paseo: paseo as never, open };
}

describe("the next new agent pick, as sessions open", () => {
  it("starts one new agent on the picked account, then is gone", async () => {
    const { service, store, paseo, open } = setUp(await storeWith({ accounts: accounts(), defaults: { claude: MAIN, codex: null, pi: null } }));
    const { until } = await service.setNextAgent(HELLO, true);
    expect((await service.view(paseo)).accounts.find((entry) => entry.id === HELLO)?.nextAgentUntil).toBe(until);

    expect(await open("first")).toBe(HELLO);
    let state = await store.read();
    expect(state.nextAgent.claude).toBeNull();
    expect(state.bindings.first).toMatchObject({ accountId: HELLO, source: "user" });
    expect((await service.view(paseo)).accounts.find((entry) => entry.id === HELLO)?.nextAgentUntil).toBeNull();

    expect(await open("second")).toBe(MAIN);
    state = await store.read();
    expect(state.bindings.second).toBeUndefined();
  });

  it("is spent when its account is at its limit, signed out, disabled or gone, and the agent routes as usual", async () => {
    const cases: Array<[string, Partial<StoredAccount> | null]> = [
      ["at its limit", { limitedUntil: inFuture(), limitKind: "window" }],
      ["signed out", { signedIn: false }],
      ["disabled", { disabled: true }],
      ["removed", null],
    ];
    // The default is busy and another account has more room, so routing as usual and standing in differ.
    const reading = (usedPercent: number): UsageRead => ({
      fetchedAt: new Date().toISOString(),
      windows: [{ id: "five_hour", label: "5-hour", usedPercent, resetsAt: null }],
      error: null,
      cached: false,
      resets: null,
    });
    for (const balanceNewAgents of [false, true]) {
      for (const [why, hello] of cases) {
        const label = `${why}${balanceNewAgents ? ", spreading" : ""}`;
        const { service, store, open } = setUp(
          await storeWith({
            accounts: [
              stored(MAIN, "marketing", "main"),
              ...(hello ? [stored(HELLO, "hello", "managed", hello)] : []),
              stored(WORK, "work", "managed"),
            ] as never,
            defaults: { claude: MAIN, codex: null, pi: null },
            // Picked while the account could still take agents.
            nextAgent: { claude: { accountId: HELLO, until: inFuture() }, codex: null, pi: null },
          }),
          { usage: (home) => reading(home === null ? 70 : 10) },
        );
        service.setPreferences({ ...preferences.schema.parse({}), balanceNewAgents });
        await Promise.all([service.refreshUsage(MAIN, true), service.refreshUsage(WORK, true)]);

        // Without Spread, the default; with it, the account with the most room.
        const usual = balanceNewAgents ? WORK : MAIN;
        expect(await open("first"), label).toBe(usual);
        let state = await store.read();
        expect(state.nextAgent.claude, label).toBeNull();
        expect(state.bindings.first?.source, label).toBe(balanceNewAgents ? "balance" : undefined);
        expect(await open("second"), label).toBe(usual);
        state = await store.read();
        expect(state.bindings.second?.source, label).toBe(balanceNewAgents ? "balance" : undefined);
      }
    }
  });

  it("goes to only one of two agents opening at once", async () => {
    let arrived = 0;
    let bothDecided = () => {};
    const together = new Promise<void>((resolve) => (bothDecided = resolve));
    const { service, store, open } = setUp(await storeWith({ accounts: accounts(), defaults: { claude: MAIN, codex: null, pi: null } }), {
      // Both have chosen where to open before either records it.
      prepareHome: async () => {
        arrived += 1;
        if (arrived === 2) bothDecided();
        await together;
      },
    });
    await service.setNextAgent(HELLO, true);

    const [first, second] = await Promise.all([open("first"), open("second")]);
    expect([first, second].sort()).toEqual([HELLO, MAIN].sort());
    const state = await store.read();
    expect(state.nextAgent.claude).toBeNull();
    const onHello = first === HELLO ? "first" : "second";
    const other = onHello === "first" ? "second" : "first";
    expect(state.bindings[onHello]).toMatchObject({ accountId: HELLO, source: "user" });
    expect(state.bindings[other]).toBeUndefined();
  });

  it("is left for the user's own agent by sessions with no workspace and by background agents", async () => {
    const { service, store, open } = setUp(await storeWith({ accounts: accounts(), defaults: { claude: MAIN, codex: null, pi: null } }));
    const { until } = await service.setNextAgent(HELLO, true);
    // Paseo's branch-name generator starts as a new worktree workspace gets its first prompt, and
    // opens in no workspace, as its commit and PR text helpers do.
    expect(await open("branch-name-generator", { workspaceId: null })).toBe(MAIN);
    // A helper hidden from tabs and lists (Paseo 0.16 and later).
    expect(await open("background-helper", { background: true })).toBe(MAIN);
    let state = await store.read();
    expect(state.nextAgent.claude).toEqual({ accountId: HELLO, until });
    expect(state.bindings["branch-name-generator"]).toBeUndefined();
    expect(state.bindings["background-helper"]).toBeUndefined();

    // The user's agent, as Paseo 0.16 describes it (older versions don't say `background` at all).
    expect(await open("mine", { background: false })).toBe(HELLO);
    state = await store.read();
    expect(state.nextAgent.claude).toBeNull();
  });

  it("can't be set on an account that's gone, signed out or disabled", async () => {
    const { service, store } = setUp(
      await storeWith({
        accounts: [
          stored(MAIN, "marketing", "main"),
          stored(HELLO, "hello", "managed", { signedIn: false }),
          stored(WORK, "work", "managed", { disabled: true }),
        ] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
      }),
    );
    await expect(service.setNextAgent("claude-gone", true)).rejects.toThrow(/no longer exists/);
    await expect(service.setNextAgent(HELLO, true)).rejects.toThrow(/hello is signed out/);
    await expect(service.setNextAgent(WORK, true)).rejects.toThrow(/work is disabled/);
    expect((await store.read()).nextAgent).toEqual({ claude: null, codex: null, pi: null });
  });

  it("is canceled when its account is removed, disabled or signed out", async () => {
    for (const how of ["removed", "disabled", "signed out"] as const) {
      const { service, store, paseo } = setUp(await storeWith({ accounts: accounts(), defaults: { claude: MAIN, codex: null, pi: null } }), {
        identity: async (home) => ({ signedIn: home === null, email: null, plan: null, organization: null, identity: null }),
      });
      await service.setNextAgent(HELLO, true);
      if (how === "removed") {
        await service.remove(paseo, HELLO);
        await service.cleanUpHomes(paseo);
      } else if (how === "disabled") {
        await service.setAccountEnabled(paseo, HELLO, false);
      } else {
        // The check upkeep runs on every account's sign-in, and after a turn that reads like a sign-out.
        await (service as unknown as { refreshIdentity(accountId: string): Promise<void> }).refreshIdentity(HELLO);
        expect(findAccount(await store.read(), HELLO)?.signedIn, how).toBe(false);
      }
      expect((await store.read()).nextAgent.claude, how).toBeNull();
    }
  });

  it("starts out empty with a state file from before picks, which StateStore reads whole", async () => {
    const dir = join(root, "earlier");
    await mkdir(dir);
    const path = join(dir, "state.json");
    // As an earlier version wrote it: no `nextAgent`, and accounts with only the fields it had.
    const earlier = {
      version: 1,
      accounts: [stored(MAIN, "marketing", "main"), stored(HELLO, "hello", "managed")],
      defaults: { claude: MAIN, codex: null, pi: null },
      bindings: {},
      sessions: {},
      continuations: {},
    };
    await writeFile(path, JSON.stringify(earlier));
    const store = new StateStore(path);
    const state = await store.read();
    expect(state.nextAgent).toEqual({ claude: null, codex: null, pi: null });
    expect(state.accounts.map((entry) => entry.id)).toEqual([MAIN, HELLO]);
    // Nothing set aside as damaged, and nothing restored from a backup.
    expect(await readdir(dir)).toEqual(["state.json"]);

    const { service, open } = setUp(store);
    expect(await open("before")).toBe(MAIN);
    await service.setNextAgent(HELLO, true);
    expect(await open("after")).toBe(HELLO);
    expect(JSON.parse(await readFile(path, "utf8")).nextAgent).toEqual({ claude: null, codex: null, pi: null });
  });
});
