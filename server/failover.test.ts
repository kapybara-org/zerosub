import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem, FamilyAdapter, Identity, LimitHit, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import { detectClaudeLimit } from "./limits";
import type { Reopener } from "./reopen";
import type { SwitchGuard } from "./switch-guard";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type OpenCodeFork, type StoredAccount, type StoredState } from "./state";
import { buildTranscript, continuationPrompt } from "./handoff";
import { paceScore } from "./routing";
import { saveReadings } from "./usage";
import type { Usage } from "../shared/model";
import { preferences } from "../shared/preferences";
import { absentPi } from "./fakes.test-support";

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";
const AGENT = "agent-1";

let root: string;
let previousHome: string | undefined;
/** The services the current test made, stopped once it ends. */
const services: Service[] = [];
let previousLaunchers: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-failover-"));
  previousHome = process.env.PASEO_HOME;
  previousLaunchers = process.env.ZEROSUB_LAUNCHER_DIR;
  process.env.ZEROSUB_LAUNCHER_DIR = join(root, "launchers");
  process.env.PASEO_HOME = root; // saved usage lands here, never in the real ~/.paseo
});

afterEach(async () => {
  // A reading is saved 3 s after it lands. Stopping saves it now, while PASEO_HOME is still this
  // test's folder, rather than in whatever folder a later test has set by then.
  await Promise.all(services.splice(0).map((service) => service.stop()));
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  if (previousLaunchers === undefined) delete process.env.ZEROSUB_LAUNCHER_DIR;
  else process.env.ZEROSUB_LAUNCHER_DIR = previousLaunchers;
  // Retried: a write the test set off in the background can still be landing in it.
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
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
  const agent: { id: string; provider: string; status: string; archivedAt: null; lastUserMessageAt: string; currentModeId?: string | null } = {
    id: AGENT,
    provider: "claude",
    status: "idle",
    archivedAt: null,
    lastUserMessageAt: "2026-09-23T07:00:00.000Z",
    // Not Auto mode, which Bedrock can't run (see "Claude's Auto mode and Bedrock").
    currentModeId: "acceptEdits",
  };
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
      // Only the agent Paseo has: a new one's session opens before Paseo can say anything about it.
      ref: (id: string = AGENT) => ({
        refresh: async () => ({ agent: id === agent.id ? agent : null }),
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
  return { paseo, sent, notes, refetches, agent };
}

interface SetUpOptions {
  /** How `paseo agent reload` ends. `fails after another` fails once another reload has opened a session too. */
  reload?: "no session" | "works" | "fails" | "times out" | "fails after another";
  /** Runs when `paseo agent reload` starts, before Paseo asks where the new session opens. */
  reloading?: () => Promise<void>;
  /** Replaces parts of the Claude adapter. */
  claude?: Partial<FamilyAdapter>;
  /** Reads turns with a real detector instead of taking every failed turn for a limit. */
  detectLimit?: FamilyAdapter["detectLimit"];
  /** The tail of the agent's timeline as Paseo returns it when asked. */
  recent?: Parameters<typeof fakePaseo>[0];
  /** What every usage reading returns. */
  usage?: () => UsageRead;
  /** Who the adapter says is signed in. */
  identity?: () => Identity;
  /** Reads turns for a sign-out with this instead of finding none. */
  detectSignOut?: FamilyAdapter["detectSignOut"];
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
      if (options.reload === "no session") return { ok: true as const };
      await options.reloading?.();
      await reopenedSession();
      if (options.reload === "fails after another") {
        // Paseo runs one reload of an agent at a time, so the other one opened its session after this one.
        await reopenedSession();
        return { ok: false as const, error: "Timed out closing previous session during refresh", timedOut: false };
      }
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
    ...(options.identity ? { identity: async () => options.identity!() } : {}),
    ...(options.detectSignOut ? { detectSignOut: options.detectSignOut } : {}),
    ...options.claude,
  };
  const service = new Service(
    { claude, codex: claudeAdapter(hit), pi: absentPi() },
    store,
    families as unknown as FamilyResolver,
    reopener as unknown as Reopener,
  );
  services.push(service);
  const limitTurn = () =>
    service.onTurnEnded(
      { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
      context,
    );
  return { service, store, reopened, limitTurn, ...fake };
}

/**
 * Uses a reset with timers held: the usage read it schedules for a few seconds later would
 * otherwise land in whichever test runs then, maybe while that one's folder is being deleted.
 */
async function redeemNow(service: Service, paseo: unknown, accountId: string, agentId?: string) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    return await service.redeem(paseo as never, accountId, agentId);
  } finally {
    vi.useRealTimers();
  }
}

const inFuture = () => new Date(Date.now() + 30 * 60_000).toISOString();
/** Agents placed on an account in the last 10 minutes, as pacing counts them. */
const pendingOn = (service: Service, accountId: string) =>
  (service as unknown as { pendingOn(id: string, now: number): number }).pendingOn(accountId, Date.now());
/** Records an agent just placed on an account. */
const placed = (service: Service, accountId: string) =>
  (service as unknown as { notePlacement(id: string, now: number): void }).notePlacement(accountId, Date.now());
const inPast = () => new Date(Date.now() - 60_000).toISOString();

const TWIN = "claude-twin";
const signedInAs = (key: string) => ({ ...account(key, key, "managed"), identity: key, email: `${key}@example.com` });

describe("one subscription, one limit", () => {
  const window = () => ({ kind: "window" as const, resetsAt: inFuture(), message: "You've hit your session limit" });
  const twinOfMain = (): StoredAccount => ({ ...account(MAIN, "main", "main"), identity: "org|x", email: "x@example.com" }) as never;
  const twin = (): StoredAccount => ({ ...account(TWIN, "twin", "managed"), identity: "org|x", email: "x@example.com" }) as never;

  it("limits the twin slot too and moves the agent to a different subscription", async () => {
    const other = { ...account(HELLO, "hello", "managed"), identity: "org|y", email: "y@example.com" } as never;
    const { store, reopened, limitTurn } = await setUp(
      { accounts: [twinOfMain(), twin(), other], defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      window,
    );
    await limitTurn();
    const state = await store.read();
    const byId = (id: string) => state.accounts.find((a) => a.id === id);
    expect(byId(TWIN)?.limitedUntil).toBe(byId(MAIN)?.limitedUntil);
    expect(byId(TWIN)).toMatchObject({ limitKind: "window", limitSource: "turn" });
    expect(byId(HELLO)?.limitedUntil).toBeNull();
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([AGENT]);
  });

  it("doesn't move the agent onto a twin that shares the exhausted quota", async () => {
    const { reopened, notes, limitTurn } = await setUp(
      { accounts: [twinOfMain(), twin()], defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      window,
    );
    await limitTurn();
    expect(reopened).toEqual([]);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
  });

  it("lifts the twin's limit along with the one the user marks available", async () => {
    const { service, store, limitTurn } = await setUp(
      { accounts: [twinOfMain(), twin()], defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      window,
    );
    await limitTurn();
    await service.clearLimit(TWIN);
    const state = await store.read();
    expect(state.accounts.map((a) => a.limitedUntil)).toEqual([null, null]);
  });

  const reset = { redeemReset: async () => ({ outcome: "reset" as const, message: "Limits reset.", left: 0 }) };

  it("lifts the twin's limit along with a banked reset", async () => {
    const { service, store, paseo, limitTurn } = await setUp(
      { accounts: [twinOfMain(), twin()], defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      window,
      { claude: reset },
    );
    await limitTurn();
    expect((await redeemNow(service, paseo, TWIN)).outcome).toBe("reset");
    expect((await store.read()).accounts.map((a) => a.limitedUntil)).toEqual([null, null]);
  });

  it("doesn't let a stale notice from the twin limit the subscription a reset just refilled", async () => {
    const { service, store, paseo, sent, limitTurn } = await setUp(
      { accounts: [twinOfMain(), twin()], defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      window,
      { claude: reset },
    );
    await limitTurn();
    expect((await redeemNow(service, paseo, TWIN)).outcome).toBe("reset");
    // A turn on the CLI login ran into the limit before the reset on the twin, and ends just after it.
    await limitTurn();
    expect((await store.read()).accounts.map((a) => a.limitedUntil)).toEqual([null, null]);
    expect(sent).toHaveLength(1); // It carries on where it is.
  });
});

describe("when the CLI login changes hands", () => {
  const reading = (percent: number) => (): UsageRead => ({
    fetchedAt: new Date().toISOString(),
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: inFuture() }],
    error: null,
    cached: false,
    resets: null,
  });
  const as = (key: string): Identity => ({ signedIn: true, email: `${key}@example.com`, plan: null, organization: null, identity: key });
  const stale = { ...signedInAs("old"), ...account(MAIN, "main", "main"), limitedUntil: inFuture(), limitKind: "window", limitedAt: inPast(), limitSource: "turn" };

  async function handOver(others: StoredAccount[]) {
    let percent = 0;
    let who = "old";
    const { service, store } = await setUp(
      { accounts: [stale as never, ...others], defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      () => ({ kind: "window", resetsAt: inFuture(), message: "" }),
      { usage: () => reading(percent)(), identity: () => as(who) },
    );
    await service.refreshUsage(MAIN, true);
    who = "new";
    percent = 40;
    await (service as unknown as { refreshIdentity(id: string): Promise<void> }).refreshIdentity(MAIN);
    await service.refreshUsage(MAIN, true);
    const main = (await store.read()).accounts.find((a) => a.id === MAIN)!;
    const shown = (await service.view(fakePaseo().paseo as never)).accounts.find((a) => a.id === MAIN);
    return { main, shown };
  }

  it("drops the previous person's limit and reading", async () => {
    const { main, shown } = await handOver([]);
    expect(main).toMatchObject({ identity: "new", limitedUntil: null, limitKind: null, limitedAt: null });
    expect(shown?.usage?.windows.map((w) => w.usedPercent)).toEqual([40]);
  });

  it("takes over the limit of another slot already signed into the new account", async () => {
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const { main } = await handOver([{ ...signedInAs("new"), limitedUntil: until, limitKind: "window", limitedAt: inPast(), limitSource: "reading" } as never]);
    expect(main).toMatchObject({ identity: "new", limitedUntil: until, limitKind: "window", limitSource: "reading" });
  });

  const hit = () => ({ kind: "window" as const, resetsAt: inFuture(), message: "" });
  const checkIdentity = (service: Service) => (service as unknown as { refreshIdentity(id: string): Promise<void> }).refreshIdentity(MAIN);
  const card = async (service: Service, paseo: unknown) => (await service.view(paseo as never)).accounts.find((a) => a.id === MAIN);
  /** The new person's reading, which lands once `land` is called. */
  function slowReading(percent: number) {
    let land = () => {};
    const landed = new Promise<void>((resolve) => (land = resolve));
    return { land, read: () => landed.then(reading(percent)) };
  }
  /** Another slot, signed into the new person's account and at its limit. */
  const newAtLimit = (until: string) =>
    ({ ...signedInAs("new"), limitedUntil: until, limitKind: "window", limitedAt: inPast(), limitSource: "reading" }) as never;

  it("shows the new person on the card at once, without the previous person's limit or reading", async () => {
    let who = "old";
    const next = slowReading(40);
    const { service, paseo } = await setUp(
      { accounts: [stale as never], defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      hit,
      { identity: () => as(who), claude: { usage: async () => (who === "old" ? reading(97)() : next.read()) } },
    );
    await service.refreshUsage(MAIN, true);
    expect(await card(service, paseo)).toMatchObject({ status: "limited", usage: { windows: [{ usedPercent: 97 }] } });
    who = "new";
    await checkIdentity(service);
    // Nobody asked for a refresh: until the new person's reading lands, the card shows none.
    expect(await card(service, paseo)).toMatchObject({ email: "new@example.com", status: "ready", limitedUntil: null, usage: null });
    next.land();
    await vi.waitFor(async () => expect((await card(service, paseo))?.usage?.windows.map((w) => w.usedPercent)).toEqual([40]));
  });

  it("finds a change of hands at startup, and drops the previous person's saved reading and limit", async () => {
    await saveReadings(new Map([[MAIN, { ...reading(97)(), credits: null }]]));
    const next = slowReading(40);
    const { service, store, paseo } = await setUp(
      { accounts: [stale as never], defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      hit,
      { identity: () => as("new"), claude: { usage: next.read } },
    );
    await service.start();
    expect((await store.read()).accounts.find((a) => a.id === MAIN)).toMatchObject({ identity: "new", limitedUntil: null, limitedAt: null });
    expect(await card(service, paseo)).toMatchObject({ status: "ready", usage: null });
    next.land();
    await vi.waitFor(async () => expect((await card(service, paseo))?.usage?.windows.map((w) => w.usedPercent)).toEqual([40]));
  });

  it("takes over another slot's limit when the CLI login is signed in here as that slot's account", async () => {
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    let who = "old";
    const { service, store } = await setUp(
      { accounts: [stale as never, newAtLimit(until)], defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      hit,
      {
        identity: () => as(who),
        claude: {
          login: async () => {
            who = "new";
            return {
              progress: { step: "starting", url: null, codeUrl: null, userCode: null, message: null },
              onProgress: () => undefined,
              submitCode: async () => undefined,
              cancel: () => undefined,
              finished: Promise.resolve({ ok: true, message: null }),
            };
          },
        },
      },
    );
    const { id } = await service.startLogin("claude", "browser", MAIN);
    await vi.waitFor(async () => expect((await service.submitCode(id, "")).step).toBe("done"));
    const main = (await store.read()).accounts.find((a) => a.id === MAIN);
    expect(main).toMatchObject({ identity: "new", limitedUntil: until, limitKind: "window", limitSource: "reading" });
  });

  it("spends a reset for the new person at once, though one was just spent for the previous person", async () => {
    const until = new Date(Date.now() + 3 * 3_600_000).toISOString();
    let who = "old";
    const { service, store, paseo } = await setUp(
      { accounts: [stale as never, newAtLimit(until)], defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      hit,
      { identity: () => as(who), claude: { redeemReset: async () => ({ outcome: "reset", message: "Limits reset.", left: 0 }) } },
    );
    expect((await redeemNow(service, paseo, MAIN)).outcome).toBe("reset");
    who = "new";
    await checkIdentity(service);
    expect((await store.read()).accounts.find((a) => a.id === MAIN)?.limitedUntil).toBe(until);
    expect((await redeemNow(service, paseo, MAIN)).outcome).toBe("reset");
    expect((await store.read()).accounts.map((a) => a.limitedUntil)).toEqual([null, null]);
  });
});

describe("failover", () => {
  it("does not continue or claim a switch when a successful CLI never opens a session", async () => {
    const { store, sent, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt: "2026-09-23T07:00:00.000Z" } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your weekly limit" }),
      { reload: "no session" },
    );
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
    expect(sent).toEqual([]);
    expect(notes.at(-1)).toMatchObject({ outcome: "pending", continued: false });
    expect(notes.at(-1)?.detail).toContain("did not open a new provider session");
  });

  it("blames the CLI login for a session ZeroSub never routed, even when the agent is bound elsewhere", async () => {
    // Today's incident: the agent's session predates zerosub, and a switch to "hello" was waiting.
    const { store, reopened, sent, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
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

  it("doesn't tell an agent to continue once someone has written to it or put it away", async () => {
    // Paseo's send cancels a turn that's running and unarchives an archived agent.
    for (const meanwhile of ["writes to it", "archives it"] as const) {
      let act = async () => {};
      const { service, paseo, agent, reopened, sent, notes, limitTurn } = await setUp(
        {
          accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
          defaults: { claude: MAIN, codex: null, pi: null },
          sessions: {},
        },
        () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" }),
        { reloading: () => act() },
      );
      act = async () => {
        if (meanwhile === "writes to it") await service.onTurnStarted({ id: AGENT, provider: "claude" }, { paseo } as never);
        else (agent as { archivedAt: string | null }).archivedAt = new Date().toISOString();
      };
      await limitTurn();
      expect(reopened).toEqual([AGENT]);
      expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
      expect(sent).toHaveLength(0);
    }
  });

  it("moves on again when the next account runs out too", async () => {
    let resetsAt = inPast(); // marketing's window has already reset when hello runs out
    const { store, reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
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
        defaults: { claude: MAIN, codex: null, pi: null },
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
        defaults: { claude: MAIN, codex: null, pi: null },
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

  it("switches and continues on Claude Code's 5-hour limit notice", async () => {
    // Claude Code 2.1.312 calls the session limit the "5-hour limit" (#28). Paseo 0.12 sends the turn
    // with the hook; 0.13 and later send none, so it's read from the agent's timeline.
    const saoPaulo = new Intl.DateTimeFormat("en-GB", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (const apostrophe of ["'", "’"]) {
      for (const hookSendsTurn of [true, false]) {
        const turn: AgentTimelineItem[] = [
          { type: "user_message", text: "fix the bug" },
          { type: "assistant_message", text: `You${apostrophe}ve hit your 5-hour limit · resets 7pm (America/Sao_Paulo)` },
        ];
        const { service, store, reopened, sent, notes, paseo } = await setUp(
          {
            accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
            defaults: { claude: MAIN, codex: null, pi: null },
            bindings: {},
            sessions: {},
          },
          () => {
            throw new Error("unused: the real detector reads the turns");
          },
          { detectLimit: detectClaudeLimit, recent: inTurn("t1", ...turn) },
        );
        const before = Date.now();
        const event = { agent: { id: AGENT, provider: "claude" }, turnId: "t1", outcome: { kind: "completed" }, timeline: hookSendsTurn ? turn : [] };
        await service.onTurnEnded(event as never, { paseo } as never);
        const state = await store.read();
        expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
        expect(reopened).toEqual([AGENT]);
        expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched", continued: true });
        expect(sent).toEqual([preferences.schema.parse({}).continuePrompt]);
        // marketing is out until the next 7pm in São Paulo, whatever the daemon's own zone.
        const marketing = state.accounts.find((a) => a.id === MAIN);
        expect(marketing?.limitKind).toBe("window");
        const until = Date.parse(marketing?.limitedUntil ?? "");
        expect(saoPaulo.format(until)).toBe("19:00");
        expect(until).toBeGreaterThan(before);
        expect(until).toBeLessThanOrEqual(Date.now() + 24 * 3_600_000);
      }
    }
  });

  // Paseo 0.13 (getpaseo/paseo#7477) stopped copying the conversation into turn-ended hooks: `timeline`
  // is always `[]`. Claude reports its limits as an ordinary reply, so the plugin has to page the
  // tail of the timeline itself or it never sees them again.
  describe("when the hook arrives without the turn's timeline", () => {
    const notice = "You've hit your session limit · resets 3pm (UTC)";
    const twoAccounts = () => ({
      accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
      defaults: { claude: MAIN, codex: null, pi: null },
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
        defaults: { claude: MAIN, codex: null, pi: null },
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
        defaults: { claude: MAIN, codex: null, pi: null },
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
      { id: "auto", label: "Auto", colorTier: "moderate" },
      { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
    ],
    codex: [
      { id: "auto", label: "Default Permissions", colorTier: "moderate" },
      { id: "full-access", label: "Full Access", colorTier: "dangerous" },
    ],
  };

  /** `conversation` is the agent's timeline, which Paseo pages from its tail. `others` are the host's other agents. */
  async function setUpFork(
    modeId: string,
    conversation: readonly Row[] = [],
    labels: Record<string, string> = {},
    others: Array<Record<string, unknown>> = [],
    options: {
      prefs?: Record<string, unknown>;
      /** What `listAvailable` answers for OpenCode; omitted when the host has none. */
      opencodeAvailable?: boolean;
      /** What `listModels` answers for OpenCode. */
      catalog?: Array<Record<string, unknown>>;
      /** A failed `listModels` answer, which carries `error` instead of throwing. */
      catalogError?: string;
      /** OpenCode's modes. */
      opencodeModes?: Array<{ id: string; label: string; colorTier?: string }>;
      /** No ChatGPT account is configured at all. */
      noChatGPT?: boolean;
      /** The source agent's status, for refusals the manual path checks before anything else. */
      sourceStatus?: string;
      /** The source agent's provider, for a source outside the Claude family. */
      sourceProvider?: string;
    } = {},
  ) {
    const store = new StateStore(join(root, "state.json"));
    /** Seams for the network boundary: a test can act between reads, or make a send or read throw. */
    const hooks: {
      onRefetch?: (id: string) => void;
      onRefresh?: (id: string) => void;
      onModes?: (provider: string) => void;
      send?: (id: string, text: string, messageId: string | undefined) => void;
      createdStatus?: string;
      /** Paseo 0.9.1 to 0.10.3: refreshing an agent it doesn't know throws instead of answering null. */
      unknownThrows?: boolean;
      /** Makes every create fail with this message, after Paseo has recorded its request. */
      createError?: string;
      /** Makes every create throw this client-side error, with no answer from Paseo. */
      clientError?: string;
      /** The daemon stops mid-create: the client fails with no answer, and Paseo keeps the key's outcome unknown. */
      lostCreate?: boolean;
    } = {};
    /** Paseo's creation receipts: each idempotency key's first request fingerprint. */
    const receipts = new Map<string, string>();
    /** Keys whose create Paseo lost mid-run: it answers them with the same failed snapshot for good. */
    const unknownKeys = new Set<string>();
    const fingerprintOf = (value: unknown) =>
      JSON.stringify(value, (_key, entry) =>
        entry && typeof entry === "object" && !Array.isArray(entry) ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry,
      );
    await store.update((draft) =>
      Object.assign(draft, {
        accounts: options.noChatGPT
          ? [account(MAIN, "marketing", "main")]
          : [account(MAIN, "marketing", "main"), { ...account(CODEX_MAIN, "hello", "main"), family: "codex" }],
        defaults: { claude: MAIN, codex: options.noChatGPT ? null : CODEX_MAIN, pi: null },
      }),
    );
    const source = {
      id: AGENT,
      provider: options.sourceProvider ?? "claude",
      status: options.sourceStatus ?? "idle",
      title: "Fix the build",
      model: "claude-opus-5-5",
      currentModeId: modeId,
      workspaceId: "ws-1",
      archivedAt: null,
      lastUserMessageAt: "2026-09-23T07:00:00.000Z",
      labels,
    };
    /** Every timeline read, so tests can count how many pages a check needed. */
    const timelineReads: Array<{ id: string; direction?: string }> = [];
    const epochOf = (id: string) => (id === AGENT ? sourceEpoch : "epoch-1");
    const agents: Array<Record<string, unknown>> = [source, ...others];
    const byId = new Map(agents.map((agent) => [agent.id as string, agent]));
    const created: Array<{ agentId: string; workspaceId?: string; idempotencyKey?: string; config: { provider: string; modeId?: string }; title: string; prompt?: string; labels: Record<string, string> }> = [];
    const notes: Array<{ to: string; outcome: string; toFamily: string | null; toProvider: string | null; delivery?: string; detail: string | null; continuedIn: { agentId: string } | null }> = [];
    /** Every prompt the plugin sent, and the message ID it was sent under. */
    const sends: Array<{ agentId: string; text: string; messageId?: string }> = [];
    /** Per-agent timelines in Paseo's canonical projection; the fake tags every turn it accepts. */
    const timelines = new Map<string, Array<{ item: AgentTimelineItem; turnId?: string; seqEnd: number }>>();
    let seq = 0;
    const setTimeline = (id: string, rows: readonly Row[]) =>
      timelines.set(id, rows.map((row) => ({ ...row, seqEnd: ++seq })));
    setTimeline(AGENT, conversation);
    /** Adds one turn to an agent's timeline, as Paseo would when the user types. */
    const addTurn = (id: string, item: AgentTimelineItem, clientMessageId?: string) => {
      const rows = timelines.get(id) ?? [];
      const entry = clientMessageId && item.type === "user_message" ? { ...item, clientMessageId } : item;
      rows.push({ item: entry, turnId: `turn-${++seq}`, seqEnd: ++seq });
      timelines.set(id, rows);
    };
    /** Makes the next source read fail, as a history gap does; `fork` gaps every other timeline. */
    const gap = { source: false, fork: false };
    let sourceEpoch = "epoch-1";
    const modes: Record<string, Array<{ id: string; label: string; colorTier?: string }>> = {
      ...MODES,
      opencode: options.opencodeModes ?? [
        // Paseo's real OpenCode catalog.
        { id: "build", label: "Build", colorTier: "moderate" },
        { id: "plan", label: "Plan", colorTier: "planning" },
      ],
    };
    const models: Record<string, Array<Record<string, unknown>>> = {
      claude: [{ id: "claude-opus-5-5", isDefault: true }],
      codex: [{ id: "gpt-5.6-sol", isDefault: true }],
      opencode: options.catalog ?? [
        { id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }] },
      ],
    };
    const available = [{ provider: "claude", available: true }, { provider: "codex", available: true }];
    if (options.opencodeAvailable !== false) available.push({ provider: "opencode", available: true });
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      providers: {
        listAvailable: async () => ({ providers: available }),
        listModes: async (provider: string) => {
          hooks.onModes?.(provider);
          return { modes: modes[provider] };
        },
        listModels: async (provider: string) => (provider === "opencode" && options.catalogError ? { error: options.catalogError } : { models: models[provider] }),
      },
      workspaces: {
        ref: (workspaceId: string) => ({
          agents: {
            create: async ({
              onEvent,
              ...request
            }: (typeof created)[number] & { onEvent?: (snapshot: { phase: string; error: string | null; outcomeUnknown?: boolean }) => void }) => {
              // The client fails on its own, as on "Daemon client closed": Paseo's answer is never seen.
              if (hooks.clientError) throw new Error(hooks.clientError);
              // Paseo ties an idempotency key to its first request, failed or not: the same key with
              // another request is refused, and the same request again doesn't make a second agent.
              if (request.idempotencyKey) {
                const { idempotencyKey: _key, ...intent } = request;
                const fingerprint = fingerprintOf({ ...intent, workspaceId });
                const first = receipts.get(request.idempotencyKey);
                if (first !== undefined && first !== fingerprint) throw new Error("agent_request_key_conflict");
                receipts.set(request.idempotencyKey, fingerprint);
                if (byId.has(request.agentId)) return;
                if (hooks.lostCreate) {
                  unknownKeys.add(request.idempotencyKey);
                  throw new Error("Daemon client closed");
                }
                if (unknownKeys.has(request.idempotencyKey)) {
                  onEvent?.({ phase: "failed", error: "agent_request_outcome_unknown", outcomeUnknown: true });
                  throw new Error("agent_request_outcome_unknown");
                }
              }
              if (hooks.createError) {
                // Paseo answers with its failed creation result, which the client throws as its error.
                onEvent?.({ phase: "failed", error: hooks.createError });
                throw new Error(hooks.createError);
              }
              created.push({ ...request, workspaceId });
              const agent = {
                id: request.agentId,
                provider: request.config.provider.split("/")[0],
                status: hooks.createdStatus ?? "idle",
                currentModeId: request.config.modeId,
                title: request.title,
                workspaceId,
                archivedAt: null,
                labels: request.labels,
              };
              agents.push(agent);
              byId.set(agent.id, agent);
            },
          },
        }),
      },
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
        ref: (id: string) => ({
          refresh: async () => {
            hooks.onRefresh?.(id);
            if (hooks.unknownThrows && !byId.has(id)) throw new Error(`Agent not found: ${id}`);
            return { agent: byId.get(id) ?? null };
          },
          send: async (text: string, options: { messageId?: string } = {}) => {
            if (hooks.send) return hooks.send(id, text, options.messageId);
            sends.push({ agentId: id, text, messageId: options.messageId });
            addTurn(id, { type: "user_message", text }, options.messageId);
          },
          timeline: {
            append: async (item: { type: "plugin"; id: string; kind: string; version: number; data: (typeof notes)[number] }) => {
              notes.push(item.data);
              addTurn(id, { ...item, pluginId: "zerosub" } as AgentTimelineItem);
            },
            refetch: async (options: { direction?: string; cursor?: { epoch: string; seq: number } | null; limit?: number } = {}) => {
              timelineReads.push({ id, direction: options.direction });
              hooks.onRefetch?.(id);
              if ((gap.source && id === AGENT) || (gap.fork && id !== AGENT)) {
                return { entries: [], gap: true, staleCursor: false, epoch: epochOf(id), window: { maxSeq: 0 }, hasOlder: false, startCursor: null };
              }
              const rows = timelines.get(id) ?? [];
              const limit = options.limit ?? 500;
              const older = options.direction === "before" && options.cursor ? rows.filter((row) => row.seqEnd < options.cursor!.seq) : rows;
              const page = older.slice(-limit);
              return {
                entries: page,
                gap: false,
                staleCursor: false,
                epoch: epochOf(id),
                window: { maxSeq: rows.reduce((max, row) => Math.max(max, row.seqEnd), 0) },
                hasOlder: older.length > page.length,
                startCursor: page.length ? { epoch: epochOf(id), seq: page[0]!.seqEnd } : null,
              };
            },
          },
        }),
      },
    };
    const service = new Service(
      {
        claude: claudeAdapter(() => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" })),
        codex: { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), family: "codex", portable: false } as FamilyAdapter,
        pi: absentPi(),
      },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo", reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    );
    services.push(service);
    service.setPreferences(preferences.schema.parse({ forkOtherProvider: true, ...options.prefs }));
    const context = { paseo } as never;
    const limitTurn = () =>
      service.onTurnEnded(
        { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
        context,
      );
    return { service, store, created, notes, limitTurn, paseo: paseo as never, context, sends, timelines, addTurn, gap, byId, agents, hooks, setSourceEpoch: (epoch: string) => { sourceEpoch = epoch; }, timelineReads };
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

  it("opens a ChatGPT fork on a limited subscription with a usable banked reset before a paid Azure account", async () => {
    const prefs = { paidApiFallback: true, autoRedeem: true };
    const limit = { limitedUntil: inFuture(), limitKind: "window" as const, limitedAt: new Date().toISOString() };
    const reading = (usableNow: boolean) => ({
      fetchedAt: new Date().toISOString(), windows: [{ id: "primary", label: "5-hour", usedPercent: 100, resetsAt: null, minutes: 300 }],
      error: null, cached: false, credits: null, resets: { available: 1, usableNow, blockedReason: null, expiresAt: null, refills: [], label: null },
    });
    for (const usableNow of [true, false]) {
      const { service, store, created, notes, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], { prefs });
      await store.update((draft) => {
        Object.assign(draft.accounts.find((entry) => entry.id === CODEX_MAIN)!, limit);
        draft.accounts.push({ ...account("azure", "Azure", "managed"), family: "codex", auth: "api", provider: "azure" } as never);
      });
      (service as unknown as { usage: Map<string, unknown> }).usage.set(CODEX_MAIN, reading(usableNow));
      await limitTurn();
      expect(created).toHaveLength(1);
      const bound = (await store.read()).bindings[created[0]?.agentId ?? ""]?.accountId;
      // A usable reset is free, and the fork's first turn spends it; without one, the paid account takes the fork and its note says so.
      expect(bound).toBe(usableNow ? CODEX_MAIN : "azure");
      expect(notes.at(-1)?.detail ?? null).toEqual(usableNow ? null : expect.stringMatching(/Azure OpenAI, a paid API/));
    }
  });

  describe("a ChatGPT chat continued on Claude that lands on AWS Bedrock", () => {
    const BEDROCK = "claude-bedrock";
    const KEY = "claude-key";
    /**
     * Every subscription out, paid fallback on: a ChatGPT agent's limit continues it on Claude, on Bedrock
     * or, given `onto`, on a Claude key on Anthropic's own API.
     */
    async function forkOntoBedrock(by: "auto" | "user", onto: "bedrock" | "key" = "bedrock") {
      const t = await setUpFork("full-access", [], {}, [], { prefs: { paidApiFallback: true }, sourceProvider: "codex" });
      const limit = { limitedUntil: inFuture(), limitKind: "window" as const, limitedAt: new Date().toISOString() };
      await t.store.update((draft) => {
        for (const entry of draft.accounts) Object.assign(entry, limit);
        draft.accounts.push(
          (onto === "bedrock"
            ? { ...account(BEDROCK, "bedrock", "managed"), auth: "api", provider: "bedrock", identity: "bedrock|eu-central-1|host" }
            : { ...account(KEY, "key", "managed"), auth: "api", identity: "api|anthropic|0123456789abcdef" }) as never,
        );
        draft.sessions[AGENT] = { accountId: CODEX_MAIN, family: "codex", openedAt: new Date().toISOString() };
      });
      if (by === "auto") {
        await t.service.onTurnEnded(
          { agent: { id: AGENT, provider: "codex" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
          { paseo: t.paseo } as never,
        );
      } else {
        await t.service.forkAgent(t.paseo, AGENT);
      }
      expect(t.created).toHaveLength(1);
      const forkId = t.created[0]!.agentId;
      expect(t.created[0]!.config.provider.startsWith("claude")).toBe(true);
      // Its session opens where it was bound.
      await t.service.onSessionOpen({ agentId: forkId, provider: "claude", reason: "create", purpose: "interactive", env: {}, workspaceId: "ws-1", cwd: root } as never, { paseo: t.paseo } as never);
      expect((await t.store.read()).sessions[forkId]?.accountId).toBe(onto === "bedrock" ? BEDROCK : KEY);
      return { ...t, forkId };
    }

    /** Alignment's pass once the agent has been quiet a while, with the Claude subscription back. */
    async function alignWithRoom(t: Awaited<ReturnType<typeof forkOntoBedrock>>) {
      await t.service.clearLimit(MAIN);
      // Paseo's reload opens the agent's next session, which routing places.
      const reopener = (t.service as unknown as { reopener: { reopen: (id: string) => Promise<{ ok: true }> } }).reopener;
      reopener.reopen = async (id: string) => {
        await t.service.onSessionOpen({ agentId: id, provider: "claude", reason: "refresh", purpose: "interactive", env: {}, workspaceId: "ws-1", cwd: root } as never, { paseo: t.paseo } as never);
        return { ok: true as const };
      };
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
      try {
        return await t.service.alignSessions(t.paseo);
      } finally {
        vi.useRealTimers();
      }
    }

    it.each(["auto", "user"] as const)("isn't pinned there (fork asked for by %s), and moves back once a Claude subscription has room", async (by) => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const t = await forkOntoBedrock(by);
      // ZeroSub's own choice, not the user's: it only holds while no subscription can take the agent.
      expect((await t.store.read()).bindings[t.forkId]).toMatchObject({ accountId: BEDROCK, source: "auto" });
      expect(t.notes.at(-1)?.detail).toMatch(/It moves back to a Claude account once one has room/);
      expect((await t.service.view(t.paseo)).agents.find((route) => route.agentId === t.forkId)).toMatchObject({ accountId: BEDROCK, pendingAccountId: null });
      const summary = await alignWithRoom(t);
      expect(summary.reopened).toEqual([t.forkId]);
      expect((await t.store.read()).sessions[t.forkId]?.accountId).toBe(MAIN);
      expect(t.notes.at(-1)).toMatchObject({ reason: "room", to: "marketing" });
    });

    it.each(["auto", "user"] as const)(
      "on a Claude key instead (fork asked for by %s), still moves back once a Claude subscription has room after the setting is turned off",
      async (by) => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const t = await forkOntoBedrock(by, "key");
        // Marked as ZeroSub's own doing: with the setting off the key is no stand-in, so the mark is what's left.
        expect((await t.store.read()).bindings[t.forkId]).toMatchObject({ accountId: KEY, source: "auto", standIn: true });
        t.service.setPreferences(preferences.schema.parse({ forkOtherProvider: true }));
        const summary = await alignWithRoom(t);
        expect(summary.reopened).toEqual([t.forkId]);
        expect((await t.store.read()).sessions[t.forkId]?.accountId).toBe(MAIN);
        expect(t.notes.at(-1)).toMatchObject({ reason: "room", to: "marketing" });
      },
    );

    it("stays when the user has since picked Bedrock for it", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const t = await forkOntoBedrock("auto");
      await t.store.update((draft) => {
        draft.bindings[t.forkId] = { accountId: BEDROCK, source: "user", at: new Date().toISOString() };
      });
      const summary = await alignWithRoom(t);
      expect(summary.reopened).toEqual([]);
      expect((await t.store.read()).sessions[t.forkId]?.accountId).toBe(BEDROCK);
      expect((await t.service.view(t.paseo)).agents.find((route) => route.agentId === t.forkId)?.accountId).toBe(BEDROCK);
    });
  });

  it.each([
    ["its parent", [], "lead"],
    ["where its parent's own work went on ChatGPT", [{ id: "lead-on-chatgpt", provider: "codex", labels: { "zerosub.continued-from": "lead" } }], "lead-on-chatgpt"],
  ])("carries a sub-agent's work on as a sub-agent of %s", async (_, moved, parent) => {
    const lead = { id: "lead", provider: "claude", status: "idle", title: "Lead the release", workspaceId: "ws-1", archivedAt: null, labels: {} };
    const others = [lead, ...moved.map((agent) => ({ status: "idle", title: "Lead the release (continued on ChatGPT)", workspaceId: "ws-1", archivedAt: null, ...agent }))];
    const { created, limitTurn } = await setUpFork("bypassPermissions", [], { "paseo.parent-agent-id": "lead" }, others);
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(created[0]?.labels).toEqual({ "zerosub.continued-from": AGENT, "paseo.parent-agent-id": parent });
    expect(created[0]?.prompt).toMatch(/earlier Claude Code session that stopped because every Claude account reached its usage limit/);
  });

  it("points at the earlier fork instead of starting another", async () => {
    const { created, notes, limitTurn } = await setUpFork("bypassPermissions");
    await limitTurn();
    await limitTurn();
    expect(created).toHaveLength(1);
    expect(notes.at(-1)).toMatchObject({ outcome: "continued", continuedIn: { agentId: created[0]?.agentId } });
  });

  it("records one pending placement for a fork with balancing on, as the fork opens", async () => {
    const { service, created, limitTurn, context } = await setUpFork("bypassPermissions", [], {}, [], { prefs: { balanceNewAgents: true } });
    await limitTurn();
    expect(pendingOn(service, CODEX_MAIN)).toBe(0);
    await service.onSessionOpen(
      { agentId: created[0]!.agentId, provider: "codex", reason: "create", purpose: "interactive", workspaceId: "ws-1", env: {} } as never,
      context,
    );
    expect(pendingOn(service, CODEX_MAIN)).toBe(1);
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

  it("carries an orchestrator's agent_message instructions when forking a sub-agent", async () => {
    const lead = { id: "lead", provider: "claude", status: "idle", title: "Lead the release", workspaceId: "ws-1", archivedAt: null, labels: {} };
    const agentPrompt = (id: string, text: string): AgentTimelineItem =>
      ({
        type: "tool_call",
        callId: `paseo-agent-message:${id}`,
        name: "agent_message",
        status: "completed",
        error: null,
        agentMessage: { event: "message", sender: { id: "lead", title: "Lead the release" }, text },
        detail: { type: "plain_text", text, icon: "bot" },
      }) as AgentTimelineItem;
    const conversation = [
      ...inTurn("t0", agentPrompt("m1", "Implement the parser"), { type: "assistant_message", text: "Parser skeleton ready." }),
      ...inTurn("t", agentPrompt("m2", "Now run the linter"), { type: "assistant_message", text: "You've hit your session limit · resets 3pm (UTC)" }),
    ];
    const { created, limitTurn } = await setUpFork("bypassPermissions", conversation, { "paseo.parent-agent-id": "lead" }, [lead]);
    await limitTurn();
    const prompt = created[0]?.prompt ?? "";
    expect(prompt).toContain("From Lead the release (lead): Implement the parser");
    expect(prompt).toContain("Assistant: Parser skeleton ready.");
    expect(prompt).toContain("From Lead the release (lead): Now run the linter");
    expect(prompt).not.toContain("[agent_message]");
  });

  describe("forking to OpenCode", () => {
      const PREFS = {
      forkOtherProvider: true,
      claudeForkDestination: "opencode",
      forkOpenCodeModel: "opencode/glm-5p3-flash",
      forkOpenCodeThinking: "high",
    };

    it("treats a saved Paseo 0.16 Default thinking option as the model default", async () => {
      const catalog = [
        { id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", isDefault: true, thinkingOptions: [{ id: "default", label: "Default", isDefault: true }, { id: "high", label: "High" }] },
      ];
      const { created, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], { prefs: { ...PREFS, forkOpenCodeThinking: "default" }, catalog });
      await limitTurn();
      expect(created).toHaveLength(1);
      expect(created[0]?.config).toEqual({ provider: "opencode/opencode/glm-5p3-flash", modeId: "build" });
    });

    it("continues a stopped Claude chat on OpenCode with the saved model, thinking, and no account", async () => {
      const { store, created, notes, sends, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await limitTurn();
      expect(created).toHaveLength(1);
      const fork = created[0];
      expect(fork?.config).toEqual({
        provider: "opencode/opencode/glm-5p3-flash",
        modeId: "build", // Bypass is as loose as Build gets
        thinkingOptionId: "high",
      });
      expect(fork?.title).toBe("Fix the build (continued on OpenCode)");
      expect(fork?.labels).toEqual({ "zerosub.continued-from": AGENT });
      expect(fork?.idempotencyKey).toBe(fork?.agentId);
      // The fork is created promptless; the handoff is delivered afterwards under a reserved ID.
      expect(created[0]?.prompt).toBeUndefined();
      expect(sends).toHaveLength(1);
      expect(sends[0]?.agentId).toBe(fork?.agentId);
      expect(sends[0]?.text).toMatch(/earlier Claude Code session that stopped because every Claude account reached its usage limit/);
      expect(sends[0]?.messageId).toMatch(/^zerosub-handoff-/);
      expect(sends[0]?.text).toContain(`zerosub transfer ${sends[0]?.messageId}`);
      // OpenCode is a harness, not an account provider: no binding, so no account store entry.
      expect((await store.read()).bindings[fork?.agentId ?? ""]).toBeUndefined();
      expect(notes.at(-1)).toMatchObject({
        outcome: "continued",
        to: "OpenCode",
        toFamily: null,
        toProvider: "opencode",
        continuedIn: { agentId: fork?.agentId },
      });
    });

    it("uses the host's default model, and no thinking override, when none was saved", async () => {
      const { created, limitTurn } = await setUpFork("default", [], {}, [], {
        prefs: { forkOtherProvider: true, claudeForkDestination: "opencode" },
      });
      await limitTurn();
      expect(created[0]?.config).toEqual({ provider: "opencode/opencode/glm-5p3-flash", modeId: "plan" });
    });

    it("points at the earlier OpenCode fork instead of starting another", async () => {
      const { created, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await limitTurn();
      await limitTurn();
      expect(created).toHaveLength(1);
    });

    const RESERVED = { targetId: "fork-reserved", messageId: "zerosub-handoff-reserved" };
    const MARK = { epoch: "epoch-1", seq: 0 };
    const opencodeAgent = (id: string, overrides: Record<string, unknown> = {}) => ({
      id,
      provider: "opencode",
      status: "idle",
      title: "Fix the build (continued on OpenCode)",
      currentModeId: "build",
      workspaceId: "ws-1",
      archivedAt: null,
      labels: { "zerosub.continued-from": AGENT },
      ...overrides,
    });
    const digestOf = (text: string) => createHash("sha256").update(text).digest("hex");
    const whyOf = (source: "auto" | "user") => (source === "auto" ? "every Claude account reached its usage limit" : "the work was moved to OpenCode");
    const CREATE_CONFIG = {
      provider: "opencode/opencode/glm-5p3-flash",
      modeId: "build",
      thinkingOptionId: "high",
      workspaceId: "ws-1",
      cwd: null,
      parentId: null,
      title: "Fix the build (continued on OpenCode)",
      why: whyOf("user"),
    };
    const initialDigest = (source: "auto" | "user" = "user") =>
      digestOf([continuationPrompt(buildTranscript([]), whyOf(source), "Claude Code"), `zerosub transfer ${RESERVED.messageId}`].join("\n"));
    /** A harness with an existing, settled fork record and its live target agent. */
    const setUpReuse = async (fork: Record<string, unknown> = {}, record: Omit<OpenCodeFork, "forkAgentId"> = {}) => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = { forkAgentId: RESERVED.targetId, ...record };
      });
      setup.byId.set(RESERVED.targetId, opencodeAgent(RESERVED.targetId, fork));
      return setup;
    };
    const seededPending = (pending: NonNullable<OpenCodeFork["pending"]>): OpenCodeFork => ({
      forkAgentId: RESERVED.targetId,
      pending,
    });
    const reservedCreation = (source: "auto" | "user" = "user", sentDigest = initialDigest(source)): OpenCodeFork =>
      seededPending({
        stage: "creating",
        targetId: RESERVED.targetId,
        messageId: RESERVED.messageId,
        seen: MARK,
        config: { ...CREATE_CONFIG, why: whyOf(source) },
        sentDigest,
      });

    it("sends new instructions to the existing fork exactly once, then nothing new on a third fork", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.limitTurn();
      expect(setup.created).toHaveLength(1);
      const forkId = setup.created[0]!.agentId;
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      await setup.limitTurn();
      expect(setup.created).toHaveLength(1);
      const updates = setup.sends.filter((send) => send.text.includes("Now also update the CHANGELOG"));
      expect(updates).toHaveLength(1);
      expect(updates[0]!.agentId).toBe(forkId);
      expect(updates[0]!.messageId).toMatch(/^zerosub-handoff-/);
      expect(updates[0]!.text).toContain(`zerosub transfer ${updates[0]!.messageId}`);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "continued", continuedIn: { agentId: forkId } });
      // Nothing new on the source: nothing is sent, and the row says so instead of claiming a handoff.
      await setup.limitTurn();
      expect(setup.sends).toHaveLength(2);
      expect(setup.notes.at(-1)).toMatchObject({
        outcome: "stayed",
        detail: "No update was sent: the OpenCode continuation already has everything from this agent.",
        continuedIn: { agentId: forkId },
      });
    });

    it("sends an agent's or a schedule's prompt after the fork as an instruction, not as progress", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.limitTurn();
      expect(setup.created).toHaveLength(1);
      const toolPrompt = (callId: string, name: string, text: string, agentMessage?: object) =>
        ({ type: "tool_call", callId, name, status: "completed", error: null, ...(agentMessage ? { agentMessage } : {}), detail: { type: "plain_text", text, icon: "bot" } }) as AgentTimelineItem;
      setup.addTurn(AGENT, toolPrompt("paseo-agent-message:m9", "agent_message", "STOP: do not push anything", {
        event: "message",
        sender: { id: "lead", title: "Lead" },
        text: "STOP: do not push anything",
      }));
      setup.addTurn(AGENT, toolPrompt("paseo-system:nightly", "heartbeat", "Run the nightly regression check"));
      await setup.limitTurn();
      const update = setup.sends.at(-1)!.text;
      const users = update.slice(update.indexOf("<user-updates>"), update.indexOf("</user-updates>"));
      const progress = update.slice(update.indexOf("<progress-updates>"), update.indexOf("</progress-updates>"));
      expect(users).toContain("STOP: do not push anything");
      expect(users).toContain("Run the nightly regression check");
      expect(progress).not.toContain("STOP: do not push anything");
      expect(progress).not.toContain("Run the nightly regression check");
    });

    /** A settled fork whose source gained only a plugin note, with `act` run once as its watermark is saved. */
    const duringWatermarkWrite = async (act: (setup: Awaited<ReturnType<typeof setUpFork>>) => void) => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "plugin", id: "external-note", pluginId: "synthetic", kind: "note", version: 1, data: {} });
      const inspected = setup.timelines.get(AGENT)!.at(-1)!.seqEnd;
      const save = setup.store.update.bind(setup.store);
      let done = false;
      setup.store.update = async (change) => {
        const next = await save(change);
        if (!done && next.opencodeForks[AGENT]?.seen?.seq === inspected) {
          done = true;
          act(setup);
        }
        return next;
      };
      return { setup, inspected };
    };

    it("reports an instruction that arrives while an empty update's watermark is saved, then sends it once", async () => {
      const { setup, inspected } = await duringWatermarkWrite((setup) =>
        setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2"));
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/newer message/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual({ epoch: "epoch-1", seq: inspected });
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("sent");
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("Now also update the CHANGELOG");
      expect(setup.created).toHaveLength(0);
    });

    it("reports an instruction that lands between the history recheck and the final refresh", async () => {
      const { setup, inspected } = await duringWatermarkWrite((setup) => {
        // The history recheck has nothing new; the instruction lands just before the last source refresh.
        let reads = 0;
        setup.hooks.onRefetch = (id) => {
          if (id !== AGENT || ++reads !== 1) return;
          setup.hooks.onRefresh = (refreshed) => {
            if (refreshed !== AGENT) return;
            setup.hooks.onRefresh = undefined;
            setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
            setup.byId.get(AGENT)!.lastUserMessageAt = "2026-09-23T07:30:00.000Z";
          };
        };
      });
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/newer message/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen?.seq).toBe(inspected);
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("sent");
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("Now also update the CHANGELOG");
    });

    it("refuses up-to-date when the source starts working while the watermark is saved", async () => {
      const { setup, inspected } = await duringWatermarkWrite((setup) => { setup.byId.get(AGENT)!.status = "running"; });
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/working or waiting for permission/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen?.seq).toBe(inspected);
    });

    it.each([
      ["a history gap", "gap", /couldn't read this agent's handoff history/],
      ["an epoch reset", "epoch", /couldn't tell what it has already received/],
    ])("calls %s while the watermark is saved an inspection, not up-to-date", async (_, kind, detail) => {
      const { setup, inspected } = await duringWatermarkWrite((setup) => {
        if (kind === "gap") setup.gap.source = true;
        else setup.setSourceEpoch("epoch-2");
      });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("found");
      expect(setup.notes.at(-1)?.detail).toMatch(detail);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen?.seq).toBe(inspected);
    });

    it("never sends to a recorded fork that names a different source", async () => {
      const setup = await setUpReuse({ labels: { "zerosub.continued-from": "different-source" } }, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved/);
      expect(setup.sends).toHaveLength(0);
    });

    it("advances past plugin-only notes without sending an empty update or feeding a repeat", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, {
        type: "plugin",
        id: "external-note",
        pluginId: "synthetic",
        kind: "note",
        version: 1,
        data: {},
      });
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("up-to-date");
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("up-to-date");
      expect(setup.sends).toHaveLength(0);
      expect(setup.timelines.get(AGENT)).toHaveLength(3);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual({
        epoch: "epoch-1",
        seq: setup.timelines.get(AGENT)!.at(-2)!.seqEnd,
      });
      expect(setup.notes).toHaveLength(2);
      expect(setup.notes.every((note) => note.delivery === "up-to-date")).toBe(true);
    });

    it("returns an inspection result instead of replaying history after a source epoch reset", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "OLD already sent" });
      setup.setSourceEpoch("epoch-2");
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("found");
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", delivery: "found" });
      expect(setup.notes.at(-1)?.detail).toMatch(/couldn't tell what it has already received/);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual(MARK);
    });

    it("retries a lost create acknowledgement with the same target, idempotency key, and message ID", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = reservedCreation();
      });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.agentId).toBe(RESERVED.targetId);
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]).toMatchObject({
        agentId: RESERVED.targetId,
        idempotencyKey: RESERVED.targetId,
        title: CREATE_CONFIG.title,
        config: { provider: CREATE_CONFIG.provider, modeId: CREATE_CONFIG.modeId, thinkingOptionId: CREATE_CONFIG.thinkingOptionId },
        labels: { "zerosub.continued-from": AGENT },
      });
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.messageId).toBe(RESERVED.messageId);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("retries a lost create on Paseo 0.9.1 to 0.10.3, where refreshing the absent target throws", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      setup.hooks.unknownThrows = true;
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = reservedCreation();
      });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.agentId).toBe(RESERVED.targetId);
      expect(setup.created).toHaveLength(1);
      expect(setup.sends.map((send) => send.messageId)).toEqual([RESERVED.messageId]);
    });

    const KIMI_CATALOG = [
      { id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }] },
      { id: "opencode/kimi-k3", label: "Kimi K3", thinkingOptions: [{ id: "high", label: "High" }] },
    ];

    it("starts a failed create again under new IDs once its model or title changed", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS, catalog: KIMI_CATALOG });
      setup.hooks.createError = "GLM is down";
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/GLM is down/);
      delete setup.hooks.createError;
      const reserved = (await setup.store.read()).opencodeForks[AGENT]!.pending!;
      expect(reserved.createFailed).toBe(true);
      setup.service.setPreferences(preferences.schema.parse({ ...PREFS, forkOpenCodeModel: "opencode/kimi-k3" }));
      setup.byId.get(AGENT)!.title = "Fix the build and the tests";
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("sent");
      // Paseo keeps the failed request under its key, so a changed request needs a key of its own.
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]).toMatchObject({
        title: "Fix the build and the tests (continued on OpenCode)",
        config: { provider: "opencode/opencode/kimi-k3" },
      });
      expect(setup.created[0]!.agentId).not.toBe(reserved.targetId);
      expect(setup.created[0]!.idempotencyKey).toBe(setup.created[0]!.agentId);
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.messageId).not.toBe(reserved.messageId);
      const record = (await setup.store.read()).opencodeForks[AGENT]!;
      expect(record.forkAgentId).toBe(setup.created[0]!.agentId);
      expect(record.pending).toBeUndefined();
    });

    it("retries a failed create unchanged under the same target and message IDs", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      setup.hooks.createError = "GLM is down";
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/GLM is down/);
      delete setup.hooks.createError;
      const reserved = (await setup.store.read()).opencodeForks[AGENT]!.pending!;
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.agentId).toBe(reserved.targetId);
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]).toMatchObject({ agentId: reserved.targetId, idempotencyKey: reserved.targetId });
      expect(setup.sends.map((send) => send.messageId)).toEqual([reserved.messageId]);
    });

    it("keeps a create's outcome unknown when the client fails before Paseo answers", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS, catalog: KIMI_CATALOG });
      setup.hooks.clientError = "Daemon client closed";
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/Daemon client closed/);
      delete setup.hooks.clientError;
      const reserved = (await setup.store.read()).opencodeForks[AGENT]!.pending!;
      expect(reserved.createFailed).toBeUndefined();
      // The daemon may still finish that create, so a changed pick must not mint new IDs.
      setup.service.setPreferences(preferences.schema.parse({ ...PREFS, forkOpenCodeModel: "opencode/kimi-k3" }));
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]).toMatchObject({ agentId: reserved.targetId, config: { provider: "opencode/opencode/glm-5p3-flash" } });
    });

    it("starts again under new IDs once Paseo answers a lost create's key with outcome unknown", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      setup.hooks.lostCreate = true;
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/Daemon client closed/);
      delete setup.hooks.lostCreate;
      const reserved = (await setup.store.read()).opencodeForks[AGENT]!.pending!;
      // The reserved request goes again; Paseo keeps that key failed for good, so it can never land.
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/agent_request_outcome_unknown/);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toMatchObject({ targetId: reserved.targetId, createFailed: true });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("sent");
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]!.agentId).not.toBe(reserved.targetId);
      expect(setup.created[0]!.idempotencyKey).toBe(setup.created[0]!.agentId);
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.messageId).not.toBe(reserved.messageId);
    });

    it("marks a create failed when Paseo refuses its key for another request", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      setup.hooks.createError = "GLM is down";
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/GLM is down/);
      delete setup.hooks.createError;
      // An outcome-unknown reservation whose frozen request no longer matches Paseo's record of the key.
      await setup.store.update((draft) => {
        const pending = draft.opencodeForks[AGENT]!.pending!;
        delete pending.createFailed;
        pending.config!.title = "Another title";
      });
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/agent_request_key_conflict/);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending!.createFailed).toBe(true);
    });

    it("retries a create interrupted before its outcome was seen with the reserved request, not the new model pick", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS, catalog: KIMI_CATALOG });
      setup.hooks.createError = "GLM is down";
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/GLM is down/);
      delete setup.hooks.createError;
      // The service stopped before it saw the rejection: Paseo has the request, the record doesn't know how it ended.
      await setup.store.update((draft) => {
        delete draft.opencodeForks[AGENT]!.pending!.createFailed;
      });
      const reserved = (await setup.store.read()).opencodeForks[AGENT]!.pending!;
      setup.service.setPreferences(preferences.schema.parse({ ...PREFS, forkOpenCodeModel: "opencode/kimi-k3" }));
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("sent");
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]).toMatchObject({
        agentId: reserved.targetId,
        idempotencyKey: reserved.targetId,
        title: "Fix the build (continued on OpenCode)",
        config: { provider: "opencode/opencode/glm-5p3-flash", modeId: "build", thinkingOptionId: "high" },
      });
      expect(setup.sends.map((send) => send.messageId)).toEqual([reserved.messageId]);
    });

    const damage = {
      "the registry is not JSON": "{ not json",
      "the source's record doesn't validate": JSON.stringify({ accounts: [], opencodeForks: { [AGENT]: { forkAgentId: 7 } } }),
    };
    const targets = {
      "absent": [] as Array<Record<string, unknown>>,
      "archived": [opencodeAgent(RESERVED.targetId, { archivedAt: "2026-09-23T08:00:00.000Z" })],
    };
    describe.each(Object.entries(damage))("after a restart where %s", (name, broken) => {
      // An unreadable registry holds only the sources Paseo still lists an OpenCode continuation for.
      const held = name === "the registry is not JSON" ? { archived: targets.archived } : targets;
      /** A reservation is unconfirmed when the registry breaks; the restarted service can't see it. */
      const restart = async (target: Array<Record<string, unknown>>) => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await setUpReuse(
          {},
          seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf("unconfirmed") }),
        );
        await writeFile(join(root, "state.json"), broken);
        return setUpFork("bypassPermissions", [], {}, target, { prefs: PREFS });
      };

      it.each(Object.entries(held))("never forks again on its own when the reserved target is %s", async (_, target) => {
        const second = await restart(target);
        await second.limitTurn();
        expect(second.created).toHaveLength(0);
        expect(second.sends).toHaveLength(0);
        expect(second.notes.at(-1)).toMatchObject({ outcome: "stayed" });
        expect(second.notes.at(-1)?.detail).toMatch(/record of what it sent to OpenCode/);
      });

      it.each(Object.entries(held))("asks before a manual fork when the reserved target is %s, then starts one", async (_, target) => {
        const second = await restart(target);
        await expect(second.service.forkAgent(second.paseo, AGENT, "opencode")).rejects.toThrow(/choose Continue on OpenCode again/);
        expect(second.created).toHaveLength(0);
        expect(second.sends).toHaveLength(0);
        await second.service.forkAgent(second.paseo, AGENT, "opencode");
        expect(second.created).toHaveLength(1);
        expect(second.sends).toHaveLength(1);
      });
    });

    it("settles a recovered registry's global hold, so an agent with no OpenCode continuation forks automatically", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await writeFile(join(root, "state.json"), "{ not json");
      // Another agent's OpenCode continuation, whose record went with the damaged registry.
      const older = opencodeAgent("oc-older", { labels: { "zerosub.continued-from": "agent-older" } });
      const second = await setUpFork("bypassPermissions", [], {}, [older], { prefs: PREFS });
      expect(Object.keys((await second.store.read()).opencodeHolds)).toEqual(["*"]);
      await second.limitTurn();
      expect(second.created).toHaveLength(1);
      expect(second.sends).toHaveLength(1);
      // Only the agent whose continuation is listed keeps a hold; the global one is gone.
      expect(Object.keys((await second.store.read()).opencodeHolds)).toEqual(["agent-older"]);
    });

    describe("a global hold that can't be settled", () => {
      const holdAndFork = async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
        await writeFile(join(root, "state.json"), "{ not json");
        return setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      };

      it("keeps the hold when the agent list can't be read", async () => {
        const second = await holdAndFork();
        (second.paseo as { agents: { list: unknown } }).agents.list = async () => {
          throw new Error("Not connected");
        };
        await expect(second.service.forkAgent(second.paseo, AGENT, "opencode")).rejects.toThrow("Not connected");
        expect(second.created).toHaveLength(0);
        expect(Object.keys((await second.store.read()).opencodeHolds)).toEqual(["*"]);
      });

      it("keeps the hold when the agent list is incomplete", async () => {
        const second = await holdAndFork();
        (second.paseo as { agents: { list: unknown } }).agents.list = async () => ({ entries: [], pageInfo: { hasMore: true, nextCursor: "more" } });
        await second.service.forkAgent(second.paseo, AGENT, "opencode").catch(() => undefined);
        expect(Object.keys((await second.store.read()).opencodeHolds)).toContain("*");
        expect(second.created).toHaveLength(0);
      });
    });

    /** Runs `change` when `continueInNewAgent` itself refreshes the source, after every earlier check. */
    const atHelperRefresh = (setup: Awaited<ReturnType<typeof setUpFork>>, change: (source: Record<string, unknown>) => void) => {
      setup.hooks.onRefresh = (id) => {
        if (id === AGENT && new Error().stack?.includes("continueInNewAgent")) change(setup.byId.get(AGENT)!);
      };
    };

    it("repeats a reserved create with its frozen title even when the source is renamed at the create", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => { draft.opencodeForks[AGENT] = reservedCreation(); });
      atHelperRefresh(setup, (source) => { source.title = "Other task"; });
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode").catch(() => undefined);
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]).toMatchObject({
        agentId: RESERVED.targetId,
        idempotencyKey: RESERVED.targetId,
        workspaceId: CREATE_CONFIG.workspaceId,
        title: CREATE_CONFIG.title,
        config: { provider: CREATE_CONFIG.provider, modeId: CREATE_CONFIG.modeId, thinkingOptionId: CREATE_CONFIG.thinkingOptionId },
      });
    });

    it("refuses a reserved create when the source moves workspace at the create, instead of changing it", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => { draft.opencodeForks[AGENT] = reservedCreation(); });
      atHelperRefresh(setup, (source) => { source.workspaceId = "ws-2"; });
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved/);
      expect(setup.created).toHaveLength(0);
      const pending = (await setup.store.read()).opencodeForks[AGENT]!.pending;
      expect(pending?.stage).toBe("creating");
      // Its outcome is still unknown: only the frozen request may go out under its key.
      expect(pending?.createFailed).toBeUndefined();
    });

    it("starts a fresh create again when the source moved before the create was sent", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      atHelperRefresh(setup, (source) => { source.workspaceId = "ws-2"; });
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved/);
      expect(setup.created).toHaveLength(0);
      const first = (await setup.store.read()).opencodeForks[AGENT]!.pending!;
      expect(first.createFailed).toBe(true);
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("sent");
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]).toMatchObject({ workspaceId: "ws-2" });
      expect(setup.created[0]!.agentId).not.toBe(first.targetId);
    });

    it("keeps a failed create's reservation retryable when the source moves before it is sent again", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = reservedCreation();
        draft.opencodeForks[AGENT].pending!.createFailed = true;
      });
      atHelperRefresh(setup, (source) => { source.workspaceId = "ws-2"; });
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved/);
      expect(setup.created).toHaveLength(0);
      const pending = (await setup.store.read()).opencodeForks[AGENT]!.pending!;
      expect(pending.targetId).toBe(RESERVED.targetId);
      expect(pending.createFailed).toBe(true);
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("sent");
      expect(setup.created).toHaveLength(1);
      expect(setup.created[0]!.agentId).not.toBe(RESERVED.targetId);
    });

    it.each([
      ["a history gap before the write", 2, "gap"],
      ["a history gap after the write", 3, "gap"],
      ["an epoch reset before the write", 2, "epoch"],
      ["an epoch reset after the write", 3, "epoch"],
    ])("calls %s on an update an inspection, not a newer message", async (_, read, kind) => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      let reads = 0;
      setup.hooks.onRefetch = (id) => {
        if (id !== AGENT || ++reads !== read) return;
        if (kind === "gap") setup.gap.source = true;
        else setup.setSourceEpoch("epoch-2");
      };
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("found");
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)?.detail).not.toMatch(/newer message/);
      expect(setup.notes.at(-1)?.detail).toMatch(kind === "gap" ? /couldn't read this agent's handoff history/ : /couldn't tell what it has already received/);
      const record = (await setup.store.read()).opencodeForks[AGENT]!;
      expect(record.seen).toEqual(MARK);
      expect(record.pending).toBeUndefined();
    });

    it.each([
      ["before the write", 3],
      ["after the write", 4],
    ])("keeps a creation reserved and uncertain on a history gap %s", async (_, read) => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      let reads = 0;
      setup.hooks.onRefetch = (id) => {
        if (id === AGENT && ++reads === read) setup.gap.source = true;
      };
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed" });
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
    });

    /** Rewrites the registry file as a restart would find it. */
    const editRegistry = async (edit: (raw: Record<string, Record<string, unknown>>) => void) => {
      const raw = JSON.parse(await readFile(join(root, "state.json"), "utf8"));
      edit(raw);
      await writeFile(join(root, "state.json"), JSON.stringify(raw));
    };

    it("keeps holding a source when its hold is corrupted before a second restart", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await setUpReuse({}, seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: "d" }));
      await writeFile(join(root, "state.json"), "{ not json");
      await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS }); // the first restart records the hold
      await editRegistry((raw) => { raw.opencodeHolds = { [AGENT]: { at: 7 } }; });
      const third = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await third.limitTurn();
      expect(third.created).toHaveLength(0);
      expect(third.sends).toHaveLength(0);
      expect(third.notes.at(-1)?.detail).toMatch(/record of what it sent to OpenCode/);
    });

    it("asks again after a second loss, even though the first one was acknowledged", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await setUpReuse({}, seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: "d" }));
      await editRegistry((raw) => { raw.opencodeForks = { [AGENT]: { forkAgentId: 7 } }; });
      const first = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await expect(first.service.forkAgent(first.paseo, AGENT, "opencode")).rejects.toThrow(/choose Continue on OpenCode again/);
      await first.service.forkAgent(first.paseo, AGENT, "opencode");
      expect(first.created).toHaveLength(1);
      // The new record is lost too: that is a new event the first acknowledgement doesn't cover.
      await editRegistry((raw) => { raw.opencodeForks = { [AGENT]: { forkAgentId: 7 } }; });
      const second = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await expect(second.service.forkAgent(second.paseo, AGENT, "opencode")).rejects.toThrow(/choose Continue on OpenCode again/);
      expect(second.created).toHaveLength(0);
      expect(second.sends).toHaveLength(0);
    });

    it.each(Object.entries(targets))("never replaces a fork whose record has no checkpoint when the target is %s", async (_, target) => {
      const setup = await setUpFork("bypassPermissions", [], {}, target, { prefs: PREFS });
      await setup.store.update((draft) => { draft.opencodeForks[AGENT] = { forkAgentId: RESERVED.targetId }; });
      await setup.limitTurn();
      expect(setup.created).toHaveLength(0);
      expect(setup.sends).toHaveLength(0);
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/choose Continue on OpenCode again/);
      expect(setup.created).toHaveLength(0);
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.created).toHaveLength(1);
    });

    it("refuses an update when the source's parent changes while the mode catalog is read", async () => {
      const parents = ["parent-a", "parent-b"].map((id) => ({ id, provider: "claude", status: "idle", workspaceId: "ws-1", archivedAt: null, labels: {} }));
      const setup = await setUpFork("bypassPermissions", [], { "paseo.parent-agent-id": "parent-a" }, parents, { prefs: PREFS });
      await setup.store.update((draft) => { draft.opencodeForks[AGENT] = { forkAgentId: RESERVED.targetId, seen: MARK }; });
      setup.byId.set(RESERVED.targetId, opencodeAgent(RESERVED.targetId, { labels: { "zerosub.continued-from": AGENT, "paseo.parent-agent-id": "parent-a" } }));
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      // Calls 1-4 are the earlier checks; call 5 is the catalog read inside the check right before the send.
      let reads = 0;
      setup.hooks.onModes = () => {
        if (++reads === 5) (setup.byId.get(AGENT)!.labels as Record<string, string>)["paseo.parent-agent-id"] = "parent-b";
      };
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved/);
      expect(setup.sends).toHaveLength(0);
    });

    it("refuses a reserved creation when the source and fork move together while modes are read", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      // Calls 1-4 are the create's own and the check before the write; call 5 is inside the check
      // right before the send, after that check has already compared the source with its record.
      let reads = 0;
      setup.hooks.onModes = () => {
        if (++reads === 5) for (const agent of setup.byId.values()) agent.workspaceId = "ws-2";
      };
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved/);
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
    });

    it("re-reads the persisted reservation after a restart-shaped rebuild of the service", async () => {
      const first = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await first.store.update((draft) => {
        draft.opencodeForks[AGENT] = reservedCreation();
      });
      // A second service over the same state file: what a worker restart re-reads.
      const second = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      const done = await second.service.forkAgent(second.paseo, AGENT, "opencode");
      expect(done.agentId).toBe(RESERVED.targetId);
      expect(first.created).toHaveLength(0);
      expect(second.created).toHaveLength(1);
      expect(second.created[0]!.agentId).toBe(RESERVED.targetId);
    });

    it.each([
      ["moved workspace", { workspaceId: "ws-2" }],
      ["busy target", { status: "running" }],
      ["pending permission", { pendingPermissions: [{ id: "p1" }] }],
      ["changed parent", { labels: { "zerosub.continued-from": AGENT, "paseo.parent-agent-id": "elsewhere" } }],
      ["changed provider", { provider: "claude" }],
    ])("keeps a resumed creation reserved when its target has a %s", async (_, overrides) => {
      const setup = await setUpReuse(overrides, reservedCreation());
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect(setup.created).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", delivery: "uncertain" });
    });

    it("refuses a resumed creation whose rebuilt prompt differs from its frozen digest", async () => {
      const setup = await setUpReuse({}, reservedCreation("user", digestOf("a different reserved prompt")));
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.sentDigest).toBe(digestOf("a different reserved prompt"));
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", delivery: "uncertain" });
    });

    it("rebuilds an automatic fork with its reserved reason when a manual retry delivers it", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = reservedCreation("auto");
      });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.agentId).toBe(RESERVED.targetId);
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.messageId).toBe(RESERVED.messageId);
      expect(setup.sends[0]!.text).toContain("every Claude account reached its usage limit");
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("keeps a manually reserved reason when the retry is automatic", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = reservedCreation("user");
      });
      await setup.limitTurn();
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("the work was moved to OpenCode");
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("keeps a legacy reservation without a saved reason uncertain instead of guessing the trigger", async () => {
      const setup = await setUpReuse({}, reservedCreation("auto"));
      await setup.store.update((draft) => {
        const config = draft.opencodeForks[AGENT]!.pending!.config!;
        delete config.why;
      });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.created).toHaveLength(0);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
    });

    it("names the reserved fork by its known ID when it has no title to show", async () => {
      const setup = await setUpReuse({ title: null }, reservedCreation("user", digestOf("a different reserved prompt")));
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(done.title).toBe(`OpenCode agent ${RESERVED.targetId}`);
      expect(setup.notes.at(-1)?.continuedIn).toEqual({ agentId: RESERVED.targetId, title: `OpenCode agent ${RESERVED.targetId}` });
    });

    it("finds a receipt older than the last 500 rows without sending again", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      // The receipt sits at row 1, behind 500 newer rows: one tail page misses it.
      const rows = [
        { item: { type: "user_message", text: sent } as AgentTimelineItem, seqEnd: 1 },
        ...Array.from({ length: 500 }, (_, row) => ({ item: { type: "assistant_message", text: `Row ${row}` } as AgentTimelineItem, seqEnd: row + 2 })),
      ];
      setup.timelines.set(RESERVED.targetId, rows);
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      const record = (await setup.store.read()).opencodeForks[AGENT]!;
      expect(record.pending).toBeUndefined();
      expect(setup.sends.filter((send) => send.agentId === RESERVED.targetId)).toHaveLength(0);
      expect(setup.timelineReads.filter((read) => read.id === RESERVED.targetId)).toHaveLength(2);
    });

    it("stops a receipt scan at its page budget and stays uncertain", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      // More non-matching rows than any budget: the scan can't finish, so nothing is claimed.
      setup.timelines.set(
        RESERVED.targetId,
        Array.from({ length: 5_500 }, (_, row) => ({ item: { type: "assistant_message", text: `Row ${row}` } as AgentTimelineItem, seqEnd: row + 1 })),
      );
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.messageId).toBe("zerosub-handoff-m1");
      expect(setup.timelineReads.filter((read) => read.id === RESERVED.targetId).length).toBeLessThanOrEqual(10);
    });

    it("stays uncertain when the fork's history has a gap instead of calling it undelivered", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      setup.gap.fork = true;
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.messageId).toBe("zerosub-handoff-m1");
    });

    it("settles a pending send by marker and digest when a reload dropped the message ID", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      // A provider reload changed the epoch and dropped clientMessageId and turnId from the row.
      setup.timelines.set(RESERVED.targetId, [{ item: { type: "user_message", text: sent }, seqEnd: 1 }]);
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      const record = (await setup.store.read()).opencodeForks[AGENT]!;
      expect(record.pending).toBeUndefined();
      // The settled reservation's mark, then the update's mark on top of it.
      expect(record.seen).toEqual({ epoch: "epoch-1", seq: 2 });
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("Now also update the CHANGELOG");
    });

    it("reconciles a first-page receipt with a single read of the fork's timeline", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      setup.timelines.set(RESERVED.targetId, [{ item: { type: "user_message", text: sent }, seqEnd: 1 }]);
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("up-to-date");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
      expect(setup.timelineReads.filter((read) => read.id === RESERVED.targetId)).toHaveLength(1);
    });

    it("keeps an unconfirmed send reserved and reports uncertainty instead of resending", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      // The fork's timeline holds no marker: no trustworthy receipt either way.
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.messageId).toBe("zerosub-handoff-m1");
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", continuedIn: { agentId: RESERVED.targetId } });
      expect(setup.notes.at(-1)?.detail).toMatch(/couldn't be confirmed \(transfer zerosub-handoff-m1\)/);
    });

    it.each([
      ["archived", true],
      ["gone", false],
    ])("continues on OpenCode again once the fork of an unconfirmed send is %s", async (_, archived) => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("uncertain");
      if (archived) setup.byId.get(RESERVED.targetId)!.archivedAt = "2026-09-23T08:00:00.000Z";
      else setup.byId.delete(RESERVED.targetId);
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("sent");
      expect(done.agentId).not.toBe(RESERVED.targetId);
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
      const record = (await setup.store.read()).opencodeForks[AGENT]!;
      expect(record.forkAgentId).toBe(done.agentId);
      expect(record.pending).toBeUndefined();
    });

    it("continues on OpenCode again once the fork of an unconfirmed send is gone on Paseo 0.9.1 to 0.10.3", async () => {
      const sent = "The reserved initial handoff.\nzerosub transfer zerosub-handoff-m1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-m1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      setup.hooks.unknownThrows = true;
      setup.byId.delete(RESERVED.targetId);
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("sent");
      expect(done.agentId).not.toBe(RESERVED.targetId);
      expect(setup.created).toHaveLength(1);
    });

    it("reuses the same message ID when an update's acknowledgement was lost", async () => {
      const sent = "The update text.\nzerosub transfer zerosub-handoff-u1";
      const setup = await setUpReuse(
        {},
        seededPending({ stage: "sending", targetId: RESERVED.targetId, messageId: "zerosub-handoff-u1", seen: MARK, sentDigest: digestOf(sent) }),
      );
      // The send arrived; the service stopped before it could record the receipt.
      setup.timelines.set(RESERVED.targetId, [
        { item: { type: "user_message", text: sent, clientMessageId: "zerosub-handoff-u1" }, turnId: "turn-x", seqEnd: 1 },
      ]);
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.sends).toHaveLength(0); // reconciled, not resent
      const rows = setup.timelines.get(RESERVED.targetId)!;
      expect(rows.filter((row) => row.item.type === "user_message" && row.item.clientMessageId === "zerosub-handoff-u1")).toHaveLength(1);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("replaces a settled fork that was archived later", async () => {
      const setup = await setUpReuse({ archivedAt: "2026-09-23T08:00:00.000Z" }, { seen: MARK });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.agentId).not.toBe(RESERVED.targetId);
      expect(setup.created).toHaveLength(1);
      expect((await setup.store.read()).opencodeForks[AGENT]!.forkAgentId).toBe(done.agentId);
    });

    it("transfers an imported handoff as instructions, filtering only its own message IDs", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      await setup.limitTurn();
      setup.addTurn(
        AGENT,
        { type: "user_message", text: "This task is continuing from an earlier session that stopped because it hit its limit." },
        "user-2",
      );
      setup.addTurn(AGENT, { type: "user_message", text: "Old reserved copy" }, "zerosub-handoff-old");
      await setup.limitTurn();
      const update = setup.sends.at(-1)!;
      expect(update.text).toContain("This task is continuing from an earlier session");
      expect(update.text).not.toContain("Old reserved copy");
    });

    it("reports found for an earlier fork without a state record and sends nothing", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [opencodeAgent("fork-old")], { prefs: PREFS });
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done).toMatchObject({ agentId: "fork-old", delivery: "found" });
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", continuedIn: { agentId: "fork-old" } });
      expect(setup.notes.at(-1)?.detail).toMatch(/couldn't tell what it has already received/);
    });

    it("refuses to send into a fork that moved, is working, changed parent, or waits for permission", async () => {
      const refused = async (overrides: Record<string, unknown>) => {
        const setup = await setUpReuse(overrides, { seen: MARK });
        await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/moved, is working or is waiting for permission/);
        expect(setup.sends).toHaveLength(0);
      };
      await refused({ workspaceId: "ws-2" });
      await refused({ status: "running" });
      await refused({ labels: { "zerosub.continued-from": AGENT, "paseo.parent-agent-id": "elsewhere" } });
      await refused({ pendingPermissions: [{ id: "p1" }] });
    });

    it("refuses honestly when the source's handoff history has a gap", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.gap.source = true;
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.sends).toHaveLength(0);
      expect(setup.notes.at(-1)).toMatchObject({ outcome: "stayed", continuedIn: { agentId: RESERVED.targetId } });
      expect(setup.notes.at(-1)?.detail).toMatch(/couldn't read this agent's handoff history/);
    });

    it("refuses to keep sending to an older fork once the source moved to a more careful mode", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.byId.get(AGENT)!.currentModeId = "plan";
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/mode changed/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual(MARK);
    });

    it.each([
      ["a broader mode than the source's", "build", "plan"],
      ["a mode the catalog doesn't list", "mystery", "bypassPermissions"],
    ])("refuses a fork now in %s", async (_, forkMode, sourceMode) => {
      const setup = await setUpReuse({ currentModeId: forkMode }, { seen: MARK });
      setup.byId.get(AGENT)!.currentModeId = sourceMode;
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/mode changed/);
      expect(setup.sends).toHaveLength(0);
    });

    it("still sends to a fork in a more careful mode than the source's", async () => {
      const setup = await setUpReuse({ currentModeId: "build" }, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("sent");
      expect(setup.sends).toHaveLength(1);
    });

    it("refuses an update when the source gained a newer instruction after it was read", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      let sourceReads = 0;
      setup.hooks.onRefetch = (id) => {
        if (id === AGENT && ++sourceReads === 2) setup.addTurn(AGENT, { type: "user_message", text: "STOP" }, "user-3");
      };
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/newer message/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual(MARK);
    });

    it("rebuilds an undelivered reserved creation with the source's newer instruction", async () => {
      const setup = await setUpReuse({}, reservedCreation());
      setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-2");
      const stopSeq = setup.timelines.get(AGENT)!.at(-1)!.seqEnd;
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("sent");
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.messageId).toBe(RESERVED.messageId);
      expect(setup.sends[0]!.text).toContain("STOP, DO NOT MODIFY ANYTHING");
      // The rebuilt reservation's mark covers the STOP, not the row ZeroSub appended afterwards.
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen?.seq).toBe(stopSeq);
    });

    /** Runs `act` once, right after the store commits a sending reservation. */
    const duringSendingWrite = (setup: Awaited<ReturnType<typeof setUpFork>>, act: () => void) => {
      const save = setup.store.update.bind(setup.store);
      let done = false;
      setup.store.update = async (change) => {
        const next = await save(change);
        if (!done && next.opencodeForks[AGENT]?.pending?.stage === "sending") {
          done = true;
          act();
        }
        return next;
      };
    };

    it("releases an update reservation when a STOP lands while it is being written", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      duringSendingWrite(setup, () => setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-3"));
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/newer message/);
      expect(setup.sends).toHaveLength(0);
      const record = (await setup.store.read()).opencodeForks[AGENT]!;
      expect(record.pending).toBeUndefined();
      expect(record.seen).toEqual(MARK);
      // Nothing was dispatched, so the next call carries both instructions in one send.
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("STOP, DO NOT MODIFY ANYTHING");
    });

    it("returns a creation to its reserved state when a STOP lands while it is being written", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      duringSendingWrite(setup, () => setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-2"));
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/newer message/);
      expect(setup.sends).toHaveLength(0);
      const pending = (await setup.store.read()).opencodeForks[AGENT]!.pending!;
      expect(pending.stage).toBe("creating");
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.messageId).toBe(pending.messageId);
      expect(setup.sends[0]!.text).toContain("STOP, DO NOT MODIFY ANYTHING");
    });

    it.each([
      ["the freshness read", 2],
      ["the read after the reservation is written", 3],
    ])("refuses when the source moves to Plan during %s", async (_, read) => {
      const setup = await setUpReuse({ currentModeId: "build" }, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      let reads = 0;
      setup.hooks.onRefetch = (id) => {
        if (id === AGENT && ++reads === read) setup.byId.get(AGENT)!.currentModeId = "plan";
      };
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/mode changed/);
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("never sends a reservation whose original prompt doesn't match its digest, even with newer input", async () => {
      const setup = await setUpReuse({}, reservedCreation("user", digestOf("a different reserved prompt")));
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.sentDigest).toBe(digestOf("a different reserved prompt"));
    });

    it("waits for an automatic source that reports idle just after its turn ended", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS, sourceStatus: "running" });
      setTimeout(() => { setup.byId.get(AGENT)!.status = "idle"; }, 500);
      await setup.limitTurn();
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
    });

    it("keeps an oversized todo inside the update's bounds with the latest STOP last", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "todo", items: [{ text: "t".repeat(200_000), completed: false }] });
      setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-2");
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      const text = setup.sends[0]!.text;
      expect(text.length).toBeLessThan(42_000);
      expect(text).toContain("[… omitted …]");
      expect(text.indexOf("Task list at the time it stopped:")).toBeLessThan(text.indexOf("STOP, DO NOT MODIFY ANYTHING"));
    });

    it("never sends the older initial request when a STOP lands after it was gathered", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      setup.addTurn(AGENT, { type: "user_message", text: "Fix the build" }, "user-1");
      // The STOP arrives after the create gathered the window it reserved, before the delivery.
      let added = false;
      setup.hooks.onRefetch = (id) => {
        if (id === AGENT && setup.created.length === 1 && !added) {
          added = true;
          setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-2");
        }
      };
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.sends).toHaveLength(1);
      expect(setup.sends[0]!.text).toContain("STOP, DO NOT MODIFY ANYTHING");
    });

    it("waits for a created fork that is still initializing, then delivers once", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      setup.hooks.createdStatus = "initializing";
      // The fork reports idle a moment after it is created, as a promptless OpenCode agent does.
      const settle = setInterval(() => {
        for (const agent of setup.byId.values()) if (agent.status === "initializing") setTimeout(() => { agent.status = "idle"; }, 500);
      }, 100);
      try {
        expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("sent");
      } finally {
        clearInterval(settle);
      }
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(1);
    });

    it("keeps the reservation when a created fork never finishes initializing", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: PREFS });
      setup.hooks.createdStatus = "initializing";
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending?.stage).toBe("creating");
    }, 15_000);

    it("settles a send whose acknowledgement was lost when the receipt is there", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      setup.hooks.send = (id, text, messageId) => {
        setup.sends.push({ agentId: id, text, messageId });
        setup.addTurn(id, { type: "user_message", text }, messageId);
        throw new Error("socket hang up");
      };
      expect((await setup.service.forkAgent(setup.paseo, AGENT, "opencode")).delivery).toBe("sent");
      expect(setup.sends).toHaveLength(1);
      expect((await setup.store.read()).opencodeForks[AGENT]!.pending).toBeUndefined();
    });

    it("stays uncertain, keeping the transfer, when the send and the receipt read both throw", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "Now also update the CHANGELOG" }, "user-2");
      setup.hooks.send = (id, text, messageId) => {
        setup.sends.push({ agentId: id, text, messageId });
        setup.hooks.onRefetch = (read) => {
          if (read === RESERVED.targetId) throw new Error("timeline read failed");
        };
        throw new Error("socket hang up");
      };
      const done = await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(done.delivery).toBe("uncertain");
      expect(done.agentId).toBe(RESERVED.targetId);
      const pending = (await setup.store.read()).opencodeForks[AGENT]!.pending;
      expect(pending?.messageId).toBe(setup.sends[0]!.messageId);
      expect(setup.notes.at(-1)?.detail).toContain(setup.sends[0]!.messageId!);
      expect(setup.sends).toHaveLength(1);
    });

    it("puts the latest instruction after older progress and todos in an update", async () => {
      const setup = await setUpReuse({}, { seen: MARK });
      setup.addTurn(AGENT, { type: "user_message", text: "CONTINUE EVERYTHING" }, "user-2");
      setup.addTurn(AGENT, { type: "assistant_message", text: "Continuing with the release." });
      setup.addTurn(AGENT, { type: "todo", items: [{ text: "Ship it", completed: false }] });
      setup.addTurn(AGENT, { type: "user_message", text: "STOP, DO NOT MODIFY ANYTHING" }, "user-3");
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      const text = setup.sends[0]!.text;
      expect(text.indexOf("Continuing with the release.")).toBeLessThan(text.indexOf("STOP, DO NOT MODIFY ANYTHING"));
      expect(text.indexOf("- [ ] Ship it")).toBeLessThan(text.indexOf("STOP, DO NOT MODIFY ANYTHING"));
      expect(text.indexOf("CONTINUE EVERYTHING")).toBeLessThan(text.indexOf("STOP, DO NOT MODIFY ANYTHING"));
    });

    it("keeps the update's watermark when older history has no usable cursor", async () => {
      const setup = await setUpReuse({}, { seen: { epoch: "epoch-1", seq: 1 } });
      setup.timelines.set(
        AGENT,
        Array.from({ length: 600 }, (_, row) => ({ item: { type: "assistant_message", text: `Row ${row}` } as AgentTimelineItem, seqEnd: row + 1 })),
      );
      const timeline = setup.paseo as unknown as { agents: { ref: (id: string) => { timeline: { refetch: (o: unknown) => Promise<Record<string, unknown>> } } } };
      const ref = timeline.agents.ref;
      timeline.agents.ref = (id: string) => {
        const real = ref(id);
        if (id !== AGENT) return real;
        const refetch = real.timeline.refetch;
        real.timeline.refetch = async (options: unknown) => ({ ...(await refetch(options)), startCursor: null });
        return real;
      };
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.sends).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]!.seen).toEqual({ epoch: "epoch-1", seq: 1 });
      expect(setup.notes.at(-1)?.detail).toMatch(/couldn't read this agent's handoff history/);
    });

    const refusalCases: Array<{
      name: string;
      options: { prefs?: Record<string, unknown>; opencodeAvailable?: boolean; catalog?: Array<Record<string, unknown>> };
      refusal: RegExp;
    }> = [
      {
        name: "the saved model has left the catalog",
        options: { catalog: [{ id: "opencode/other", label: "Other", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }] }] },
        refusal: /saved OpenCode model is no longer in this host's catalog/,
      },
      {
        name: "the saved thinking option is gone from the model",
        options: { catalog: [{ id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", isDefault: true, thinkingOptions: [{ id: "low", label: "Low" }] }] },
        refusal: /GLM 5.3 Flash” no longer offers the saved thinking option/,
      },
      { name: "the host reports no OpenCode", options: { opencodeAvailable: false }, refusal: /OpenCode isn't available in Paseo on this host/ },
      {
        name: "no model is marked default and none was saved",
        options: {
          catalog: [{ id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", thinkingOptions: [{ id: "high", label: "High" }] }],
          prefs: { forkOpenCodeModel: "" },
        },
        refusal: /No OpenCode model is marked default on this host/,
      },
    ];
    it.each(refusalCases)("refuses the fork when $name", async ({ options, refusal }) => {
      const { created, notes, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], {
        ...options,
        prefs: { ...PREFS, ...options.prefs },
      });
      await limitTurn();
      expect(created).toHaveLength(0);
      expect(notes.at(-1)).toMatchObject({ outcome: "stayed", toProvider: null, continuedIn: null });
      expect(notes.at(-1)?.detail).toMatch(refusal);
    });

    it("refuses the fork when OpenCode has no mode as careful as the original's", async () => {
      const { created, notes, limitTurn } = await setUpFork("default", [], {}, [], {
        prefs: PREFS,
        opencodeModes: [{ id: "yolo", label: "Yolo", colorTier: "dangerous" }],
      });
      await limitTurn();
      expect(created).toHaveLength(0);
      expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
      expect(notes.at(-1)?.detail).toMatch(/no mode as careful as this agent's \(“Always Ask”\)/);
  });

    it("never picks an OpenCode mode without a permission tier", async () => {
      // Paseo's own factory modes have no colorTier: they aren't permission tiers, so never chosen.
      const { created, notes, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], {
        prefs: PREFS,
        opencodeModes: [{ id: "bypass", label: "Bypass" }],
      });
      await limitTurn();
      expect(created).toHaveLength(0);
      expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
      expect(notes.at(-1)?.detail).toMatch(/no mode as careful as this agent's \(“Bypass”\)/);
  });

    it("never picks an OpenCode mode whose colorTier is an agent's color", async () => {
      // Paseo 0.16 reports a colored OpenCode agent's hex color as its colorTier, in place of the tier.
      const { created, notes, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], {
        prefs: PREFS,
        opencodeModes: [
          { id: "build", label: "Build", colorTier: "#f97316" },
          { id: "plan", label: "Plan", colorTier: "#3b82f6" },
        ],
      });
      await limitTurn();
      expect(created).toHaveLength(0);
      expect(notes.at(-1)?.detail).toMatch(/no mode as careful as this agent's/);
    });
  });

  describe("a continuation of the other kind", () => {
    const chatGptAgent = {
      id: "gpt-fork",
      provider: "codex",
      status: "idle",
      title: "Fix the build (continued on ChatGPT)",
      workspaceId: "ws-1",
      archivedAt: null,
      labels: { "zerosub.continued-from": AGENT },
    };
    const openCodeAgent = { ...chatGptAgent, id: "oc-fork", provider: "opencode", title: "Fix the build (continued on OpenCode)" };
    const AUTO = { forkOtherProvider: true };

    it("creates no OpenCode fork when ChatGPT already continued the agent", async () => {
      const { created, notes, limitTurn } = await setUpFork("bypassPermissions", [], {}, [chatGptAgent], {
        prefs: { ...AUTO, claudeForkDestination: "opencode" },
      });
      await limitTurn();
      expect(created).toHaveLength(0);
      expect(notes.at(-1)?.detail).toMatch(/already continued in “Fix the build \(continued on ChatGPT\)”/);
    });

    it("creates no ChatGPT fork when OpenCode already continued the agent", async () => {
      const { created, notes, limitTurn } = await setUpFork("bypassPermissions", [], {}, [openCodeAgent], { prefs: AUTO });
      await limitTurn();
      expect(created).toHaveLength(0);
      expect(notes.at(-1)?.detail).toMatch(/already continued in “Fix the build \(continued on OpenCode\)”/);
    });

    it("refuses a manual OpenCode fork that names the ChatGPT chat", async () => {
      const { created, service, paseo } = await setUpFork("bypassPermissions", [], {}, [chatGptAgent], { prefs: { autoSwitch: false } });
      await expect(service.forkAgent(paseo, AGENT, "opencode")).rejects.toThrow(/already continued in “Fix the build \(continued on ChatGPT\)”/);
      expect(created).toHaveLength(0);
    });

    it("refuses a manual ChatGPT fork that names the OpenCode chat", async () => {
      const { created, service, paseo } = await setUpFork("bypassPermissions", [], {}, [openCodeAgent], { prefs: { autoSwitch: false } });
      await expect(service.forkAgent(paseo, AGENT)).rejects.toThrow(/already continued in “Fix the build \(continued on OpenCode\)”/);
      expect(created).toHaveLength(0);
    });

    it("never ends with two continuations after a failed OpenCode create, a ChatGPT fork, then Continue on OpenCode", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: { autoSwitch: false } });
      setup.hooks.createError = "OpenCode couldn't start";
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/couldn't start/);
      delete setup.hooks.createError;
      expect((await setup.store.read()).opencodeForks[AGENT]?.pending?.stage).toBe("creating");
      await setup.service.forkAgent(setup.paseo, AGENT);
      expect(setup.created.map((agent) => agent.config.provider.split("/")[0])).toEqual(["codex"]);
      // The OpenCode create never landed, so the ChatGPT fork took the work and its reservation went.
      expect((await setup.store.read()).opencodeForks[AGENT]).toBeUndefined();
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/already continued in “Fix the build \(continued on ChatGPT\)”/);
      expect(setup.created).toHaveLength(1);
      expect(setup.sends).toHaveLength(0);
    });

    it("forks to ChatGPT after a failed OpenCode create on Paseo 0.9.1 to 0.10.3, where refreshing the absent target throws", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: { autoSwitch: false } });
      setup.hooks.unknownThrows = true;
      setup.hooks.createError = "OpenCode couldn't start";
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/couldn't start/);
      delete setup.hooks.createError;
      await setup.service.forkAgent(setup.paseo, AGENT);
      expect(setup.created.map((agent) => agent.config.provider.split("/")[0])).toEqual(["codex"]);
      expect((await setup.store.read()).opencodeForks[AGENT]).toBeUndefined();
    });

    it("keeps an OpenCode reservation when a later ChatGPT fork is refused before it starts", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: { autoSwitch: false }, noChatGPT: true });
      setup.hooks.createError = "OpenCode couldn't start";
      await expect(setup.service.forkAgent(setup.paseo, AGENT, "opencode")).rejects.toThrow(/couldn't start/);
      delete setup.hooks.createError;
      const reserved = (await setup.store.read()).opencodeForks[AGENT]!.pending!;
      await expect(setup.service.forkAgent(setup.paseo, AGENT)).rejects.toThrow();
      expect(setup.created).toHaveLength(0);
      expect((await setup.store.read()).opencodeForks[AGENT]?.pending?.targetId).toBe(reserved.targetId);
      await setup.service.forkAgent(setup.paseo, AGENT, "opencode");
      expect(setup.created[0]?.agentId).toBe(reserved.targetId);
    });

    it("creates no ChatGPT fork while an OpenCode reservation's fork exists", async () => {
      const setup = await setUpFork("bypassPermissions", [], {}, [], { prefs: { autoSwitch: false } });
      await setup.store.update((draft) => {
        draft.opencodeForks[AGENT] = { forkAgentId: "oc-fork", pending: { stage: "creating", targetId: "oc-fork", messageId: "zerosub-handoff-m1", seen: { epoch: "epoch-1", seq: 0 } } };
      });
      // Paseo doesn't list it yet, but it answers for its ID.
      setup.byId.set("oc-fork", openCodeAgent);
      await expect(setup.service.forkAgent(setup.paseo, AGENT)).rejects.toThrow(/already continued in “Fix the build \(continued on OpenCode\)”/);
      expect(setup.created).toHaveLength(0);
    });
  });

  describe("OpenCode availability in the state view", () => {
    it.each([[true], [false]])("reports openCodeAvailable %s from the host's provider list", async (present) => {
      const { service, paseo } = await setUpFork("default", [], {}, [], { opencodeAvailable: present });
      expect((await service.view(paseo)).openCodeAvailable).toBe(present);
    });

    it("reads availability once a minute and keeps the last good answer through a failed read", async () => {
      const { service, paseo } = await setUpFork("default");
      const answers: Array<() => Promise<unknown>> = [
        async () => ({ providers: [{ provider: "opencode", available: true }] }),
        async () => {
          throw new Error("daemon unreachable");
        },
        async () => ({ providers: [], error: "probe failed" }),
        async () => ({ providers: [{ provider: "opencode", available: false }] }),
      ];
      const listAvailable = vi.fn(() => answers.shift()!());
      (paseo as { providers: { listAvailable: unknown } }).providers.listAvailable = listAvailable;
      const start = Date.now();
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(start);
        expect((await service.view(paseo)).openCodeAvailable).toBe(true);
        vi.setSystemTime(start + 59_000);
        expect((await service.view(paseo)).openCodeAvailable).toBe(true);
        expect(listAvailable).toHaveBeenCalledTimes(1);
        // Past a minute it reads again; a thrown read or an error answer keeps the last good value.
        vi.setSystemTime(start + 61_000);
        expect((await service.view(paseo)).openCodeAvailable).toBe(true);
        expect((await service.view(paseo)).openCodeAvailable).toBe(true);
        expect((await service.view(paseo)).openCodeAvailable).toBe(false);
        expect(listAvailable).toHaveBeenCalledTimes(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("a failed catalog read", () => {
    it("refuses with the read error, before any saved-model or default check", async () => {
      const { created, notes, limitTurn } = await setUpFork("bypassPermissions", [], {}, [], {
        prefs: { forkOtherProvider: true, claudeForkDestination: "opencode" },
        catalogError: "daemon unreachable",
      });
      await limitTurn();
      expect(created).toHaveLength(0);
      expect(notes.at(-1)?.detail).toBe("Couldn't read this host's OpenCode models: daemon unreachable");
    });
  });

  describe("OpenCode mode choice", () => {
    it.each([
      ["plan", "plan"],
      ["default", "plan"],
      ["acceptEdits", "build"],
      ["auto", "build"],
      ["bypassPermissions", "build"],
    ])("sends a %s Claude agent to OpenCode %s", async (claudeMode, openCodeMode) => {
      const { created, limitTurn } = await setUpFork(claudeMode, [], {}, [], {
        prefs: { forkOtherProvider: true, claudeForkDestination: "opencode" },
      });
      await limitTurn();
      expect(created[0]?.config.modeId).toBe(openCodeMode);
    });
  });

  describe("manual OpenCode continuation", () => {
    const PREFS = { autoSwitch: false, forkOtherProvider: false, forkOpenCodeModel: "opencode/glm-5p3-flash", forkOpenCodeThinking: "high" };
    const manually = async (options: { modeId?: string } & Parameters<typeof setUpFork>[4] = {}) => {
      const { modeId = "bypassPermissions", ...rest } = options;
      const setup = await setUpFork(modeId, [], {}, [], rest);
      return { ...setup, fork: () => setup.service.forkAgent(setup.paseo, AGENT, "opencode") };
    };

    it("continues a stopped Claude chat on OpenCode with every toggle off and no ChatGPT accounts", async () => {
      const { store, created, notes, sends, fork } = await manually({ prefs: PREFS, noChatGPT: true });
      const done = await fork();
      expect(created).toHaveLength(1);
      expect(done).toEqual({ agentId: created[0]?.agentId, title: "Fix the build (continued on OpenCode)", delivery: "sent" });
      expect(created[0]?.config).toEqual({
        provider: "opencode/opencode/glm-5p3-flash",
        modeId: "build", // Bypass is as loose as Build gets
        thinkingOptionId: "high",
      });
      expect(created[0]?.title).toBe("Fix the build (continued on OpenCode)");
      expect(sends[0]?.text).toMatch(/stopped because the work was moved to OpenCode/);
      // OpenCode is a harness, not an account provider: no binding, so no account store entry.
      expect((await store.read()).bindings[done.agentId]).toBeUndefined();
      expect(notes.at(-1)).toMatchObject({
        reason: "manual",
        continued: true,
        to: "OpenCode",
        toFamily: null,
        toProvider: "opencode",
        continuedIn: { agentId: done.agentId },
      });
    });

    it("points a second manual call at the earlier OpenCode fork instead of starting another", async () => {
      const { created, fork } = await manually({ prefs: PREFS });
      const first = await fork();
      const second = await fork();
      expect(created).toHaveLength(1);
      expect(second.agentId).toBe(first.agentId);
    });

    it("refuses when the saved model has left the catalog", async () => {
      const { created, fork } = await manually({
        prefs: PREFS,
        catalog: [{ id: "opencode/other", label: "Other", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }] }],
      });
      await expect(fork()).rejects.toThrow(/saved OpenCode model is no longer in this host's catalog/);
      expect(created).toHaveLength(0);
    });

    it("refuses when the saved thinking option is gone from the model", async () => {
      const { created, fork } = await manually({
        prefs: PREFS,
        catalog: [{ id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", isDefault: true, thinkingOptions: [{ id: "low", label: "Low" }] }],
      });
      await expect(fork()).rejects.toThrow(/GLM 5.3 Flash” no longer offers the saved thinking option/);
      expect(created).toHaveLength(0);
    });

    it("refuses when OpenCode has no mode as careful as the original's", async () => {
      const { created, fork } = await manually({ prefs: PREFS, opencodeModes: [{ id: "yolo", label: "Yolo", colorTier: "dangerous" }], modeId: "default" });
      await expect(fork()).rejects.toThrow(/no mode as careful as this agent's \(“Always Ask”\)/);
      expect(created).toHaveLength(0);
    });

    it("refuses a running agent", async () => {
      const { created, fork } = await manually({ prefs: PREFS, sourceStatus: "running" });
      await expect(fork()).rejects.toThrow("This agent is working right now. Wait for its turn to finish, then continue it elsewhere.");
      expect(created).toHaveLength(0);
    });

    it("refuses a Codex source", async () => {
      const { created, fork } = await manually({ prefs: PREFS, sourceProvider: "codex" });
      await expect(fork()).rejects.toThrow("Only Claude agents can continue on OpenCode.");
      expect(created).toHaveLength(0);
    });
  });
});

describe("disabling an account", () => {
  it("moves its agents off and back, and won't disable the last usable account", async () => {
    const { service, store, reopened } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
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

  it("won't disable an account whose agents routing would leave on it", async () => {
    // Routing never moves agents onto an account at its limit, so they'd stay put.
    const others = {
      "a limit": { ...account(HELLO, "hello", "managed"), limitedUntil: inFuture(), limitKind: "window" },
    };
    for (const [why, other] of Object.entries(others)) {
      const { service, store, reopened, paseo } = await setUp(
        {
          accounts: [account(MAIN, "marketing", "main"), other] as never,
          defaults: { claude: MAIN, codex: null, pi: null },
          sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt: new Date().toISOString() } },
        },
        () => ({ kind: "window", resetsAt: inFuture(), message: "" }),
      );
      await expect(service.setAccountEnabled(paseo as never, MAIN, false), why).rejects.toThrow(/nowhere to go/);
      expect((await store.read()).accounts.find((entry) => entry.id === MAIN)?.disabled, why).toBe(false);
      expect(reopened).toEqual([]);
    }
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
    defaults: { claude: MAIN, codex: null, pi: null },
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

  it("doesn't take one model's full window for the whole account's limit", async () => {
    const opusFull = (): UsageRead => ({
      fetchedAt: new Date().toISOString(),
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 12, resetsAt: inFuture() },
        { id: "seven_day", label: "Weekly", usedPercent: 40, resetsAt: inFuture() },
        { id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 100, resetsAt: inFuture() },
      ],
      error: null,
      cached: false,
      resets: null,
    });
    const { service, store, paseo } = await setUp(state(), unused, { usage: opusFull });
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).toBeNull();
    expect(await newAgentOpensOn(service, store, paseo)).toBe(MAIN);
  });

  const fableFull = (): UsageRead => ({
    fetchedAt: new Date().toISOString(),
    windows: [
      { id: "five_hour", label: "5-hour", usedPercent: 8, resetsAt: inFuture() },
      { id: "seven_day", label: "Weekly", usedPercent: 73, resetsAt: inFuture() },
      { id: "weekly_fable", label: "Weekly · Fable", usedPercent: 100, resetsAt: inFuture() },
    ],
    error: null,
    cached: false,
    resets: null,
  });

  it("clears a limit a reading took once the account's own windows have room, one model's window full or not", async () => {
    // Saved by a version that took any full window for the account's: the account stayed blocked until Fable reset.
    const { service, store, paseo } = await setUp(
      state({ limitedUntil: inFuture(), limitKind: "window", limitedAt: inPast(), limitSource: "reading" }),
      unused,
      { usage: fableFull },
    );
    await settle(store);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).toBeNull();
    expect(await newAgentOpensOn(service, store, paseo)).toBe(MAIN);
  });

  it("clears a limit a turn ran into once the account's own windows have room, one model's window full or not", async () => {
    // A model's own hit lands on that model (see "one model's limit"), so what a turn left on the
    // account is the account's, and only its own windows say whether it has room.
    const { service, store, limitTurn } = await setUp(
      state(),
      () => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" }),
      { usage: fableFull },
    );
    await limitTurn();
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).not.toBeNull(); // a fresh turn limit is trusted for a while
    await settle(store);
    await service.refreshUsage(MAIN, true);
    expect(await limitedUntil(store)).toBeNull();
    expect((await store.read()).accounts.find((a) => a.id === MAIN)?.modelLimits.fable?.source).toBe("reading");
  });

  it("limits a model by its own full window, and lifts it once the window has room", async () => {
    let reading = fableFull;
    const { service, store, paseo } = await setUp(state(), unused, { usage: () => reading() });
    const main = async () => (await store.read()).accounts.find((a) => a.id === MAIN)!;
    await service.refreshUsage(MAIN, true);
    expect((await main()).modelLimits.fable).toMatchObject({ source: "reading" });
    expect((await main()).limitedUntil).toBeNull();
    expect(await newAgentOpensOn(service, store, paseo)).toBe(MAIN); // other models still start there

    reading = () => ({ ...fableFull(), windows: fableFull().windows.map((w) => (w.id === "weekly_fable" ? { ...w, usedPercent: 40 } : w)) });
    await service.refreshUsage(MAIN, true);
    expect((await main()).modelLimits).toEqual({});
    expect((await main()).limitedUntil).toBeNull();
  });

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
    defaults: { claude: MAIN, codex: null, pi: null },
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

  it("keeps the old default when Paseo can't list the open agents to keep them where they are", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({ kind: "window", resetsAt: inFuture(), message: "" }));
    service.setPreferences(preferences.schema.parse({ moveAgentsOnDefaultChange: false }));
    const { paseo } = fakePaseo();
    paseo.agents.list = async () => {
      throw new Error("Not connected");
    };

    await expect(service.setDefault(paseo as never, HELLO)).rejects.toThrow("Not connected");
    expect((await store.read()).defaults.claude).toBe(MAIN);
    // Alignment then has nothing to move them for.
    paseo.agents.list = fakePaseo().paseo.agents.list;
    expect((await service.alignSessions(paseo as never)).reopened).toEqual([]);
    expect(reopened).toEqual([]);
  });

  it("answers, with the agents it didn't get to, when moving them fails", async () => {
    const { service, store, reopened } = await setUp(stateWithLiveAgent(), () => ({ kind: "window", resetsAt: inFuture(), message: "" }));
    const { paseo } = fakePaseo();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    // The first read is setDefault's own; the second is where the move goes wrong.
    const read = store.read.bind(store);
    let reads = 0;
    vi.spyOn(store, "read").mockImplementation(async () => {
      reads += 1;
      if (reads === 4) throw new Error("state.json can't be read");
      return read();
    });

    expect(await service.setDefault(paseo as never, HELLO)).toMatchObject({ reopened: [], failed: [] });
    expect((await read()).defaults.claude).toBe(HELLO);
    expect(reopened).toEqual([]);
  });

  const WORK = "claude-work";
  const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
  const KEEP = preferences.schema.parse({ autoSwitch: true, moveAgentsOnDefaultChange: false });
  const NOTHING_MOVED = { reopened: [], deferred: [], failed: [], pending: [], continuedIn: null };
  const session = (accountId: string) => ({ accountId, family: "claude" as const, openedAt });

  /** Several agents, each answering for itself. `reopened` lists the ones Paseo was asked to reload. */
  async function setUpAgents(
    state: Partial<StoredState>,
    listed: Array<{ id: string; status: string; provider?: string; archived?: boolean; backgroundWork?: number; updatedAt?: string; model?: string }>,
    options: { claude?: Partial<FamilyAdapter>; codex?: Partial<FamilyAdapter>; onList?: (service: Service, context: never) => void | Promise<void> } = {},
  ) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) => Object.assign(draft, state));
    const agents = listed.map(({ id, status, provider, archived, backgroundWork, updatedAt, model }) => ({
      id,
      provider: provider ?? "claude",
      model,
      status,
      archivedAt: archived ? "2026-09-23T08:00:00.000Z" : null,
      lastUserMessageAt: openedAt,
      updatedAt,
      backgroundWork: { count: backgroundWork ?? 0 },
    }));
    /** The timeline notes ZeroSub added, by agent. */
    const notes: Array<{ agentId: string; data: { reason: string } }> = [];
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      agents: {
        list: async () => {
          await options.onList?.(service, context);
          return { entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } };
        },
        ref: (id: string) => ({
          refresh: async () => ({ agent: agents.find((agent) => agent.id === id) }),
          send: async () => undefined,
          timeline: {
            append: async (item: { data: { reason: string } }) => void notes.push({ agentId: id, data: item.data }),
            refetch: async () => ({ entries: [] }),
          },
        }),
      },
    };
    const context = { paseo } as never;
    const reopened: string[] = [];
    const hit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" });
    const service: Service = new Service(
      { claude: { ...claudeAdapter(hit), ...options.claude }, codex: { ...claudeAdapter(hit), family: "codex", portable: false, ...options.codex } as FamilyAdapter, pi: absentPi() },
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
    services.push(service);
    service.setPreferences(KEEP);
    return { service, store, paseo: paseo as never, context, reopened, agents, notes };
  }

  describe("moving idle agents off a busy account", () => {
    const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    const reading = (percent: number, week = 10): UsageRead => ({
      fetchedAt: new Date().toISOString(),
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: new Date(Date.now() + 3 * 60 * 60_000).toISOString(), minutes: 300 },
        { id: "seven_day", label: "Weekly", usedPercent: week, resetsAt: new Date(Date.now() + 3 * 24 * 60 * 60_000).toISOString(), minutes: 10_080 },
      ],
      error: null,
      cached: false,
      resets: null,
    });

    /** `work` (the CLI login) reads 60% two hours into its window, so it's projected past the gate. */
    async function setUpBusy(
      agentId: string,
      updatedAt: string,
      options: {
        personal?: number;
        /** `personal`'s weekly percent. */
        personalWeek?: number;
        prefs?: Record<string, unknown>;
        bindings?: StoredState["bindings"];
        onList?: (service: Service) => void | Promise<void>;
        /** More agents on `work`, idle as long as `agentId`. */
        others?: string[];
        /** Agents just placed on `personal`, which its reading doesn't show yet. */
        pending?: number;
        /** The models agents run, by agent. */
        models?: Record<string, string>;
        /** Replaces the two accounts; `usedBy` gives each one's 5-hour percent by account ID (`work` stays at 60). */
        accounts?: StoredAccount[];
        usedBy?: Record<string, number>;
      } = {},
    ) {
      const ids = [agentId, ...(options.others ?? [])];
      const setup = await setUpAgents(
        {
          accounts: (options.accounts ?? [account(MAIN, "work", "main"), account(HELLO, "personal", "managed")]) as never,
          defaults: { claude: MAIN, codex: null, pi: null },
          sessions: Object.fromEntries(ids.map((id) => [id, session(MAIN)])),
          bindings: options.bindings ?? {},
        },
        ids.map((id) => ({ id, status: "idle", updatedAt, model: options.models?.[id] })),
        {
          claude: {
            usage: async (home: string | null) => {
              const byHome = (options.accounts ?? []).find((entry) => entry.home === home);
              return home ? reading(options.usedBy?.[byHome?.id ?? ""] ?? options.personal ?? 20, options.personalWeek) : reading(60);
            },
          } as Partial<FamilyAdapter>,
          onList: options.onList,
        },
      );
      setup.service.setPreferences(
        preferences.schema.parse({ autoSwitch: true, balanceNewAgents: true, autoContinue: false, ...options.prefs }),
      );
      for (let n = 0; n < (options.pending ?? 0); n += 1) placed(setup.service, HELLO);
      await setup.service.view(setup.paseo, true);
      // The pass runs after the readings land; wait until it's done.
      await vi.waitFor(() => expect((setup.service as unknown as { relieving: Set<string> }).relieving.size).toBe(0));
      return setup;
    }

    it("moves an agent idle for an hour off it", async () => {
      const { store, reopened, notes } = await setUpBusy("fix-build", ago(120));
      expect(reopened).toEqual(["fix-build"]);
      const state = await store.read();
      expect(state.bindings["fix-build"]).toMatchObject({ accountId: HELLO, source: "auto" });
      expect(state.sessions["fix-build"]?.accountId).toBe(HELLO);
      expect(notes).toContainEqual({ agentId: "fix-build", data: expect.objectContaining({ reason: "pacing", from: "work", to: "personal" }) });
    });

    it("moves at most three agents in one pass", async () => {
      const { reopened } = await setUpBusy("a1", ago(120), { others: ["a2", "a3", "a4", "a5"] });
      expect(reopened).toHaveLength(3);
    });

    it("leaves an agent where it is when the other account has used 90% of its week", async () => {
      const { reopened } = await setUpBusy("fix-build", ago(120), { personalWeek: 90 });
      expect(reopened).toEqual([]);
    });

    it("leaves an agent idle for more than a day", async () => {
      const { reopened } = await setUpBusy("old-spike", ago(26 * 60));
      expect(reopened).toEqual([]);
    });

    it("leaves an agent used in the last hour", async () => {
      const { reopened } = await setUpBusy("review-pr", ago(10));
      expect(reopened).toEqual([]);
    });

    it("leaves an agent the user put there", async () => {
      const { store, reopened } = await setUpBusy("fix-build", ago(120), {
        bindings: { "fix-build": { accountId: MAIN, source: "user", at: openedAt } },
      });
      expect(reopened).toEqual([]);
      expect((await store.read()).bindings["fix-build"]).toMatchObject({ accountId: MAIN, source: "user" });
    });

    it("never moves an agent onto AWS Bedrock, even with paid API fallback on", async () => {
      const bedrock = { ...account("claude-bedrock", "bedrock", "managed"), auth: "api" as const, provider: "bedrock" as const, identity: "bedrock|eu-central-1|host" };
      const { store, reopened } = await setUpBusy("fix-build", ago(120), {
        accounts: [account(MAIN, "work", "main"), bedrock] as never,
        prefs: { paidApiFallback: true },
      });
      expect(reopened).toEqual([]);
      expect((await store.read()).sessions["fix-build"]?.accountId).toBe(MAIN);
    });

    describe("with a model's own limit on an account", () => {
      const FABLE = "claude-fable-5-2";
      const OPUS = "claude-opus-4-1";
      const SPARE = "claude-spare";
      const fableFull = { fable: { until: inFuture(), at: inPast(), source: "turn" as const } };
      // `personal` has the most room (20%) but its Fable window is full; `spare` reads 40%.
      const withFableFull = (spare: boolean) =>
        [
          account(MAIN, "work", "main"),
          { ...account(HELLO, "personal", "managed"), modelLimits: fableFull },
          ...(spare ? [account(SPARE, "spare", "managed")] : []),
        ] as unknown as StoredAccount[];

      it("keeps a Fable agent off an account whose Fable window is full, even with the most room", async () => {
        const { store, reopened } = await setUpBusy("fix-build", ago(120), {
          accounts: withFableFull(false),
          models: { "fix-build": FABLE },
        });
        expect(reopened).toEqual([]);
        expect((await store.read()).sessions["fix-build"]?.accountId).toBe(MAIN);
      });

      it("moves a Fable agent to the account without that limit", async () => {
        const { store, reopened } = await setUpBusy("fix-build", ago(120), {
          accounts: withFableFull(true),
          usedBy: { [HELLO]: 20, [SPARE]: 40 },
          models: { "fix-build": FABLE },
        });
        expect(reopened).toEqual(["fix-build"]);
        expect((await store.read()).bindings["fix-build"]).toMatchObject({ accountId: SPARE, source: "auto" });
      });

      it("moves an Opus agent onto the account whose Fable window is full", async () => {
        const { store, reopened } = await setUpBusy("fix-build", ago(120), {
          accounts: withFableFull(true),
          usedBy: { [HELLO]: 20, [SPARE]: 40 },
          models: { "fix-build": OPUS },
        });
        expect(reopened).toEqual(["fix-build"]);
        expect((await store.read()).bindings["fix-build"]).toMatchObject({ accountId: HELLO, source: "auto" });
      });

      it("moves a later Opus agent when an earlier Fable agent has nowhere to go", async () => {
        const { store, reopened } = await setUpBusy("fable-agent", ago(120), {
          others: ["opus-agent"],
          accounts: withFableFull(false),
          models: { "fable-agent": FABLE, "opus-agent": OPUS },
        });
        expect(reopened).toEqual(["opus-agent"]);
        const state = await store.read();
        expect(state.sessions["fable-agent"]?.accountId).toBe(MAIN);
        expect(state.bindings["opus-agent"]).toMatchObject({ accountId: HELLO, source: "auto" });
      });

      it("moves a later Opus agent when an earlier Fable agent's only target would pass the gate", async () => {
        // `spare` is the only account with room for Fable, and its 75% reading would pass the gate with the agent.
        const { store, reopened } = await setUpBusy("fable-agent", ago(120), {
          others: ["opus-agent"],
          accounts: withFableFull(true),
          usedBy: { [HELLO]: 20, [SPARE]: 75 },
          models: { "fable-agent": FABLE, "opus-agent": OPUS },
        });
        expect(reopened).toEqual(["opus-agent"]);
        const state = await store.read();
        expect(state.sessions["fable-agent"]?.accountId).toBe(MAIN);
        expect(state.bindings["opus-agent"]).toMatchObject({ accountId: HELLO, source: "auto" });
      });
    });

    it("moves nothing with automatic switching off", async () => {
      const { reopened } = await setUpBusy("fix-build", ago(120), { prefs: { autoSwitch: false } });
      expect(reopened).toEqual([]);
    });

    it("moves nothing to an account that pending placements alone push past the gate", async () => {
      // `personal` reads 20% two hours in: projected 30%, and 70% with four agents just placed there.
      const { reopened } = await setUpBusy("fix-build", ago(120), { pending: 4 });
      expect(reopened).toEqual([]);
    });

    it("stops moving agents once the account they go to would reach the gate", async () => {
      const others = ["agent-2", "agent-3", "agent-4", "agent-5", "agent-6"];
      const { service, reopened } = await setUpBusy("fix-build", ago(120), { others, personal: 45 });
      expect(reopened.length).toBeGreaterThan(0);
      expect(reopened.length).toBeLessThan(others.length + 1);
      const usage = (service as unknown as { usage: Map<string, Usage> }).usage.get(HELLO);
      const pending = pendingOn(service, HELLO);
      expect(pending).toBe(reopened.length);
      expect(paceScore(usage, pending, Date.now()).gated).toBe(false);
      expect(paceScore(usage, pending + 1, Date.now()).gated).toBe(true);
    });

    it("leaves an agent the user puts on the account during the pass", async () => {
      const relieving = (service: Service) => (service as unknown as { relieving: Set<string> }).relieving;
      const { store, reopened } = await setUpBusy("fix-build", ago(120), {
        // The pass reads the bindings before it lists agents, so this pick lands after that read.
        onList: async (service) => {
          if (relieving(service).size === 0) return;
          await (service as unknown as { store: StateStore }).store.update((draft) => {
            draft.bindings["fix-build"] = { accountId: MAIN, source: "user", at: openedAt };
          });
        },
      });
      expect(reopened).toEqual([]);
      expect((await store.read()).bindings["fix-build"]).toMatchObject({ accountId: MAIN, source: "user" });
    });

    it("moves nothing with spreading off", async () => {
      const { reopened } = await setUpBusy("fix-build", ago(120), { prefs: { balanceNewAgents: false } });
      expect(reopened).toEqual([]);
    });

    it("stops when spreading is turned off during the pass", async () => {
      const relieving = (service: Service) => (service as unknown as { relieving: Set<string> }).relieving;
      const { reopened } = await setUpBusy("fix-build", ago(120), {
        // The pass lists agents after its own preference check, so this turns spreading off mid-pass.
        onList: (service) => {
          if (relieving(service).size > 0) service.setPreferences(preferences.schema.parse({ autoSwitch: true, balanceNewAgents: false }));
        },
      });
      expect(reopened).toEqual([]);
    });

    it("leaves ChatGPT agents on a busy ChatGPT account", async () => {
      const CODEX_OTHER = "codex-other";
      const { service, store, paseo, reopened } = await setUpAgents(
        {
          accounts: [
            { ...account(CODEX_MAIN, "work", "main"), family: "codex" },
            { ...account(CODEX_OTHER, "personal", "managed"), family: "codex" },
          ] as never,
          defaults: { claude: null, codex: CODEX_MAIN, pi: null },
          sessions: { "fix-build": { accountId: CODEX_MAIN, family: "codex" as const, openedAt } },
        },
        [{ id: "fix-build", status: "idle", provider: "codex", updatedAt: ago(120) }],
        { codex: { usage: async (home: string | null) => (home ? reading(20) : reading(60)) } as Partial<FamilyAdapter> },
      );
      service.setPreferences(preferences.schema.parse({ autoSwitch: true, balanceNewAgents: true, autoContinue: false }));
      await service.view(paseo, true);
      await vi.waitFor(() => expect((service as unknown as { relieving: Set<string> }).relieving.size).toBe(0));
      expect(reopened).toEqual([]);
      expect((await store.read()).bindings["fix-build"]).toBeUndefined();
    });

    it("moves nothing when the other account would pass the gate too", async () => {
      const { reopened } = await setUpBusy("fix-build", ago(120), { personal: 75 });
      expect(reopened).toEqual([]);
    });
  });

  it("moves an agent whose last turn failed off an account it can't work on", async () => {
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [{ ...account(MAIN, "marketing", "main"), limitedUntil: inFuture() }, account(WORK, "work", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { drifted: session(MAIN) },
        bindings: { drifted: { accountId: WORK, source: "user", at: openedAt } },
      },
      [{ id: "drifted", status: "error" }],
    );
    expect((await service.view(paseo)).agents.find((route) => route.agentId === "drifted")).toMatchObject({ accountId: WORK, pendingAccountId: MAIN });
    await service.alignSessions(paseo);
    expect(reopened).toEqual(["drifted"]);
    expect((await store.read()).sessions.drifted?.accountId).toBe(WORK);
  });

  it("leaves an agent on an account it can still work on, however it's routed now", async () => {
    // A reload cancels what the agent is doing (background helpers too), so nothing moves it unasked.
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never,
        defaults: { claude: WORK, codex: null, pi: null },
        sessions: { picked: session(MAIN), followed: session(MAIN) },
        bindings: { picked: { accountId: WORK, source: "user", at: openedAt } },
      },
      [
        { id: "picked", status: "idle" },
        { id: "followed", status: "idle" },
      ],
    );
    expect((await service.alignSessions(paseo)).reopened).toEqual([]);
    expect(reopened).toEqual([]);
    const { agents } = await service.view(paseo);
    expect(agents.find((route) => route.agentId === "picked")).toMatchObject({ accountId: WORK, pendingAccountId: MAIN });
    expect((await store.read()).sessions.followed?.accountId).toBe(MAIN);
  });

  it("waits for an agent's background work before moving it off an account it can't work on", async () => {
    const { service, store, paseo, reopened, agents } = await setUpAgents(
      {
        accounts: [{ ...account(MAIN, "marketing", "main"), limitedUntil: inFuture() }, account(WORK, "work", "managed")] as never,
        defaults: { claude: WORK, codex: null, pi: null },
        sessions: { working: session(MAIN) },
      },
      [{ id: "working", status: "idle", backgroundWork: 1 }],
    );
    await service.alignSessions(paseo);
    expect(reopened).toEqual([]);
    expect((await store.read()).sessions.working?.accountId).toBe(MAIN);

    agents[0]!.backgroundWork.count = 0;
    await service.alignSessions(paseo);
    expect(reopened).toEqual(["working"]);
    expect((await store.read()).sessions.working?.accountId).toBe(WORK);
  });

  it("doesn't wait for background work when an agent is switched by hand or fails over at a limit", async () => {
    // A dev server can run for hours: only moves nobody asked for wait for it.
    const { service, store, paseo, context, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { picked: session(MAIN), failing: session(MAIN) },
      },
      [
        { id: "picked", status: "idle", backgroundWork: 1 },
        { id: "failing", status: "idle", backgroundWork: 1 },
      ],
    );
    await service.setAgentAccount(paseo, "picked", WORK);
    expect(reopened).toEqual(["picked"]);
    expect((await store.read()).sessions.picked?.accountId).toBe(WORK);

    await service.onTurnEnded({ agent: { id: "failing", provider: "claude" }, turnId: null, outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never, context);
    expect(reopened).toEqual(["picked", "failing"]);
    expect((await store.read()).sessions.failing?.accountId).toBe(WORK);
  });

  it("carries an agent on at a limit once the move that had it is done, background work and all", async () => {
    const { service, store, context, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { failing: session(MAIN) },
      },
      [{ id: "failing", status: "idle", backgroundWork: 1 }],
    );
    // Alignment has the agent (looking it over, say) as its turn ends at the limit.
    const release = (service as unknown as { tryClaim(agentId: string): (() => void) | null }).tryClaim("failing")!;
    const ended = service.onTurnEnded({ agent: { id: "failing", provider: "claude" }, turnId: null, outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never, context);
    await vi.waitFor(async () => expect((await store.read()).accounts.find((entry) => entry.id === MAIN)?.limitedUntil).not.toBeNull());
    expect(reopened).toEqual([]);
    release();
    await ended;
    expect(reopened).toEqual(["failing"]);
    expect((await store.read()).sessions.failing?.accountId).toBe(WORK);
  });

  it("leaves an agent alone when the move alignment was about to finish was dropped meanwhile", async () => {
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { serving: session(MAIN) },
        bindings: { serving: { accountId: WORK, source: "user", at: openedAt } },
      },
      [{ id: "serving", status: "idle", backgroundWork: 1 }],
    );
    // As when alignment reaches an agent whose waiting move a turn end has just dropped.
    await (service as unknown as { finishDeferred(paseo: unknown, agentId: string, family: string, polled: boolean): Promise<void> }).finishDeferred(paseo, "serving", "claude", true);
    expect(reopened).toEqual([]);
    expect((await store.read()).sessions.serving?.accountId).toBe(MAIN);
  });

  it("doesn't promise a move left for the turn that will be dropped when it ends", async () => {
    const { service, paseo } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { busy: session(MAIN) },
        bindings: { busy: { accountId: WORK, source: "user", at: openedAt } },
      },
      [{ id: "busy", status: "running" }],
    );
    // Left by alignment for the turn, though the agent's account works: it's dropped at the turn's end.
    (service as unknown as { deferred: Map<string, { row: null; unattended: boolean }> }).deferred.set("busy", { row: null, unattended: true });
    expect((await service.view(paseo)).agents.find((route) => route.agentId === "busy")?.waiting).toBe("restart");
    // One the user asked for still happens when the turn ends.
    (service as unknown as { deferred: Map<string, { row: null; unattended: boolean }> }).deferred.set("busy", { row: null, unattended: false });
    expect((await service.view(paseo)).agents.find((route) => route.agentId === "busy")?.waiting).toBe("turn");
  });

  it("leaves an agent with background work when moving idle agents off an account at its limit", async () => {
    const { service, store, paseo, context, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { failing: session(MAIN), quiet: session(MAIN), serving: session(MAIN) },
      },
      [
        { id: "failing", status: "idle" },
        // Looked at first, so it's been passed over by the time "quiet" moves.
        { id: "serving", status: "idle", backgroundWork: 1 },
        { id: "quiet", status: "idle" },
      ],
    );
    service.setPreferences(preferences.schema.parse({ autoSwitch: true, autoContinue: false, moveAgentsOnDefaultChange: false }));
    await service.onTurnEnded({ agent: { id: "failing", provider: "claude" }, turnId: null, outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never, context);
    await vi.waitFor(() => expect(reopened).toContain("quiet"));
    expect(reopened).not.toContain("serving");
    const state = await store.read();
    expect(state.sessions.serving?.accountId).toBe(MAIN);
    // Passed over, not pinned to the next account and left waiting: alignment moves it once its work stops.
    expect(state.bindings.serving).toBeUndefined();
    expect((await service.view(paseo)).agents.find((route) => route.agentId === "serving")?.waiting).toBe("background");
  });

  it("moves a later Opus agent off an account at its limit when an earlier Fable agent has nowhere to go", async () => {
    const { service, store, context, reopened } = await setUpAgents(
      {
        accounts: [
          account(MAIN, "marketing", "main"),
          // The only other account has no Fable room, so a Fable agent can't go anywhere.
          { ...account(WORK, "work", "managed"), modelLimits: { fable: { until: inFuture(), at: inPast(), source: "turn" as const } } },
        ] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { failing: session(MAIN), "fable-agent": session(MAIN), "opus-agent": session(MAIN) },
      },
      [
        { id: "failing", status: "idle", model: "claude-opus-4-1" },
        // Listed first, so the pass meets it before "opus-agent".
        { id: "fable-agent", status: "idle", model: "claude-fable-5-2" },
        { id: "opus-agent", status: "idle", model: "claude-opus-4-1" },
      ],
    );
    service.setPreferences(preferences.schema.parse({ autoSwitch: true, autoContinue: false, moveAgentsOnDefaultChange: false }));
    await service.onTurnEnded({ agent: { id: "failing", provider: "claude" }, turnId: null, outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never, context);
    await vi.waitFor(() => expect(reopened).toContain("opus-agent"));
    expect(reopened).not.toContain("fable-agent");
    await vi.waitFor(async () => expect((await store.read()).sessions["opus-agent"]?.accountId).toBe(WORK));
    expect((await store.read()).sessions["fable-agent"]?.accountId).toBe(MAIN);
  });

  it("keeps a deferred move waiting for background work only when nobody asked for it", async () => {
    const { service, store, paseo, context, reopened, agents } = await setUpAgents(
      {
        accounts: [{ ...account(MAIN, "marketing", "main"), limitedUntil: inFuture() }, account(WORK, "work", "managed"), account("claude-spare", "spare", "managed")] as never,
        defaults: { claude: WORK, codex: null, pi: null },
        sessions: { drifted: session(MAIN), picked: session(WORK) },
      },
      [
        { id: "drifted", status: "running" },
        { id: "picked", status: "running" },
      ],
    );
    // Alignment's move waits for the turn; the turn ends with a dev server still running.
    expect((await service.alignSessions(paseo)).deferred).toEqual(["drifted"]);
    agents[0]!.status = "idle";
    agents[0]!.backgroundWork.count = 1;
    await service.onTurnEnded({ agent: { id: "drifted", provider: "claude" }, turnId: null, outcome: { kind: "completed" }, timeline: [] } as never, context);
    expect(reopened).toEqual([]);

    // A switch the user asked for waits for the turn, and once alignment finds it idle, not for background work.
    await service.setAgentAccount(paseo, "picked", "claude-spare");
    expect(reopened).toEqual([]);
    agents[1]!.status = "idle";
    agents[1]!.backgroundWork.count = 1;
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5_000); // past the daemon's cached list of agents
      await service.alignSessions(paseo);
    } finally {
      vi.useRealTimers();
    }
    expect(reopened).toEqual(["picked"]);
    expect((await store.read()).sessions.picked?.accountId).toBe("claude-spare");
  });

  it("says when each pending move happens", async () => {
    const limited = await setUpAgents(
      {
        accounts: [{ ...account(MAIN, "marketing", "main"), limitedUntil: inFuture() }, account(WORK, "work", "managed")] as never,
        defaults: { claude: WORK, codex: null, pi: null },
        sessions: { idle: session(MAIN), working: session(MAIN), busy: session(MAIN) },
      },
      [
        { id: "idle", status: "idle" },
        { id: "working", status: "idle", backgroundWork: 2 },
        { id: "busy", status: "running", backgroundWork: 2 },
      ],
    );
    // Off a limited account, alignment moves it once it's idle, its background work stops, or its turn ends.
    const off = Object.fromEntries((await limited.service.view(limited.paseo)).agents.map((route) => [route.agentId, route.waiting]));
    expect(off).toEqual({ idle: "idle", working: "background", busy: "turn" });

    // Off an account that still works, nothing moves it unasked: it moves when its session next starts.
    const working = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { picked: session(MAIN), busy: session(MAIN) },
        bindings: { picked: { accountId: WORK, source: "user", at: openedAt }, busy: { accountId: WORK, source: "user", at: openedAt } },
      },
      [
        { id: "picked", status: "idle" },
        { id: "busy", status: "running", backgroundWork: 1 },
      ],
    );
    // Nothing moves either when the turn ends, so not "when its current turn ends".
    const later = (await working.service.view(working.paseo)).agents;
    expect(later).toEqual([
      expect.objectContaining({ agentId: "picked", pendingAccountId: MAIN, waiting: "restart" }),
      expect.objectContaining({ agentId: "busy", pendingAccountId: MAIN, waiting: "restart" }),
    ]);
  });

  it("moves an agent whose last turn failed when it's switched", async () => {
    // A failed turn leaves the agent in "error" with its session still open: its next message goes to
    // that session as it is, so only a reload moves it.
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        sessions: { failed: session(MAIN) },
      },
      [{ id: "failed", status: "error" }],
    );
    const summary = await service.setAgentAccount(paseo, "failed", WORK);
    expect(summary.reopened).toEqual(["failed"]);
    expect(reopened).toEqual(["failed"]);
    expect((await store.read()).sessions.failed?.accountId).toBe(WORK);
  });

  it("keeps each open agent that follows the default on the account it runs on, and nothing else", async () => {
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null, pi: null },
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
          defaults: { claude: MAIN, codex: null, pi: null },
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

  it("moves a Fable agent off an account whose Fable window is full, and keeps an Opus agent there", async () => {
    const { service, store, paseo, reopened } = await setUpAgents(
      {
        accounts: [
          account(MAIN, "marketing", "main"),
          { ...account(WORK, "work", "managed"), modelLimits: { fable: { until: inFuture(), at: inPast(), source: "turn" as const } } },
          account(HELLO, "hello", "managed"),
        ] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        bindings: {},
        sessions: { "fable-agent": session(WORK), "opus-agent": session(WORK) },
      },
      [
        { id: "fable-agent", status: "idle", model: "claude-fable-5-2" },
        { id: "opus-agent", status: "idle", model: "claude-opus-4-1" },
      ],
    );
    service.setPreferences(KEEP);
    expect(await service.setDefault(paseo, HELLO)).toEqual({ ...NOTHING_MOVED, reopened: ["fable-agent"] });
    expect(reopened).toEqual(["fable-agent"]);
    const state = await store.read();
    expect(state.sessions["fable-agent"]?.accountId).toBe(HELLO);
    expect(state.bindings["fable-agent"]).toBeUndefined();
    // The Opus agent can stay on `work`, so it is kept there, as it would be without the limit.
    expect(state.bindings["opus-agent"]).toMatchObject({ accountId: WORK, source: "auto" });
    expect(state.sessions["opus-agent"]?.accountId).toBe(WORK);
  });

  it("changes nothing when the account is already the default", async () => {
    const accounts = [account(MAIN, "marketing", "main"), account(WORK, "work", "managed")] as never;
    const agents = [
      { id: "idle", status: "idle" },
      { id: "busy", status: "running" },
    ];
    for (const prefs of [KEEP, preferences.schema.parse({})]) {
      const { service, store, paseo, reopened } = await setUpAgents(
        { accounts, defaults: { claude: WORK, codex: null, pi: null }, bindings: {}, sessions: { idle: session(WORK), busy: session(WORK) } },
        agents,
      );
      service.setPreferences(prefs);
      expect(await service.setDefault(paseo, WORK)).toEqual(NOTHING_MOVED);
      expect((await store.read()).bindings).toEqual({});
      expect(reopened).toEqual([]);
    }

    // Until another account is chosen, the CLI login is the default.
    const { service, store, paseo, reopened } = await setUpAgents(
      { accounts, defaults: { claude: null, codex: null, pi: null }, bindings: {}, sessions: { idle: session(MAIN), busy: session(MAIN) } },
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
        defaults: { claude: WORK, codex: null, pi: null },
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
        defaults: { claude: WORK, codex: null, pi: null },
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
        defaults: { claude: null, codex: null, pi: null },
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
        defaults: { claude: null, codex: CODEX_MAIN, pi: null },
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

  it("doesn't let alignment move open agents before they're kept", async () => {
    // The new default is in place while a session still being routed holds up keeping the open
    // agents, for up to 5 s. An alignment pass then would take them for agents that follow it.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let preparing = false;
    const { service, store, paseo, context, reopened } = await setUpAgents(
      {
        accounts: [account(MAIN, "marketing", "main"), account(WORK, "work", "managed"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: WORK, codex: null, pi: null },
        bindings: {},
        sessions: { idle: session(WORK) },
      },
      [
        { id: "starting", status: "initializing" },
        { id: "idle", status: "idle" },
      ],
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
    const opening = service.onSessionOpen(
      { agentId: "starting", provider: "claude", reason: "create", purpose: "interactive", env: {} } as never,
      context,
    );
    await vi.waitFor(() => expect(preparing).toBe(true));
    const changing = service.setDefault(paseo, HELLO);
    await vi.waitFor(async () => expect((await store.read()).defaults.claude).toBe(HELLO));
    expect(await service.alignSessions(paseo)).toEqual(NOTHING_MOVED);
    release();
    await Promise.all([changing, opening]);

    expect(reopened).toEqual([]);
    expect((await store.read()).bindings.idle).toMatchObject({ accountId: WORK, source: "auto" });
  });
});

describe("a limit hit while the agent is being moved", () => {
  const openedAt = "2026-09-23T07:00:00.000Z";
  const OTHER = "agent-2";
  const state = (bindings: StoredState["bindings"] = {}) => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null, pi: null },
    bindings,
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });
  const hit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" });
  const limitedUntil = async (store: StateStore, id: string) => (await store.read()).accounts.find((entry) => entry.id === id)?.limitedUntil ?? null;

  it("records the limit on the account the turn ran on, and leaves the agent where it went meanwhile", async () => {
    let moveAway = async () => {};
    const { store, reopened, notes, limitTurn } = await setUp(state(), hit, {
      recent: async () => {
        await moveAway(); // the user picked hello while the turn's timeline was being read
        return { entries: [] };
      },
    });
    moveAway = async () => {
      await store.update((draft) => {
        draft.bindings[AGENT] = { accountId: HELLO, source: "user", at: new Date().toISOString() };
        draft.sessions[AGENT] = { accountId: HELLO, family: "claude", openedAt: new Date().toISOString() };
      });
    };
    await limitTurn();
    expect(await limitedUntil(store, MAIN)).not.toBeNull();
    expect(await limitedUntil(store, HELLO)).toBeNull();
    expect(reopened).toEqual([]);
    expect(notes).toEqual([]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("records the limit when another move has the agent, and leaves the agent where that move put it", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = () => {};
    const reloading = new Promise<void>((resolve) => (started = resolve));
    const { service, store, reopened, paseo, limitTurn } = await setUp(state(), hit, {
      reloading: () => {
        started();
        return gate;
      },
    });
    const moving = service.setAgentAccount(paseo as never, AGENT, HELLO);
    await reloading;
    // Recorded at once; failover waits for the move, then finds the agent already moved.
    const limiting = limitTurn();
    await vi.waitFor(async () => expect(await limitedUntil(store, MAIN)).not.toBeNull());
    release();
    expect((await moving).reopened).toEqual([AGENT]);
    await limiting;
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("leaves the other idle agents on an account a reset refilled just before the limit came in", async () => {
    const { service, store, reopened, paseo, limitTurn } = await setUp(
      { ...state(), sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt }, [OTHER]: { accountId: MAIN, family: "claude", openedAt } } },
      hit,
      { claude: { redeemReset: async () => ({ outcome: "reset", message: "Limits reset", left: 0 }) } },
    );
    const agent = (await paseo.agents.ref().refresh()).agent!;
    const other = { ...agent, id: OTHER };
    paseo.agents.list = async () => ({ entries: [{ agent }, { agent: other }], pageInfo: { hasMore: false, nextCursor: null } });
    const { ref } = paseo.agents;
    paseo.agents.ref = ((id: string) => {
      const handle = ref();
      return { ...handle, refresh: async () => ({ agent: id === OTHER ? other : agent }) };
    }) as typeof ref;
    expect((await redeemNow(service, paseo, MAIN)).outcome).toBe("reset");
    await limitTurn();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(reopened).toEqual([]);
    expect(await limitedUntil(store, MAIN)).toBeNull();
    expect((await store.read()).sessions[OTHER]?.accountId).toBe(MAIN);
  });
});

describe("using a reset for a stopped agent", () => {
  const openedAt = "2026-09-23T07:00:00.000Z";
  const state = () => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null, pi: null },
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });
  const hit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "" });
  const reset = { redeemReset: async () => ({ outcome: "reset" as const, message: "Limits reset.", left: 0 }) };

  it("carries on an agent whose last turn stopped at the limit", async () => {
    const { service, paseo, sent } = await setUp(state(), hit, {
      claude: reset,
      recent: inTurn("t", { type: "assistant_message", text: "You've hit your session limit · resets 3pm" }),
      detectLimit: detectClaudeLimit,
    });
    expect(await redeemNow(service, paseo, MAIN, AGENT)).toMatchObject({ outcome: "reset", continued: true });
    expect(sent).toHaveLength(1);
  });

  it("leaves the agent alone when its timeline can't be read, as nothing says the limit stopped it", async () => {
    const { service, paseo, sent } = await setUp(state(), hit, {
      claude: reset,
      recent: async () => {
        throw new Error("Not connected");
      },
      detectLimit: detectClaudeLimit,
    });
    expect(await redeemNow(service, paseo, MAIN, AGENT)).toMatchObject({ outcome: "reset", continued: false });
    expect(sent).toEqual([]);
  });
});

describe("aligning agents with their accounts", () => {
  const openedAt = "2026-09-23T07:00:00.000Z";
  const onMarketing = (bindings: StoredState["bindings"] = {}) => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null, pi: null },
    bindings,
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });
  const hit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "" });
  const full = (accountId: string) => (draft: StoredState) => {
    const target = draft.accounts.find((entry) => entry.id === accountId);
    if (target) target.limitedUntil = inFuture();
  };
  const turnEnded = { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "completed" }, timeline: [] } as never;

  it("leaves an agent on a working account when switching no longer skips the one picked for it", async () => {
    // hello was full when the user picked it, so the agent stayed on marketing while switching was
    // on. Turning switching off routes it to hello, but marketing still works: a reload would cancel
    // what it's doing, so it moves when its session next opens, and its button says so meanwhile.
    const { service, store, reopened, notes, paseo } = await setUp(
      onMarketing({ [AGENT]: { accountId: HELLO, source: "user", at: openedAt } }),
      hit,
    );
    await store.update(full(HELLO));
    service.attach(paseo as never);
    expect((await service.alignSessions(paseo as never)).reopened).toEqual([]);

    service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    expect((await service.alignSessions(paseo as never)).reopened).toEqual([]);
    expect(reopened).toEqual([]);
    expect(notes).toEqual([]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
    const route = (await service.view(paseo as never)).agents.find((entry) => entry.agentId === AGENT);
    expect(route).toMatchObject({ accountId: HELLO, pendingAccountId: MAIN });
  });

  it("moves an idle agent off an account a usage reading found full when switching is on", async () => {
    const { service, store, notes, paseo } = await setUp(onMarketing(), hit);
    await store.update(full(MAIN));

    expect((await service.alignSessions(paseo as never)).reopened).toEqual([AGENT]);
    const state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(state.bindings[AGENT]).toMatchObject({ accountId: HELLO, source: "auto" });
    expect(notes[0]).toMatchObject({ from: "marketing", to: "hello", reason: "limit", outcome: "switched" });
  });

  it("leaves an agent on a full account when switching is off", async () => {
    const { service, store, reopened, paseo } = await setUp(onMarketing(), hit);
    service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    await store.update(full(MAIN));

    expect((await service.alignSessions(paseo as never)).reopened).toEqual([]);
    expect(reopened).toEqual([]);
  });

  it("drops a move it left for the turn when the account came back meanwhile", async () => {
    const { service, store, reopened, paseo, agent } = await setUp(onMarketing(), hit);
    await store.update((draft) => {
      full(MAIN)(draft);
      draft.defaults.claude = HELLO;
    });
    agent.status = "running";
    expect((await service.alignSessions(paseo as never)).deferred).toEqual([AGENT]);
    // The limit lifts during the turn: marketing works again, so nobody's asked for the move any more.
    await store.update((draft) => {
      const target = draft.accounts.find((entry) => entry.id === MAIN);
      if (target) target.limitedUntil = null;
    });
    agent.status = "idle";
    await service.onTurnEnded(turnEnded, { paseo } as never);
    expect(reopened).toEqual([]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
  });

  it("moves a busy agent after its turn", async () => {
    const { service, store, reopened, paseo, agent } = await setUp(onMarketing(), hit);
    await store.update(full(MAIN));
    agent.status = "running";

    expect((await service.alignSessions(paseo as never)).deferred).toEqual([AGENT]);
    expect(reopened).toEqual([]);
    agent.status = "idle";
    await service.onTurnEnded(turnEnded, { paseo } as never);
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("leaves an agent whose turn just ended to failover", async () => {
    const { service, store, reopened, paseo } = await setUp(onMarketing(), hit);
    await service.onTurnEnded(turnEnded, { paseo } as never);
    await store.update(full(MAIN));

    expect((await service.alignSessions(paseo as never)).reopened).toEqual([]);
    expect(reopened).toEqual([]);
  });

  it("doesn't try a move that didn't land again right away", async () => {
    const { service, store, reopened, paseo } = await setUp(onMarketing(), hit, { reload: "fails" });
    await store.update(full(MAIN));

    expect((await service.alignSessions(paseo as never)).failed).toHaveLength(1);
    await service.alignSessions(paseo as never);
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
  });

  it("doesn't promise a move alignment holds back after a try that didn't land, until it tries again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { service, store, reopened, paseo } = await setUp(onMarketing(), hit);
      await store.update((draft) => {
        const marketing = draft.accounts.find((entry) => entry.id === MAIN);
        if (marketing) marketing.limitedUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      });
      const waiting = async () => (await service.view(paseo as never)).agents.find((route) => route.agentId === AGENT)?.waiting;
      expect(await waiting()).toBe("idle");
      // As alignment records a reload of it that didn't land (see `alignSessions`).
      const target = (await service.view(paseo as never)).agents.find((route) => route.agentId === AGENT)!.accountId;
      (service as unknown as { alignedAt: Map<string, { accountId: string; at: number }> }).alignedAt.set(AGENT, { accountId: target, at: Date.now() });
      // Alignment won't try again for a while, so the button doesn't say "once it's idle" meanwhile.
      expect(await waiting()).toBe("restart");
      expect((await service.alignSessions(paseo as never)).reopened).toEqual([]);
      vi.setSystemTime(Date.now() + 31 * 60_000);
      expect(await waiting()).toBe("idle");
      expect((await service.alignSessions(paseo as never)).reopened).toEqual([AGENT]);
      expect(reopened).toEqual([AGENT]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doesn't promise a move the switch guard holds back", async () => {
    const { service, store, paseo } = await setUp(onMarketing(), hit);
    await store.update(full(MAIN));
    const waiting = async () => (await service.view(paseo as never)).agents.find((route) => route.agentId === AGENT)?.waiting;
    expect(await waiting()).toBe("idle");
    const guard = (service as unknown as { switchGuard: SwitchGuard }).switchGuard;
    for (let move = 0; move < guard.limit; move++) guard.note(AGENT, Date.now());
    expect(await waiting()).toBe("restart");
    expect((await service.alignSessions(paseo as never)).reopened).toEqual([]);
  });

  it("says once that it couldn't move an agent, not at every retry", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { service, store, reopened, notes, paseo } = await setUp(onMarketing(), hit, { reload: "fails" });
      await store.update((draft) => {
        const marketing = draft.accounts.find((entry) => entry.id === MAIN);
        if (marketing) marketing.limitedUntil = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
      });
      await service.alignSessions(paseo as never);
      vi.setSystemTime(Date.now() + 31 * 60_000);
      await service.alignSessions(paseo as never);
      expect(reopened).toEqual([AGENT, AGENT]);
      expect(notes).toEqual([expect.objectContaining({ from: "marketing", to: "hello", outcome: "pending" })]);
      expect(notes[0]?.detail).toMatch(/^Reloading it didn't work: Timed out closing previous session during refresh\.$/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves an agent on a usable stand-in for its disabled account, whichever ranks first", async () => {
    const WORK = "claude-work";
    const { service, store, reopened, paseo } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), { ...account(HELLO, "hello", "managed"), disabled: true }, account(WORK, "work", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
        bindings: { [AGENT]: { accountId: HELLO, source: "user", at: openedAt } },
        sessions: { [AGENT]: { accountId: WORK, family: "claude", openedAt } },
      },
      hit,
    );
    // Marketing, the default, ranks first among the stand-ins now, but work does just as well.
    expect((await service.alignSessions(paseo as never)).reopened).toEqual([]);
    expect(reopened).toEqual([]);
    expect((await service.view(paseo as never)).agents).toEqual([expect.objectContaining({ accountId: WORK, pendingAccountId: null })]);

    // Once work can't stand in, the agent moves to one that can, and still returns when hello is back.
    await store.update(full(WORK));
    expect((await service.alignSessions(paseo as never)).reopened).toEqual([AGENT]);
    const state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(MAIN);
    expect(state.bindings[AGENT]?.accountId).toBe(HELLO);
  });

  it("reopens a closed agent on the roomiest stand-in, not on the CLI login it no longer runs on", async () => {
    const WORK = "claude-work";
    const used = (percent: number): UsageRead => ({
      fetchedAt: new Date().toISOString(),
      windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: null }],
      error: null,
      cached: false,
      resets: null,
    });
    const { service, store, paseo, agent } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed"), account(WORK, "work", "managed")] as never,
        defaults: { claude: HELLO, codex: null, pi: null },
        sessions: {},
      },
      hit,
      { claude: { usage: async (home: string | null) => used(home === null ? 80 : 10) } },
    );
    await store.update(full(HELLO));
    for (const id of [MAIN, WORK]) await service.refreshUsage(id, true);
    // Open with no session of its own on record, it runs on the CLI login, and stays there.
    expect((await service.view(paseo as never)).agents).toEqual([expect.objectContaining({ accountId: MAIN })]);

    // Closed, it runs on none: it goes where there's the most room, and its account button says so first.
    agent.status = "closed";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 5_000); // past the daemon's cached list of agents
      expect((await service.view(paseo as never)).agents).toEqual([expect.objectContaining({ accountId: WORK })]);
    } finally {
      vi.useRealTimers();
    }
    const opened = await service.onSessionOpen(
      { agentId: AGENT, provider: "claude", reason: "resume", purpose: "interactive", env: {} } as never,
      { paseo } as never,
    );
    expect(opened?.env.CLAUDE_CONFIG_DIR).toBe(join(tmpdir(), WORK));
  });

  it("leaves an agent the user has just sent a message to until it's quiet", async () => {
    const { service, store, reopened, paseo, agent } = await setUp(onMarketing(), hit);
    await store.update(full(MAIN));
    agent.lastUserMessageAt = new Date().toISOString(); // its turn hasn't started yet

    expect(await service.alignSessions(paseo as never)).toMatchObject({ reopened: [], deferred: [] });
    expect(reopened).toEqual([]);
    // A turn starting is the same signal.
    agent.lastUserMessageAt = openedAt;
    await service.onTurnStarted({ id: AGENT, provider: "claude" }, { paseo } as never);
    expect((await service.alignSessions(paseo as never)).reopened).toEqual([]);
    expect(reopened).toEqual([]);
  });

  it("tries again at the next check, without a note, when Paseo can't say what the agent is doing", async () => {
    const { service, store, reopened, notes, paseo } = await setUp(onMarketing(), hit);
    await store.update(full(MAIN));
    // The connection drops after alignment found the agent: the second look is the one in the move.
    const { ref } = paseo.agents;
    let looks = 0;
    paseo.agents.ref = () => {
      const handle = ref();
      return {
        ...handle,
        refresh: async () => {
          looks += 1;
          if (looks === 2) throw new Error("Not connected");
          return handle.refresh();
        },
      };
    };

    expect((await service.alignSessions(paseo as never)).failed).toEqual([{ agentId: AGENT, error: expect.stringContaining("Not connected") }]);
    expect(reopened).toEqual([]);
    expect(notes).toEqual([]);
    expect((await service.alignSessions(paseo as never)).reopened).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("looks at the agent again right before reloading it, and waits for the turn the user just started", async () => {
    const { service, store, reopened, paseo, agent } = await setUp(onMarketing(), hit);
    await store.update(full(MAIN));
    // The message arrives while alignment gets ready: the third look is the one just before the reload.
    const { ref } = paseo.agents;
    let looks = 0;
    paseo.agents.ref = () => {
      const handle = ref();
      return {
        ...handle,
        refresh: async () => {
          looks += 1;
          if (looks === 3) agent.lastUserMessageAt = new Date().toISOString();
          return handle.refresh();
        },
      };
    };

    expect((await service.alignSessions(paseo as never)).deferred).toEqual([AGENT]);
    expect(reopened).toEqual([]);
    await service.onTurnEnded(turnEnded, { paseo } as never);
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });
});

describe("a move asked for during a turn", () => {
  const openedAt = "2026-09-23T07:00:00.000Z";
  const WORK = "claude-work";
  const threeAccounts = () => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed"), account(WORK, "work", "managed")] as never,
    defaults: { claude: MAIN, codex: null, pi: null },
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });
  const limit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" });

  it("still happens when the turn ends at a limit and automatic switching is off", async () => {
    const { service, store, reopened, notes, paseo, agent, limitTurn } = await setUp(threeAccounts(), limit);
    service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    agent.status = "running";
    expect((await service.setAgentAccount(paseo as never, AGENT, WORK)).deferred).toEqual([AGENT]);
    agent.status = "idle";
    await limitTurn();

    const state = await store.read();
    expect(state.accounts.find((entry) => entry.id === MAIN)?.limitedUntil).not.toBeNull();
    expect(state.sessions[AGENT]?.accountId).toBe(WORK);
    expect(reopened).toEqual([AGENT]);
    expect(notes).toEqual([expect.objectContaining({ from: "marketing", to: "work", reason: "manual", outcome: "switched" })]);
  });

  it("goes where it was asked to when automatic switching moves the agent at that limit", async () => {
    const { service, store, reopened, notes, paseo, agent, limitTurn } = await setUp(threeAccounts(), limit);
    agent.status = "running";
    await service.setAgentAccount(paseo as never, AGENT, WORK);
    agent.status = "idle";
    await limitTurn();

    // Hello has the most room by the usual ranking, but the user asked for work.
    const state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(WORK);
    expect(state.bindings[AGENT]).toMatchObject({ accountId: WORK, source: "user" });
    expect(reopened).toEqual([AGENT]);
    expect(notes).toEqual([expect.objectContaining({ from: "marketing", to: "work", reason: "limit", outcome: "switched" })]);
  });

  it("happens once an agent that was only starting is idle, without a turn", async () => {
    const { service, store, reopened, notes, paseo, agent } = await setUp(threeAccounts(), limit);
    agent.status = "initializing";
    expect((await service.setAgentAccount(paseo as never, AGENT, WORK)).deferred).toEqual([AGENT]);
    agent.status = "idle";
    await service.alignSessions(paseo as never);

    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(WORK);
    expect(notes).toEqual([expect.objectContaining({ to: "work", reason: "manual", outcome: "switched" })]);
  });
});

describe("moves that overlap", () => {
  const openedAt = "2026-09-23T07:00:00.000Z";
  const onMarketing = () => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null, pi: null },
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });
  const hit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "" });

  it("reload an agent once, and note it once", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = () => {};
    const reloading = new Promise<void>((resolve) => (started = resolve));
    const { service, store, reopened, notes, paseo } = await setUp(onMarketing(), hit, {
      reloading: () => {
        started();
        return gate;
      },
    });
    const picking = service.setAgentAccount(paseo as never, AGENT, HELLO);
    await reloading;
    // The 30-second upkeep comes round while the user's switch is reloading the agent.
    expect((await service.alignSessions(paseo as never)).reopened).toEqual([]);
    release();

    expect((await picking).reopened).toEqual([AGENT]);
    expect(reopened).toEqual([AGENT]);
    expect(notes).toHaveLength(1);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("don't undo a session another reload opened after one that failed", async () => {
    const { service, store, paseo } = await setUp(onMarketing(), hit, { reload: "fails after another" });
    expect((await service.setAgentAccount(paseo as never, AGENT, HELLO)).failed).toHaveLength(1);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });
});

describe("picking an account by hand", () => {
  const openedAt = "2026-09-23T07:00:00.000Z";
  const WORK = "claude-work";
  const threeAccounts = (hello: Partial<StoredAccount> = {}) => ({
    accounts: [account(MAIN, "marketing", "main"), { ...account(HELLO, "hello", "managed"), ...hello }, account(WORK, "work", "managed")] as never,
    defaults: { claude: MAIN, codex: null, pi: null },
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });
  const limit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your session limit" });

  it("refuses an account at its limit while switching is on, rather than quietly using another", async () => {
    const { service, store, reopened, paseo } = await setUp(threeAccounts({ limitedUntil: inFuture(), limitKind: "window" }), limit);
    await expect(service.setAgentAccount(paseo as never, AGENT, HELLO)).rejects.toThrow(/hello is at its limit/);
    expect((await store.read()).bindings[AGENT]).toBeUndefined();
    expect(reopened).toEqual([]);
    expect((await service.view(paseo as never)).autoSwitch).toBe(true); // so the account button can say so too

    // With switching off, the agent goes there and stops at the limit, as the user asked.
    service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    expect((await service.setAgentAccount(paseo as never, AGENT, HELLO)).reopened).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("goes where the user picked during a failover, and keeps the pick", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let asked = () => {};
    const reading = new Promise<void>((resolve) => (asked = resolve));
    const { service, store, reopened, paseo, limitTurn } = await setUp(threeAccounts(), limit, {
      claude: {
        // Failover reads the full account's usage before it picks where to go.
        usage: async () => {
          asked();
          await gate;
          return { fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null };
        },
      },
    });
    const failing = limitTurn();
    await reading;
    const picking = service.setAgentAccount(paseo as never, AGENT, WORK);
    await vi.waitFor(async () => expect((await store.read()).bindings[AGENT]?.accountId).toBe(WORK));
    release();
    const [, picked] = await Promise.all([failing, picking]);

    const state = await store.read();
    expect(state.bindings[AGENT]).toMatchObject({ accountId: WORK, source: "user" });
    expect(state.sessions[AGENT]?.accountId).toBe(WORK);
    expect(reopened).toEqual([AGENT]);
    expect(picked).toMatchObject({ reopened: [], failed: [], pending: [] }); // failover already moved it there
  });
});

describe("telling the user how a move went", () => {
  const openedAt = "2026-09-23T07:00:00.000Z";
  const onMarketing = () => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null, pi: null },
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });
  const hit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "" });

  it("notes a switch whose reload didn't work, and says the agent moves when its session next starts", async () => {
    const { service, notes, paseo } = await setUp(onMarketing(), hit, { reload: "fails" });
    const summary = await service.setAgentAccount(paseo as never, AGENT, HELLO);
    expect(summary.failed).toEqual([{ agentId: AGENT, error: "Timed out closing previous session during refresh" }]);
    expect(notes).toEqual([expect.objectContaining({ from: "marketing", to: "hello", reason: "manual", outcome: "pending" })]);
    expect(notes[0]?.detail).toBe("Reloading it didn't work: Timed out closing previous session during refresh.");
    expect((await service.view(paseo as never)).agents).toEqual([
      expect.objectContaining({ accountId: HELLO, pendingAccountId: MAIN, waiting: "restart" }),
    ]);
  });

  it("says a busy agent moves when its turn ends", async () => {
    const { service, paseo, agent } = await setUp(onMarketing(), hit);
    agent.status = "running";
    expect((await service.setAgentAccount(paseo as never, AGENT, HELLO)).deferred).toEqual([AGENT]);
    expect((await service.view(paseo as never)).agents).toEqual([
      expect.objectContaining({ accountId: HELLO, pendingAccountId: MAIN, waiting: "turn" }),
    ]);
  });
});

describe("answering before Paseo gives up", () => {
  // Paseo fails an RPC after 30 s but doesn't stop it, so a user who retries could start it twice.
  const openedAt = "2026-09-23T07:00:00.000Z";
  const onMarketing = () => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null, pi: null },
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt } },
  });
  const hit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "" });

  beforeEach(() => void vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }));
  afterEach(() => void vi.useRealTimers());

  it("answers a move that takes long, and finishes it in the background", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = () => {};
    const reloading = new Promise<void>((resolve) => (started = resolve));
    const { service, store, notes, paseo } = await setUp(onMarketing(), hit, {
      reloading: () => {
        started();
        return gate;
      },
    });
    const answer = service.setAgentAccount(paseo as never, AGENT, HELLO);
    await reloading;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await answer).toMatchObject({ reopened: [], failed: [], pending: [AGENT] });

    release();
    await vi.waitFor(() => expect(notes).toHaveLength(1));
    expect(notes[0]).toMatchObject({ to: "hello", outcome: "switched" });
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("answers removing an account whose agents take long to move", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let started = () => {};
    const reloading = new Promise<void>((resolve) => (started = resolve));
    const { service, store, paseo } = await setUp(
      { ...onMarketing(), sessions: { [AGENT]: { accountId: HELLO, family: "claude" as const, openedAt } } },
      hit,
      {
        reloading: () => {
          started();
          return gate;
        },
      },
    );
    const answer = service.remove(paseo as never, HELLO);
    await reloading;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await answer).toEqual({ affected: 1, moves: { reopened: [], deferred: [], failed: [], pending: [AGENT], continuedIn: null } });

    release();
    await vi.waitFor(async () => expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN));
  });

  it("answers a reset that takes long, and never spends a second one", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    let spent = 0;
    const { service, paseo } = await setUp(onMarketing(), hit, {
      claude: {
        redeemReset: async () => {
          spent += 1;
          await gate;
          return { outcome: "reset", message: "Limits reset.", left: 0 };
        },
      },
    });
    const first = service.redeem(paseo as never, HELLO);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await first).toMatchObject({ outcome: "pending" });
    // Paseo had given up on it, so the user tries again.
    expect(await service.redeem(paseo as never, HELLO)).toMatchObject({ outcome: "pending", message: expect.stringMatching(/already being used/) });

    release();
    await vi.waitFor(async () => expect((await service.redeem(paseo as never, HELLO)).outcome).toBe("already_used"));
    expect(spent).toBe(1);
  });

  it.each([
    [true, "Still using the reset on marketing. Its limits show here once it's done, and the agent carries on; don't use another."],
    [false, "Still using the reset on marketing. Its limits show here once it's done; don't use another."],
  ])("says the agent carries on after a slow reset only when Keep going is on (%s)", async (autoContinue, message) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, paseo, sent } = await setUp(onMarketing(), hit, {
      claude: {
        redeemReset: async () => {
          await gate;
          return { outcome: "reset", message: "Limits reset.", left: 0 };
        },
      },
      // The agent's last turn did stop at the limit.
      recent: inTurn("t", { type: "assistant_message", text: "You've hit your session limit · resets 3pm" }),
      detectLimit: detectClaudeLimit,
    });
    service.setPreferences(preferences.schema.parse({ autoSwitch: true, autoContinue }));
    const asked = service.redeem(paseo as never, MAIN, AGENT);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await asked).toEqual({ outcome: "pending", message, left: null, continued: false });

    release();
    if (autoContinue) await vi.waitFor(() => expect(sent).toHaveLength(1));
    else {
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sent).toEqual([]);
    }
  });

  it("answers a usage refresh that has to renew a sign-in", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const { service, paseo } = await setUp(onMarketing(), hit, {
      claude: {
        usage: async () => {
          await gate;
          return { fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null };
        },
      },
    });
    const viewing = service.view(paseo as never, true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await viewing).accounts).toHaveLength(2);
    release();
  });

  it("reads only the account asked for, when one is", async () => {
    const read: Array<string | null> = [];
    const { service, paseo } = await setUp(onMarketing(), hit, {
      claude: {
        identity: async (home) => ({
          signedIn: true, email: null, organization: null, identity: null,
          plan: home ? "max" : "ultra",
        }),
        usage: async (home: string | null) => {
          read.push(home);
          return { fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null };
        },
      },
    });
    read.length = 0;
    const view = await service.view(paseo as never, true, HELLO);
    expect(view.accounts.find((entry) => entry.id === HELLO)?.plan).toBe("max");
    expect(view.accounts.find((entry) => entry.id === MAIN)?.plan).not.toBe("ultra");
    expect(read).toEqual([join(tmpdir(), HELLO)]);
  });
});

describe("a reading past its reset", () => {
  it("renews the sign-in, so an idle account that sat full is read again once it resets", async () => {
    const NOW = Date.parse("2026-10-24T12:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(NOW);
      const store = new StateStore(join(root, "state.json"));
      await store.update((draft) => Object.assign(draft, { accounts: [account(MAIN, "main", "main")], defaults: { claude: MAIN, codex: null, pi: null } }));
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
        { claude, codex: { ...claude, family: "codex", portable: false } as FamilyAdapter, pi: absentPi() },
        store,
        { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
        { locate: async () => "/usr/local/bin/paseo" } as unknown as Reopener,
      );
      services.push(service);
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
      Object.assign(draft, { accounts: [{ ...account(MAIN, "main", "main"), ...patch }], defaults: { claude: MAIN, codex: null, pi: null } }),
    );
    const claude = { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), usage };
    const service = new Service(
      { claude, codex: { ...claude, family: "codex", portable: false } as FamilyAdapter, pi: absentPi() },
      store,
      { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo" } as unknown as Reopener,
    );
    services.push(service);
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
        defaults: { claude: MAIN, codex: null, pi: null },
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

describe("pending placements", () => {
  it("records none for Paseo's helper sessions, which open in no workspace", async () => {
    const { service, paseo } = await setUp(
      {
        accounts: [account(MAIN, "work", "main"), account(HELLO, "personal", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
      },
      () => {
        throw new Error("unused");
      },
    );
    service.setPreferences(preferences.schema.parse({ balanceNewAgents: true }));
    const open = (agentId: string, extra: Record<string, unknown>) =>
      service.onSessionOpen({ agentId, provider: "claude", reason: "create", purpose: "interactive", env: {}, ...extra } as never, { paseo } as never);
    await open("commit-message", {});
    await open("hidden-helper", { workspaceId: "ws-1", background: true });
    expect(pendingOn(service, MAIN) + pendingOn(service, HELLO)).toBe(0);
    await open("new-agent", { workspaceId: "ws-1" });
    expect(pendingOn(service, MAIN) + pendingOn(service, HELLO)).toBe(1);
  });

  it("spreads concurrent new agents by pending placements", async () => {
    const { service, store, paseo } = await setUp(
      {
        accounts: [account(MAIN, "work", "main"), account(HELLO, "personal", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
      },
      () => {
        throw new Error("unused");
      },
    );
    service.setPreferences(preferences.schema.parse({ balanceNewAgents: true }));
    const context = { paseo } as never;
    const create = (agentId: string) =>
      service.onSessionOpen({ agentId, provider: "claude", reason: "create", purpose: "interactive", workspaceId: "ws-1", env: {} } as never, context);
    await Promise.all([create("new-a"), create("new-b")]);
    const { sessions } = await store.read();
    expect(new Set([sessions["new-a"]?.accountId, sessions["new-b"]?.accountId])).toEqual(new Set([MAIN, HELLO]));
  });

  it("view names the pacedNext account", async () => {
    const { service, paseo } = await setUp(
      {
        accounts: [account(MAIN, "work", "main"), account(HELLO, "personal", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
      },
      () => {
        throw new Error("unused");
      },
    );
    expect((await service.view(paseo as never)).pacedNext).toBeUndefined();
    service.setPreferences(preferences.schema.parse({ balanceNewAgents: true }));
    await service.onSessionOpen({ agentId: "new-a", provider: "claude", reason: "create", purpose: "interactive", workspaceId: "ws-1", env: {} } as never, { paseo } as never);
    const placed = (await service.view(paseo as never)).accounts.find((a) => a.pace && a.pace.pending > 0)?.id;
    expect(placed).toBeDefined();
    expect((await service.view(paseo as never)).pacedNext?.claude).toBe(placed === MAIN ? HELLO : MAIN);
  });

  it("logs pace scores for a balanced new agent", async () => {
    const { service, paseo } = await setUp(
      {
        accounts: [account(MAIN, "work", "main"), account(HELLO, "personal", "managed")] as never,
        defaults: { claude: MAIN, codex: null, pi: null },
      },
      () => {
        throw new Error("unused");
      },
    );
    service.setPreferences(preferences.schema.parse({ balanceNewAgents: true }));
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await service.onSessionOpen(
        { agentId: "agent-new", provider: "claude", reason: "create", purpose: "interactive", workspaceId: "ws-1", env: {} } as never,
        { paseo } as never,
      );
      expect(logged.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringMatching(/\[ZeroSub\] placed agent-new on .*5h .* wk .* score .* gated (yes|no) pending \d+ seen 5h/),
      );
    } finally {
      logged.mockRestore();
    }
  });
});

describe("an API account's refused key", () => {
  const API = "claude-api";

  it("marks the account and moves the agent to a subscription account", async () => {
    const refused = () => "Invalid API key · Fix external API key";
    const { store, reopened, notes, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), { ...account(API, "gateway", "managed"), auth: "api" }] as never,
        defaults: { claude: API, codex: null, pi: null },
        sessions: { [AGENT]: { accountId: API, family: "claude", openedAt: new Date().toISOString() } },
      },
      () => {
        throw new Error("unused: no limit in this turn");
      },
      { detectLimit: () => null, detectSignOut: refused },
    );
    await limitTurn();
    const state = await store.read();
    // `claude auth status` would still say "logged in" for any key, so the refusal is what counts.
    expect(state.accounts.find((a) => a.id === API)?.signedIn).toBe(false);
    expect(reopened).toEqual([AGENT]);
    expect(notes.at(-1)).toMatchObject({ from: "gateway", to: "marketing", outcome: "switched" });
  });

  it("leaves a subscription account alone when its login still checks out", async () => {
    const { store, reopened, limitTurn } = await setUp(
      {
        accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
        defaults: { claude: HELLO, codex: null, pi: null },
        sessions: { [AGENT]: { accountId: HELLO, family: "claude", openedAt: new Date().toISOString() } },
      },
      () => {
        throw new Error("unused: no limit in this turn");
      },
      { detectLimit: () => null, detectSignOut: () => "Not logged in · Please run /login" },
    );
    await limitTurn();
    expect((await store.read()).accounts.find((a) => a.id === HELLO)?.signedIn).toBe(true);
    expect(reopened).toEqual([]);
  });
});

describe("forking to the other provider by hand", () => {
  /** A ChatGPT agent out of room, and Claude accounts as given; the fork never gets as far as starting an agent. */
  async function refusal(claude: Array<Record<string, unknown>>) {
    const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) =>
      Object.assign(draft, {
        accounts: [{ ...account(CODEX_MAIN, "hello", "main"), family: "codex", limitedUntil: inFuture(), limitKind: "window" }, ...claude],
        defaults: { claude: MAIN, codex: CODEX_MAIN, pi: null },
      }),
    );
    const agent = { id: AGENT, provider: "codex", status: "idle", title: "Fix the build", archivedAt: null, labels: {} };
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      providers: { listAvailable: async () => ({ providers: [{ provider: "claude", available: true }, { provider: "codex", available: true }] }) },
      agents: {
        list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
        ref: () => ({ refresh: async () => ({ agent }) }),
      },
    };
    const service = new Service(
      {
        claude: claudeAdapter(() => ({ kind: "window", resetsAt: inFuture(), message: "" })),
        codex: { ...claudeAdapter(() => ({ kind: "window", resetsAt: null, message: "" })), family: "codex", portable: false } as FamilyAdapter,
        pi: absentPi(),
      },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo", reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    );
    return service.forkAgent(paseo as never, AGENT);
  }

  it("says an API account won't take the work over, rather than that every account is at its limit", async () => {
    const limited = { ...account(MAIN, "marketing", "main"), limitedUntil: inFuture(), limitKind: "window" };
    const api = { ...account("claude-api", "gateway", "managed"), auth: "api" };
    await expect(refusal([limited, api])).rejects.toThrow(/only Claude accounts with room use an API key/);
    await expect(refusal([limited])).rejects.toThrow("Every Claude account is at its limit too.");
    // The setting is suggested only where it would let the key take over: one on Anthropic's own API.
    const setting = /turn on "Use paid API accounts when every subscription is out"/;
    await expect(refusal([limited, { ...api, identity: "api|https://gw.example.com|0123456789abcdef" }])).rejects.toThrow(/pick it from the agent's account button\.$/);
    await expect(refusal([limited, { ...api, identity: "api|anthropic|0123456789abcdef" }])).rejects.toThrow(setting);
  });
});

describe("an API account at a limit with every other account out", () => {
  it("is never spent a banked reset on automatically, which it doesn't have", async () => {
    const redeemed: Array<string | null> = [];
    const api = { ...account("claude-api", "Gateway", "managed"), auth: "api" as const };
    const main = { ...account(MAIN, "main", "main"), limitedUntil: inFuture(), limitKind: "window" as const };
    const { service, limitTurn } = await setUp(
      {
        accounts: [main as never, api as never],
        defaults: { claude: "claude-api", codex: null, pi: null },
        sessions: { [AGENT]: { accountId: "claude-api", family: "claude", openedAt: "2026-09-23T07:00:00.000Z" } },
      },
      () => ({ kind: "window", resetsAt: inFuture(), message: "429 from the gateway" }),
      { claude: { redeemReset: async (home: string | null) => (redeemed.push(home), { outcome: "reset", message: "Limits reset.", left: 0 }) } },
    );
    service.setPreferences(preferences.schema.parse({ autoRedeem: true }));
    await limitTurn();
    expect(redeemed).toEqual([]);
  });
});

/** What a Claude agent's create request comes out of ZeroSub as, created in `modeId`; `metadata` null is a Paseo before 0.16, which has none. */
async function createdIn(service: Service, paseo: unknown, modeId: string | undefined, metadata: Record<string, unknown> | null = {}) {
  const request = { config: { provider: "claude", cwd: root, ...(modeId ? { modeId } : {}) }, ...(metadata ? { metadata } : {}) };
  return ((await service.onAgentCreate(request as never, { paseo } as never)) ?? request) as { metadata?: Record<string, unknown> };
}

describe("AWS Bedrock as the last resort", () => {
  const window = () => ({ kind: "window" as const, resetsAt: inFuture(), message: "You've hit your session limit" });
  const bedrock = { ...account("claude-bedrock", "bedrock", "managed"), auth: "api" as const, provider: "bedrock" as const, identity: "bedrock|eu-central-1|host" };
  const onlyMain = { accounts: [account(MAIN, "main", "main"), bedrock] as never, defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} };

  it("isn't used with paid API fallback off (the default): the agent stays at its limit", async () => {
    const { store, reopened, notes, limitTurn } = await setUp(onlyMain, window);
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).not.toBe(bedrock.id);
    expect(reopened).toEqual([]);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
  });

  it("with it on, takes a limited agent over in place, says it's a paid API, and doesn't pin it there", async () => {
    const { service, store, reopened, notes, limitTurn } = await setUp(onlyMain, window);
    service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
    await limitTurn();
    const state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(bedrock.id);
    expect(reopened).toEqual([AGENT]);
    // Not pinned: once a subscription account has room again, routing takes the agent back.
    expect(state.bindings[AGENT]?.accountId).not.toBe(bedrock.id);
    expect(notes.at(-1)).toMatchObject({ to: "bedrock", outcome: "switched" });
    expect(notes.at(-1)?.detail).toMatch(/AWS Bedrock, a paid API billed per token/);
  });

  it("with it on, moves the agent back off Bedrock once its subscription has room again", async () => {
    const { service, store, reopened, notes, limitTurn, paseo } = await setUp(onlyMain, window);
    service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(bedrock.id);
    await service.clearLimit(MAIN);
    // Past the minute after its turn that alignment leaves an agent alone for.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
    try {
      await service.alignSessions(paseo as never);
    } finally {
      vi.useRealTimers();
    }
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
    expect(reopened).toEqual([AGENT, AGENT]);
    expect(notes.at(-1)).toMatchObject({ reason: "room", to: "main" });
  });

  it("when the default changes with open agents kept, keeps one on Bedrock as the user's pick only if Bedrock was the default", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const keep = preferences.schema.parse({ paidApiFallback: true, moveAgentsOnDefaultChange: false });
    const at = new Date().toISOString();
    const sessions = { [AGENT]: { accountId: bedrock.id, family: "claude" as const, openedAt: at } };
    const accounts = [account(MAIN, "main", "main"), account(HELLO, "hello", "managed"), bedrock] as never;
    // Bedrock was the default: the user chose it, so the agent stays there.
    const chosen = await setUp({ accounts, defaults: { claude: bedrock.id, codex: null, pi: null }, sessions }, window);
    chosen.service.setPreferences(keep);
    await chosen.service.setDefault(chosen.paseo as never, MAIN);
    expect((await chosen.store.read()).bindings[AGENT]).toMatchObject({ accountId: bedrock.id, source: "user" });
    // Bedrock was only standing in: kept for now, and let go once a subscription can take the agent.
    const standing = await setUp({ accounts, defaults: { claude: MAIN, codex: null, pi: null }, sessions, bindings: {} }, window);
    standing.service.setPreferences(keep);
    await standing.service.setDefault(standing.paseo as never, HELLO);
    expect((await standing.store.read()).bindings[AGENT]).toMatchObject({ accountId: bedrock.id, source: "auto" });
  });

  it("keeps its agents there when it throttles while every subscription is out, rather than sending them back to a limited one", async () => {
    const OTHER = "agent-2";
    const at = new Date().toISOString();
    const { service, store, reopened, notes, paseo } = await setUp(
      {
        ...onlyMain,
        accounts: [{ ...account(MAIN, "main", "main"), limitedUntil: inFuture(), limitKind: "window", limitedAt: at }, bedrock] as never,
        sessions: { [AGENT]: { accountId: bedrock.id, family: "claude", openedAt: at }, [OTHER]: { accountId: bedrock.id, family: "claude", openedAt: at } },
      },
      window,
    );
    service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
    // A second agent, idle on Bedrock, that moving idle agents off a throttled account looks at.
    const agent = (await paseo.agents.ref().refresh()).agent!;
    const other = { ...agent, id: OTHER };
    paseo.agents.list = async () => ({ entries: [{ agent }, { agent: other }], pageInfo: { hasMore: false, nextCursor: null } });
    const { ref } = paseo.agents;
    paseo.agents.ref = ((id: string) => {
      const handle = ref();
      return { ...handle, refresh: async () => ({ agent: id === OTHER ? other : agent }) };
    }) as typeof ref;
    const idle = vi.spyOn(service as unknown as { moveIdleAgentsOff: () => Promise<void> }, "moveIdleAgentsOff");
    await service.onTurnEnded(
      { agent: { id: AGENT, provider: "claude" }, turnId: null, outcome: { kind: "failed", error: { message: "ThrottlingException: Rate exceeded" } }, timeline: [] } as never,
      { paseo } as never,
    );
    expect(idle).toHaveBeenCalledTimes(1);
    await idle.mock.results[0]!.value;
    const state = await store.read();
    expect(state.accounts.find((entry) => entry.id === bedrock.id)?.limitedUntil).not.toBeNull();
    expect(reopened).toEqual([]);
    expect(state.sessions[AGENT]?.accountId).toBe(bedrock.id);
    expect(state.sessions[OTHER]?.accountId).toBe(bedrock.id);
    // The throttled agent's timeline says every account is at its limit; the idle one gets nothing.
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ reason: "exhausted", outcome: "stayed", to: "bedrock" });
  });

  it("leaves an idle agent on a throttled Bedrock at the alignment check while its subscription is out too", async () => {
    const at = new Date().toISOString();
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const { service, store, reopened, notes, paseo } = await setUp(
      {
        ...onlyMain,
        accounts: [
          { ...account(MAIN, "main", "main"), limitedUntil: until, limitKind: "window", limitedAt: at },
          { ...bedrock, limitedUntil: until, limitKind: "window", limitedAt: at },
        ] as never,
        sessions: { [AGENT]: { accountId: bedrock.id, family: "claude", openedAt: at } },
      },
      window,
    );
    service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
    // 30 s later, past the minute after its turn that alignment leaves an agent alone for.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
    try {
      await service.alignSessions(paseo as never);
    } finally {
      vi.useRealTimers();
    }
    expect(reopened).toEqual([]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(bedrock.id);
    expect(notes).toEqual([]);
  });

  it("still moves an idle agent back off Bedrock while Bedrock is usable and the subscription has room", async () => {
    const at = new Date().toISOString();
    const { service, store, reopened, notes, paseo } = await setUp(
      { ...onlyMain, sessions: { [AGENT]: { accountId: bedrock.id, family: "claude", openedAt: at } } },
      window,
    );
    service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
    try {
      await service.alignSessions(paseo as never);
    } finally {
      vi.useRealTimers();
    }
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
    expect(reopened).toEqual([AGENT]);
    expect(notes.at(-1)).toMatchObject({ reason: "room", to: "main" });
  });

  describe("with banked resets used automatically too", () => {
    const redeeming = (outcome: "reset" | "none", calls: Array<string | null>) => ({
      claude: { redeemReset: async (home: string | null) => (calls.push(home), outcome === "reset" ? { outcome, message: "Limits reset.", left: 0 } : { outcome, message: "No banked resets.", left: 0 }) },
    });

    it("spends the free reset first, and doesn't move the agent onto Bedrock", async () => {
      const calls: Array<string | null> = [];
      const { service, store, reopened, notes, limitTurn } = await setUp(onlyMain, window, redeeming("reset", calls));
      service.setPreferences(preferences.schema.parse({ paidApiFallback: true, autoRedeem: true }));
      await limitTurn();
      expect(calls).toHaveLength(1);
      expect((await store.read()).sessions[AGENT]?.accountId).not.toBe(bedrock.id);
      expect(reopened).toEqual([]);
      expect(notes.at(-1)).toMatchObject({ outcome: "reset" });
    });

    it("moves onto Bedrock only once no reset could be spent", async () => {
      const calls: Array<string | null> = [];
      const { service, store, reopened, notes, limitTurn } = await setUp(onlyMain, window, redeeming("none", calls));
      service.setPreferences(preferences.schema.parse({ paidApiFallback: true, autoRedeem: true }));
      await limitTurn();
      expect(calls).toHaveLength(1);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(bedrock.id);
      expect(reopened).toEqual([AGENT]);
      expect(notes.at(-1)).toMatchObject({ to: "bedrock", outcome: "switched" });
    });

    /** `MAIN` at its 5-hour limit, whose latest reading shows a banked reset (`usableNow` says whether it can be spent now). */
    async function limitedWithReset(usableNow: boolean, prefs: Record<string, unknown>, accounts: unknown[] = [account(MAIN, "main", "main"), bedrock]) {
      const t = await setUp({ ...onlyMain, accounts: accounts as never }, window);
      t.service.setPreferences(preferences.schema.parse({ paidApiFallback: true, autoRedeem: true, ...prefs }));
      await t.store.update((draft) => {
        Object.assign(draft.accounts.find((entry) => entry.id === MAIN)!, { limitedUntil: inFuture(), limitKind: "window", limitedAt: new Date().toISOString() });
      });
      const reading: Usage = {
        fetchedAt: new Date().toISOString(), windows: [{ id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: null }],
        error: null, cached: false, credits: null, resets: { available: 1, usableNow, blockedReason: null, expiresAt: null, refills: [], label: null },
      };
      (t.service as unknown as { usage: Map<string, Usage> }).usage.set(MAIN, reading);
      // A new agent is created in Accept File Edits, as Paseo 0.16 does it: its create request goes
      // through ZeroSub first, and the session opens with the metadata it came out with.
      const open = async (agentId: string, reason: "create" | "resume" | "refresh") => {
        const created = reason === "create" ? await createdIn(t.service, t.paseo, "acceptEdits") : undefined;
        await t.service.onSessionOpen(
          { agentId, provider: "claude", reason, purpose: "interactive", env: {}, workspaceId: "w", cwd: root, metadata: created?.metadata ?? {} } as never,
          { paseo: t.paseo } as never,
        );
      };
      return { ...t, open };
    }

    it("opens a new agent on a limited subscription with a usable banked reset, not on Bedrock", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const t = await limitedWithReset(true, {});
      await t.open("fresh", "create");
      expect((await t.store.read()).sessions.fresh?.accountId).toBe(MAIN);
      // With "Spread new agents across accounts" on too.
      t.service.setPreferences(preferences.schema.parse({ paidApiFallback: true, autoRedeem: true, balanceNewAgents: true }));
      await t.open("spread", "create");
      expect((await t.store.read()).sessions.spread?.accountId).toBe(MAIN);
    });

    it("keeps an existing agent on its limited subscription when it resumes or is aligned, so its next turn spends the reset", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const t = await limitedWithReset(true, {});
      await t.store.update((draft) => {
        draft.bindings[AGENT] = { accountId: MAIN, source: "user", at: new Date().toISOString() };
      });
      for (const reason of ["resume", "refresh"] as const) {
        await t.open(AGENT, reason);
        expect((await t.store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
      }
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
      try {
        await t.service.alignSessions(t.paseo as never);
      } finally {
        vi.useRealTimers();
      }
      expect(t.reopened).toEqual([]);
      expect((await t.store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
    });

    it("still uses Bedrock when the reset can't be spent now, or automatic resets are off", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      for (const [usableNow, autoRedeem] of [[false, true], [true, false]] as const) {
        const t = await limitedWithReset(usableNow, { autoRedeem });
        await t.open("fresh", "create");
        expect((await t.store.read()).sessions.fresh?.accountId).toBe(bedrock.id);
        await t.store.update((draft) => {
          draft.bindings[AGENT] = { accountId: MAIN, source: "user", at: new Date().toISOString() };
        });
        await t.open(AGENT, "resume");
        expect((await t.store.read()).sessions[AGENT]?.accountId).toBe(bedrock.id);
      }
    });

    it("prefers a subscription with room over one with a banked reset", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const t = await limitedWithReset(true, {}, [account(MAIN, "main", "main"), account(HELLO, "hello", "managed"), bedrock]);
      await t.open("fresh", "create");
      expect((await t.store.read()).sessions.fresh?.accountId).toBe(HELLO);
    });

    it("still moves to another Claude subscription with room before spending a reset", async () => {
      const calls: Array<string | null> = [];
      const { service, store, limitTurn } = await setUp(
        { accounts: [account(MAIN, "main", "main"), account(HELLO, "hello", "managed"), bedrock] as never, defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
        window,
        redeeming("reset", calls),
      );
      service.setPreferences(preferences.schema.parse({ paidApiFallback: true, autoRedeem: true }));
      await limitTurn();
      expect(calls).toEqual([]);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
    });
  });

  describe("and Claude's Auto mode, which Bedrock can't run", () => {
    for (const [what, mode] of [["in Auto mode", "auto"], ["whose mode Paseo doesn't say (Auto is its default)", null]] as const) {
      it(`never moves an agent ${what} onto it by itself, and says why`, async () => {
        const { service, store, reopened, notes, limitTurn, agent } = await setUp(onlyMain, window);
        agent.currentModeId = mode;
        service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
        await limitTurn();
        expect((await store.read()).sessions[AGENT]?.accountId).not.toBe(bedrock.id);
        expect(reopened).toEqual([]);
        expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
        expect(notes.at(-1)?.detail).toMatch(/bedrock \(AWS Bedrock\) wasn't used: Bedrock can't run Claude's Auto mode/);
      });
    }

    it("doesn't open or keep an Auto-mode agent on it by itself, but does once the agent is in another mode", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { service, store, agent, paseo } = await setUp(onlyMain, window);
      service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
      await store.update((draft) => {
        Object.assign(draft.accounts.find((entry) => entry.id === MAIN)!, { limitedUntil: inFuture(), limitKind: "window", limitedAt: new Date().toISOString() });
      });
      const open = (agentId: string, reason: "create" | "resume") =>
        service.onSessionOpen({ agentId, provider: "claude", reason, purpose: "interactive", env: {}, workspaceId: "w", cwd: root } as never, { paseo } as never);
      agent.currentModeId = "auto";
      await open("fresh", "create");
      await open(AGENT, "resume");
      expect((await store.read()).sessions.fresh?.accountId).toBe(MAIN);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
      agent.currentModeId = "acceptEdits";
      await open(AGENT, "resume");
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(bedrock.id);
    });

    it("opens a new agent on it by the mode it was created in, which Paseo can't say before the agent exists", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { service, store, paseo } = await setUp(onlyMain, window);
      service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
      await store.update((draft) => {
        Object.assign(draft.accounts.find((entry) => entry.id === MAIN)!, { limitedUntil: inFuture(), limitKind: "window", limitedAt: new Date().toISOString() });
      });
      const open = (agentId: string, metadata: Record<string, unknown> | undefined) =>
        service.onSessionOpen(
          { agentId, provider: "claude", reason: "create", purpose: "interactive", env: {}, workspaceId: "w", cwd: root, ...(metadata ? { metadata } : {}) } as never,
          { paseo } as never,
        );
      const where = async (agentId: string) => (await store.read()).sessions[agentId]?.accountId;
      await open("edits", (await createdIn(service, paseo, "acceptEdits")).metadata);
      expect(await where("edits")).toBe(bedrock.id);
      // Auto mode, no mode named (Paseo's default is Auto), or a Paseo before 0.16 with no metadata to carry it in.
      await open("auto", (await createdIn(service, paseo, "auto")).metadata);
      await open("unnamed", (await createdIn(service, paseo, undefined)).metadata);
      await open("older", (await createdIn(service, paseo, "acceptEdits", null)).metadata);
      expect({ auto: await where("auto"), unnamed: await where("unnamed"), older: await where("older") }).toEqual({ auto: MAIN, unnamed: MAIN, older: MAIN });
    });

    it("notes a new agent's mode in its create request only for Claude, with paid fallback on and a Bedrock account", async () => {
      const { service, paseo } = await setUp(onlyMain, window);
      const request = (provider: string) => ({ config: { provider, cwd: root, modeId: "acceptEdits" }, metadata: { "zerosub.account": "x" } });
      expect(await service.onAgentCreate(request("claude") as never, { paseo } as never)).toBeUndefined();
      service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
      expect(await service.onAgentCreate(request("codex") as never, { paseo } as never)).toBeUndefined();
      expect(((await service.onAgentCreate(request("claude") as never, { paseo } as never)) as { metadata?: unknown } | undefined)?.metadata).toEqual({ "zerosub.account": "x", "zerosub.created-mode": "acceptEdits" });
      const noBedrock = await setUp({ ...onlyMain, accounts: [account(MAIN, "main", "main")] as never }, window);
      noBedrock.service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
      expect(await noBedrock.service.onAgentCreate(request("claude") as never, { paseo } as never)).toBeUndefined();
    });

    it("doesn't align an Auto-mode agent onto it, but does one in another mode", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      for (const mode of ["auto", "acceptEdits"]) {
        const { service, store, reopened, agent, paseo } = await setUp(onlyMain, window);
        service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
        agent.currentModeId = mode;
        await store.update((draft) => {
          Object.assign(draft.accounts.find((entry) => entry.id === MAIN)!, { limitedUntil: inFuture(), limitKind: "window", limitedAt: new Date().toISOString() });
          draft.sessions[AGENT] = { accountId: MAIN, family: "claude", openedAt: new Date().toISOString() };
        });
        vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
        try {
          await service.alignSessions(paseo as never);
        } finally {
          vi.useRealTimers();
        }
        expect(reopened).toEqual(mode === "auto" ? [] : [AGENT]);
        expect((await store.read()).sessions[AGENT]?.accountId).toBe(mode === "auto" ? MAIN : bedrock.id);
      }
    });

    it("still runs one put there by hand or as the default, and Paseo's refusal isn't taken for a limit or a refusal", async () => {
      const { service, store, notes, agent, paseo } = await setUp({ ...onlyMain, defaults: { claude: bedrock.id, codex: null, pi: null } } as never, window, {
        detectLimit: () => null,
      });
      agent.currentModeId = "auto";
      const open = () =>
        service.onSessionOpen({ agentId: AGENT, provider: "claude", reason: "resume", purpose: "interactive", env: {}, workspaceId: "w", cwd: root } as never, { paseo } as never);
      await open();
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(bedrock.id);
      await service.onTurnEnded(
        { agent: { id: AGENT, provider: "claude" }, turnId: null, outcome: { kind: "failed", error: { message: "Claude Auto mode requires the Anthropic API. Choose another mode to use Bedrock." } }, timeline: [] } as never,
        { paseo } as never,
      );
      const account = (await store.read()).accounts.find((entry) => entry.id === bedrock.id)!;
      expect(account).toMatchObject({ signedIn: true, limitedUntil: null });
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(bedrock.id);
      expect(notes.at(-1)).toMatchObject({ outcome: "stayed", to: "bedrock" });
      expect(notes.at(-1)?.detail).toMatch(/Auto mode can't run on bedrock.*Pick another mode/);
    });
  });

  it("isn't used while a subscription account has room, even with it on", async () => {
    const { service, store, notes, limitTurn } = await setUp(
      { accounts: [account(MAIN, "main", "main"), account(HELLO, "hello", "managed"), bedrock] as never, defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} },
      window,
    );
    service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
    expect(notes.at(-1)?.detail ?? null).toBeNull();
  });
});

describe("one model's limit", () => {
  const OPUS_AGENT = "agent-opus";
  const FABLE_AGENT = "agent-fable";
  const MODEL = { fable: "claude-fable-5-2", opus: "claude-opus-4-1" };
  const fableHit = (): LimitHit => ({ kind: "window", resetsAt: inFuture(), message: "You've hit your Fable limit", scope: "fable" });
  const state = (sessions: StoredState["sessions"] = {}) => ({
    accounts: [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: MAIN, codex: null, pi: null },
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt: "2026-09-23T07:00:00.000Z" }, ...sessions },
  });
  const accountOf = async (store: StateStore, id: string) => (await store.read()).accounts.find((entry) => entry.id === id)!;

  it("records the limit on the model, leaves the account free, and moves only that agent", async () => {
    const { store, agent, reopened, notes, limitTurn } = await setUp(state(), fableHit);
    (agent as { model?: string }).model = MODEL.fable;
    await limitTurn();
    const main = await accountOf(store, MAIN);
    expect(main.limitedUntil).toBeNull();
    expect(main.modelLimits.fable).toMatchObject({ source: "turn" });
    expect(Date.parse(main.modelLimits.fable!.until)).toBeGreaterThan(Date.now());
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
    expect(notes.at(-1)).toMatchObject({ from: "marketing", to: "hello", outcome: "switched" });
  });

  it("takes an agent whose model Paseo doesn't say to run the model that hit the limit", async () => {
    const { store, reopened, limitTurn } = await setUp(state(), fableHit);
    await limitTurn();
    expect((await accountOf(store, MAIN)).limitedUntil).toBeNull();
    expect(reopened).toEqual([AGENT]);
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
  });

  it("shares the limit with the other slots signed into the subscription", async () => {
    const { store, limitTurn } = await setUp(
      { ...state(), accounts: [signedInAs(MAIN), { ...signedInAs(TWIN), identity: signedInAs(MAIN).identity }] as never },
      fableHit,
    );
    await limitTurn();
    expect((await accountOf(store, TWIN)).modelLimits.fable).toBeDefined();
    expect((await accountOf(store, TWIN)).limitedUntil).toBeNull();
  });

  it("moves an idle agent of that model off the account, but not one on another model", async () => {
    const idle = (id: string, model: string) => ({
      id, provider: "claude", status: "idle", archivedAt: null, lastUserMessageAt: "2026-09-23T07:00:00.000Z", model,
    });
    const extra = [idle(OPUS_AGENT, MODEL.opus), idle(FABLE_AGENT, MODEL.fable)];
    const { store, paseo, agent, reopened, limitTurn } = await setUp(state(), fableHit);
    (agent as { model?: string }).model = MODEL.fable;
    const api = paseo.agents as unknown as {
      list: () => Promise<unknown>;
      ref: (id: string) => Record<string, unknown>;
    };
    const ref = api.ref;
    api.list = async () => ({ entries: [agent, ...extra].map((entry) => ({ agent: entry })), pageInfo: { hasMore: false, nextCursor: null } });
    api.ref = (id: string) => ({ ...ref(id), refresh: async () => ({ agent: extra.find((entry) => entry.id === id) ?? agent }) });
    await limitTurn();
    await vi.waitFor(() => expect(reopened).toContain(FABLE_AGENT));
    expect(reopened).not.toContain(OPUS_AGENT);
    const state2 = await store.read();
    expect(state2.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(state2.bindings[OPUS_AGENT]).toBeUndefined();
  });

  describe("picking an account by hand", () => {
    const limited = () => ({
      ...state(),
      accounts: [account(MAIN, "marketing", "main"), { ...account(HELLO, "hello", "managed"), modelLimits: { fable: { until: inFuture(), at: inPast(), source: "turn" } } }] as never,
    });

    it("lets an agent on another model pick it, and refuses one on the limited model", async () => {
      const { service, store, agent, paseo } = await setUp(limited(), fableHit);
      (agent as { model?: string }).model = MODEL.opus;
      expect((await service.setAgentAccount(paseo as never, AGENT, HELLO)).reopened).toEqual([AGENT]);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(HELLO);
    });

    it("tells the user it is the model's limit", async () => {
      const { service, store, agent, paseo, reopened } = await setUp(limited(), fableHit);
      (agent as { model?: string }).model = MODEL.fable;
      await expect(service.setAgentAccount(paseo as never, AGENT, HELLO)).rejects.toThrow(/hello has reached its Fable limit.*another model/);
      expect(reopened).toEqual([]);
      expect((await store.read()).bindings[AGENT]).toBeUndefined();
    });
  });
});

describe("a Claude API key as the last resort", () => {
  const window = () => ({ kind: "window" as const, resetsAt: inFuture(), message: "You've hit your session limit" });
  const keyed = { ...account("claude-key", "key", "managed"), auth: "api" as const, identity: "api|anthropic|0123456789abcdef" };
  const onlyMain = { accounts: [account(MAIN, "main", "main"), keyed] as never, defaults: { claude: MAIN, codex: null, pi: null }, sessions: {} };

  it("isn't used with paid API fallback off (the default): the agent stays at its limit", async () => {
    const { store, reopened, notes, limitTurn } = await setUp(onlyMain, window);
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).not.toBe(keyed.id);
    expect(reopened).toEqual([]);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
  });

  it("with it on, takes a limited agent over in place, says it's billed per use, doesn't pin it there, and leaves once the subscription has room", async () => {
    const { service, store, reopened, notes, limitTurn, paseo } = await setUp(onlyMain, window);
    service.setPreferences(preferences.schema.parse({ paidApiFallback: true }));
    await limitTurn();
    const state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(keyed.id);
    expect(reopened).toEqual([AGENT]);
    expect(state.bindings[AGENT]?.accountId).not.toBe(keyed.id);
    expect(notes.at(-1)).toMatchObject({ to: "key", outcome: "switched" });
    expect(notes.at(-1)?.detail).toMatch(/: an API key, billed per use\. It moves back to a Claude account once one has room\./);

    await service.clearLimit(MAIN);
    // Past the minute after its turn that alignment leaves an agent alone for.
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
    try {
      await service.alignSessions(paseo as never);
    } finally {
      vi.useRealTimers();
    }
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
  });

  it("with it on, still isn't used when the key goes to another endpoint", async () => {
    const gateway = { ...keyed, identity: "api|https://gw.example.com|0123456789abcdef" };
    const { service, store, reopened, notes, limitTurn } = await setUp({ ...onlyMain, accounts: [account(MAIN, "main", "main"), gateway] as never }, window);
    service.setPreferences(preferences.schema.parse({ autoSwitch: true, paidApiFallback: true }));
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).not.toBe(gateway.id);
    expect(reopened).toEqual([]);
    expect(notes.at(-1)).toMatchObject({ outcome: "stayed" });
  });

  it("doesn't say it's there for want of a subscription when the key is where the agent routes anyway", async () => {
    // The key is the default; the agent ran on the CLI login (picked once, say) until that hit its limit.
    const { service, store, notes, limitTurn } = await setUp(
      { ...onlyMain, defaults: { claude: keyed.id, codex: null, pi: null }, sessions: { [AGENT]: { accountId: MAIN, family: "claude", openedAt: "2026-09-23T07:00:00.000Z" } } },
      window,
    );
    service.setPreferences(preferences.schema.parse({ autoSwitch: true, paidApiFallback: true }));
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(keyed.id);
    expect(notes.at(-1)).toMatchObject({ to: "key", outcome: "switched" });
    expect(notes.at(-1)?.detail ?? null).toBeNull();
  });

  it("still moves an agent paid fallback put on the key back once the subscription has room, after the setting is turned off", async () => {
    const { service, store, limitTurn, paseo } = await setUp(onlyMain, window);
    service.setPreferences(preferences.schema.parse({ autoSwitch: true, paidApiFallback: true }));
    await limitTurn();
    expect((await store.read()).sessions[AGENT]).toMatchObject({ accountId: keyed.id, standIn: true });

    // Off while the subscription is still out: nothing better to go to, so it stays where it can work.
    service.setPreferences(preferences.schema.parse({ autoSwitch: true }));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
    try {
      await service.alignSessions(paseo as never);
      expect((await store.read()).sessions[AGENT]?.accountId).toBe(keyed.id);

      // Then the subscription has room again: alignment takes the agent off the bill, as with Bedrock.
      await service.clearLimit(MAIN);
      vi.setSystemTime(Date.now() + 2 * 60_000);
      await service.alignSessions(paseo as never);
    } finally {
      vi.useRealTimers();
    }
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(MAIN);
  });

  it("still moves an agent kept on the key when the default changed back once the new default has room, after the setting is turned off", async () => {
    // Two subscriptions, both out: the limit puts the agent on the key, and the default then moves to
    // the other subscription with "move agents on default change" off, which keeps it on the key.
    const work = { ...account("claude-work", "work", "managed"), limitedUntil: inFuture(), limitKind: "window" as const, limitedAt: new Date().toISOString() };
    const { service, store, limitTurn, paseo } = await setUp({ ...onlyMain, accounts: [account(MAIN, "main", "main"), work, keyed] as never }, window);
    const keep = { autoSwitch: true, moveAgentsOnDefaultChange: false };
    service.setPreferences(preferences.schema.parse({ ...keep, paidApiFallback: true }));
    await limitTurn();
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(keyed.id);
    await service.setDefault(paseo as never, work.id);
    expect((await store.read()).bindings[AGENT]).toMatchObject({ accountId: keyed.id, source: "auto", standIn: true });

    service.setPreferences(preferences.schema.parse(keep));
    await service.clearLimit(work.id);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
    try {
      await service.alignSessions(paseo as never);
    } finally {
      vi.useRealTimers();
    }
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(work.id);
  });

  it("still moves an agent kept on the key when the default changed after the setting was turned off, once the new default has room", async () => {
    // As above, with the setting turned off before the default moves: the binding that keeps the agent
    // on the key is still ZeroSub's, because paid fallback opened its session there.
    const work = { ...account("claude-work", "work", "managed"), limitedUntil: inFuture(), limitKind: "window" as const, limitedAt: new Date().toISOString() };
    const { service, store, limitTurn, paseo } = await setUp({ ...onlyMain, accounts: [account(MAIN, "main", "main"), work, keyed] as never }, window);
    const keep = { autoSwitch: true, moveAgentsOnDefaultChange: false };
    service.setPreferences(preferences.schema.parse({ ...keep, paidApiFallback: true }));
    await limitTurn();
    expect((await store.read()).sessions[AGENT]).toMatchObject({ accountId: keyed.id, standIn: true });

    service.setPreferences(preferences.schema.parse(keep));
    await service.setDefault(paseo as never, work.id);
    expect((await store.read()).bindings[AGENT]).toMatchObject({ accountId: keyed.id, source: "auto", standIn: true });
    await service.clearLimit(work.id);
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
    try {
      await service.alignSessions(paseo as never);
    } finally {
      vi.useRealTimers();
    }
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(work.id);
  });

  it("says why when an agent ZeroSub bound to the key goes back onto it, with the setting off", async () => {
    // Bound there by an earlier fallback (`standIn`), and every subscription is out again.
    const { service, store, notes, limitTurn } = await setUp(
      { ...onlyMain, bindings: { [AGENT]: { accountId: keyed.id, source: "auto", at: "2026-09-23T07:00:00.000Z", standIn: true } } } as never,
      window,
    );
    service.setPreferences(preferences.schema.parse({ autoSwitch: true }));
    await limitTurn();
    expect((await store.read()).sessions[AGENT]).toMatchObject({ accountId: keyed.id, standIn: true });
    expect(notes.at(-1)?.detail).toMatch(/: an API key, billed per use\. It moves back to a Claude account once one has room\./);
  });

  it("with it on, moves an agent off Bedrock onto the key the user picked for it, as on main", async () => {
    // The key is the agent's own route, so it's where the agent belongs, not more of the bill.
    const bedrock = { ...account("claude-bedrock", "bedrock", "managed"), auth: "api" as const, provider: "bedrock" as const, identity: "bedrock|eu-central-1|host" };
    const { service, store, paseo } = await setUp(
      {
        ...onlyMain,
        accounts: [account(MAIN, "main", "main"), keyed, bedrock] as never,
        bindings: { [AGENT]: { accountId: keyed.id, source: "user", at: "2026-09-23T07:00:00.000Z" } },
        sessions: { [AGENT]: { accountId: bedrock.id, family: "claude", openedAt: "2026-09-23T07:00:00.000Z" } },
      } as never,
      window,
    );
    service.setPreferences(preferences.schema.parse({ autoSwitch: true, paidApiFallback: true }));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
    try {
      await service.alignSessions(paseo as never);
    } finally {
      vi.useRealTimers();
    }
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(keyed.id);
  });

  it("leaves an agent the user put on the key there when the setting is turned off, as on main", async () => {
    const { service, store, paseo } = await setUp(
      { ...onlyMain, bindings: { [AGENT]: { accountId: keyed.id, source: "user", at: "2026-09-23T07:00:00.000Z" } }, sessions: { [AGENT]: { accountId: keyed.id, family: "claude", openedAt: "2026-09-23T07:00:00.000Z" } } } as never,
      window,
    );
    service.setPreferences(preferences.schema.parse({ autoSwitch: true }));
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 2 * 60_000 });
    try {
      await service.alignSessions(paseo as never);
    } finally {
      vi.useRealTimers();
    }
    expect((await store.read()).sessions[AGENT]?.accountId).toBe(keyed.id);
  });
});

// Every process on an account's home shares its token. One `claude auth status` taken while another
// process renews that token can read as signed out, and the account then stayed signed out until the
// next identity check, 30 minutes later: no agent was routed to it, and its agents moved off.
describe("a sign-out read while the token is being renewed", () => {
  const refused = () => "Failed to authenticate: OAuth session expired and could not be refreshed";
  const signedIn: Identity = { signedIn: true, email: "hello@example.com", plan: "max", organization: null, identity: "personal|hello@example.com" };
  const signedOut: Identity = { signedIn: false, email: null, plan: null, organization: null, identity: null };
  const onHello = () => ({
    accounts: [account(MAIN, "main", "main"), account(HELLO, "hello", "managed")] as never,
    defaults: { claude: HELLO, codex: null, pi: null },
    sessions: { [AGENT]: { accountId: HELLO, family: "claude" as const, openedAt: new Date().toISOString() } },
  });

  it("keeps the account signed in when the second reading says so", async () => {
    const readings = [signedOut, signedIn];
    const { service, store, reopened, limitTurn } = await setUp(onHello(), () => null as never, {
      identity: () => readings.shift() ?? signedIn,
      detectSignOut: refused,
    });
    service.signOutRecheckMs = 0;
    await limitTurn();
    const state = await store.read();
    expect(readings).toEqual([]);
    expect(state.accounts.find((a) => a.id === HELLO)?.signedIn).toBe(true);
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(reopened).toEqual([]);
  });

  it("signs it out and moves the agent when both readings say so", async () => {
    const { service, store, reopened, limitTurn } = await setUp(onHello(), () => null as never, {
      identity: () => signedOut,
      detectSignOut: refused,
    });
    service.signOutRecheckMs = 0;
    await limitTurn();
    const state = await store.read();
    expect(state.accounts.find((a) => a.id === HELLO)?.signedIn).toBe(false);
    expect(state.sessions[AGENT]?.accountId).toBe(MAIN);
    expect(reopened).toEqual([AGENT]);
  });
});

// A plugin that stops a session at its own threshold (95% of the week, say) sees the limit coming
// before ZeroSub does: to ZeroSub the account isn't out yet, so nothing moves the session and it stays
// stopped while another account has room. `moveBeforeLimit` lets that plugin move this one agent,
// between turns, with ZeroSub's own guards.
describe("a move asked for before the limit", () => {
  const nearly = (extra: Partial<StoredState> = {}) => ({
    accounts: [account(MAIN, "main", "main"), account(HELLO, "seat", "managed")] as never,
    defaults: { claude: MAIN, codex: null, pi: null },
    sessions: { [AGENT]: { accountId: MAIN, family: "claude" as const, openedAt: new Date().toISOString() } },
    ...extra,
  });
  const unused = () => ({ kind: "window" as const, resetsAt: inFuture(), message: "" });

  it("moves an idle agent to the named account without pinning it there", async () => {
    const { service, store, reopened, notes, paseo } = await setUp(nearly(), unused);
    expect(await service.moveBeforeLimit(paseo as never, AGENT, HELLO)).toEqual({ outcome: "moved", detail: null });
    expect(reopened).toEqual([AGENT]);
    const state = await store.read();
    expect(state.sessions[AGENT]?.accountId).toBe(HELLO);
    expect(state.bindings[AGENT]).toMatchObject({ accountId: HELLO, source: "auto" });
    expect(notes.at(-1)).toMatchObject({ from: "main", to: "seat", reason: "near_limit", outcome: "switched" });
  });

  it("says so when it's already there, and does nothing", async () => {
    const { service, reopened, paseo } = await setUp(nearly(), unused);
    expect((await service.moveBeforeLimit(paseo as never, AGENT, MAIN)).outcome).toBe("already");
    expect(reopened).toEqual([]);
  });

  it("waits for background work and a running turn", async () => {
    const jobs = await setUp(nearly(), unused);
    (jobs.agent as Record<string, unknown>).backgroundWork = { count: 2 };
    expect((await jobs.service.moveBeforeLimit(jobs.paseo as never, AGENT, HELLO)).outcome).toBe("waiting");
    expect(jobs.reopened).toEqual([]);
    const busy = await setUp(nearly(), unused);
    busy.agent.status = "running";
    expect((await busy.service.moveBeforeLimit(busy.paseo as never, AGENT, HELLO)).outcome).toBe("waiting");
    expect(busy.reopened).toEqual([]);
  });

  it("refuses an account that can't take it, a closed agent, one the user pinned, and automatic switching off", async () => {
    const limited = await setUp(nearly({ accounts: [account(MAIN, "main", "main"), { ...account(HELLO, "seat", "managed"), limitedUntil: inFuture() }] as never }), unused);
    expect((await limited.service.moveBeforeLimit(limited.paseo as never, AGENT, HELLO)).outcome).toBe("refused");
    const closed = await setUp(nearly(), unused);
    closed.agent.status = "closed";
    expect((await closed.service.moveBeforeLimit(closed.paseo as never, AGENT, HELLO)).outcome).toBe("refused");
    const pinned = await setUp(nearly({ bindings: { [AGENT]: { accountId: MAIN, source: "user", at: new Date().toISOString() } } }), unused);
    expect(await pinned.service.moveBeforeLimit(pinned.paseo as never, AGENT, HELLO)).toEqual({ outcome: "refused", detail: "It stays on the account picked for it." });
    const off = await setUp(nearly(), unused);
    off.service.setPreferences(preferences.schema.parse({ autoSwitch: false }));
    expect((await off.service.moveBeforeLimit(off.paseo as never, AGENT, HELLO)).outcome).toBe("refused");
    for (const run of [limited, closed, pinned, off]) expect(run.reopened).toEqual([]);
    expect((await pinned.store.read()).bindings[AGENT]).toMatchObject({ accountId: MAIN, source: "user" });
  });

  it("keeps the switch guard", async () => {
    const { service, store, paseo } = await setUp(nearly(), unused);
    const back = async () => store.update((draft) => {
      draft.sessions[AGENT] = { accountId: MAIN, family: "claude", openedAt: new Date().toISOString() };
    });
    for (let move = 0; move < 4; move += 1) {
      expect((await service.moveBeforeLimit(paseo as never, AGENT, HELLO)).outcome).toBe("moved");
      await back();
    }
    expect((await service.moveBeforeLimit(paseo as never, AGENT, HELLO)).outcome).toBe("refused");
  });
});
