import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem, FamilyAdapter, Identity, LimitHit, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import { detectClaudeLimit } from "./limits";
import type { Reopener } from "./reopen";
import type { SwitchGuard } from "./switch-guard";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredAccount, type StoredState } from "./state";
import { saveReadings } from "./usage";
import { preferences } from "../shared/preferences";
import { absentPi } from "./fakes.test-support";

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";
const AGENT = "agent-1";

let root: string;
let previousHome: string | undefined;
/** The services the current test made, stopped once it ends. */
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-failover-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root; // saved usage lands here, never in the real ~/.paseo
});

afterEach(async () => {
  // A reading is saved 3 s after it lands. Stopping saves it now, while PASEO_HOME is still this
  // test's folder, rather than in whatever folder a later test has set by then.
  await Promise.all(services.splice(0).map((service) => service.stop()));
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
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
  const agent: { id: string; provider: string; status: string; archivedAt: null; lastUserMessageAt: string } = {
    id: AGENT,
    provider: "claude",
    status: "idle",
    archivedAt: null,
    lastUserMessageAt: "2026-09-23T07:00:00.000Z",
  };
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
      { id: "bypassPermissions", label: "Bypass", colorTier: "dangerous" },
    ],
    codex: [
      { id: "auto", label: "Default Permissions", colorTier: "moderate" },
      { id: "full-access", label: "Full Access", colorTier: "dangerous" },
    ],
  };

  /** `conversation` is the agent's timeline, which Paseo pages from its tail. `others` are the host's other agents. */
  async function setUpFork(modeId: string, conversation: readonly Row[] = [], labels: Record<string, string> = {}, others: Array<Record<string, unknown>> = []) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) =>
      Object.assign(draft, {
        accounts: [account(MAIN, "marketing", "main"), { ...account(CODEX_MAIN, "hello", "main"), family: "codex" }],
        defaults: { claude: MAIN, codex: CODEX_MAIN, pi: null },
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
      labels,
    };
    const agents: Array<Record<string, unknown>> = [source, ...others];
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
        ref: (id: string) => ({
          refresh: async () => ({ agent: others.find((agent) => agent.id === id) ?? source }),
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
        pi: absentPi(),
      },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo", reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    );
    services.push(service);
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
    listed: Array<{ id: string; status: string; provider?: string; archived?: boolean; backgroundWork?: number }>,
    options: { claude?: Partial<FamilyAdapter>; onList?: (service: Service, context: never) => void } = {},
  ) {
    const store = new StateStore(join(root, "state.json"));
    await store.update((draft) => Object.assign(draft, state));
    const agents = listed.map(({ id, status, provider, archived, backgroundWork }) => ({
      id,
      provider: provider ?? "claude",
      status,
      archivedAt: archived ? "2026-09-23T08:00:00.000Z" : null,
      lastUserMessageAt: openedAt,
      backgroundWork: { count: backgroundWork ?? 0 },
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
      { claude: { ...claudeAdapter(hit), ...options.claude }, codex: { ...claudeAdapter(hit), family: "codex", portable: false } as FamilyAdapter, pi: absentPi() },
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
    return { service, store, paseo: paseo as never, context, reopened, agents };
  }

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
    const { agent } = await paseo.agents.ref().refresh();
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
