import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageWindow } from "../shared/model";
import type { FamilyAdapter, LimitHit } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";
import { absentPi } from "./fakes.test-support";

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";
const AGENT = "agent-1";

let root: string;
let previousHome: string | undefined;
let previousLaunchers: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-upkeep-"));
  previousHome = process.env.PASEO_HOME;
  previousLaunchers = process.env.ZEROSUB_LAUNCHER_DIR;
  process.env.ZEROSUB_LAUNCHER_DIR = join(root, "launchers");
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  vi.useRealTimers();
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

const inHours = (hours: number) => new Date(Date.now() + hours * 60 * 60_000).toISOString();

type Seen = { ip: string; country: string | null } | null;

/**
 * A service whose Claude accounts read `windows` as their usage, whose failed turns hit `hit`, and
 * whose requests Anthropic sees come from what `egress` answers.
 */
async function setUp(
  state: Partial<StoredState>,
  options: { windows?: () => UsageWindow[]; hit?: () => LimitHit; egress?: (home: string | null) => Promise<Seen> } = {},
) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => Object.assign(draft, state));
  const adapter = (family: "claude" | "codex"): FamilyAdapter =>
    ({
      family,
      portable: family === "claude",
      usageSpacingMs: 0,
      available: async () => ({ ok: true, detail: null }),
      prepareHome: async () => undefined,
      env: async () => ({}),
      identity: async () => null,
      usage: async () => ({ fetchedAt: new Date().toISOString(), windows: options.windows?.() ?? [], error: null, cached: false, resets: null }),
      redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
      login: async () => {
        throw new Error("not in tests");
      },
      logout: async () => undefined,
      detectLimit: (event: { outcome: { kind: string } }) => (event.outcome.kind === "failed" ? (options.hit?.() ?? null) : null),
      detectSignOut: () => null,
      ...(family === "claude" && options.egress ? { egress: options.egress, proxy: async () => null, setProxy: async () => undefined } : {}),
    }) as unknown as FamilyAdapter;
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({
        refresh: async () => null,
        send: async () => undefined,
        timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  const service = new Service(
    { claude: adapter("claude"), codex: adapter("codex"), pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  return { service, store, context: { paseo } as never };
}

/**
 * Every upkeep pass the service starts, so a test can wait for them all to finish before it stops the
 * service: one still running after the test would write the launchers where the environment points then.
 */
function trackTicks(service: Service): Array<Promise<void>> {
  const ticks: Array<Promise<void>> = [];
  const target = service as unknown as { tick(): Promise<void> };
  const tick = target.tick.bind(service);
  target.tick = () => {
    const run = tick();
    ticks.push(run.catch(() => undefined));
    return run;
  };
  return ticks;
}

describe("starting up", () => {
  it("keeps up its upkeep when a step fails, and finishes that step later", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const { service, store } = await setUp({ accounts: [] });
    const ticks = trackTicks(service);
    // The registry can't be written for a moment (a full disk, say) just as ZeroSub starts.
    const update = store.update.bind(store);
    let failures = 1;
    store.update = (change) => (failures-- > 0 ? Promise.reject(new Error("ENOSPC: no space left on device")) : update(change));
    try {
      await expect(service.start()).rejects.toThrow(/ENOSPC/);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(ticks).toHaveLength(1);
      await Promise.all(ticks);
      const ids = (await store.read()).accounts.map((entry) => entry.id);
      expect(ids).toEqual(expect.arrayContaining([MAIN, MAIN_ACCOUNT_ID.codex]));
    } finally {
      await service.stop();
      await Promise.all(ticks);
    }
  });
});

describe("usage readings", () => {
  const accounts = () => [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never;
  const window = (id: string, label: string, usedPercent: number, resetsAt: string): UsageWindow => ({ id, label, usedPercent, resetsAt });
  const limitedUntil = async (store: StateStore) => (await store.read()).accounts.find((entry) => entry.id === HELLO)?.limitedUntil ?? null;

  it("don't take an account out when only one model's weekly window is full", async () => {
    const { service, store } = await setUp(
      { accounts: accounts() },
      {
        windows: () => [
          window("five_hour", "5-hour", 40, inHours(2)),
          window("seven_day", "Weekly", 70, inHours(100)),
          window("seven_day_opus", "Weekly · Opus", 100, inHours(100)),
          window("weekly_fable", "Weekly · Fable", 100, inHours(100)),
        ],
      },
    );
    await service.refreshUsage(HELLO, true);
    expect(await limitedUntil(store)).toBeNull();
  });

  it("take an account out when one of its own windows is full", async () => {
    const resetsAt = inHours(2);
    const { service, store } = await setUp(
      { accounts: accounts() },
      { windows: () => [window("five_hour", "5-hour", 100, resetsAt), window("seven_day", "Weekly", 70, inHours(100))] },
    );
    await service.refreshUsage(HELLO, true);
    expect(await limitedUntil(store)).toBe(resetsAt);
  });

  it("time a limit a turn hit by the account's own window, not by a full model window that resets later", async () => {
    const resetsAt = inHours(2);
    const { service, store, context } = await setUp(
      {
        accounts: accounts(),
        defaults: { claude: HELLO, codex: null, pi: null },
        sessions: { [AGENT]: { accountId: HELLO, family: "claude", openedAt: "2026-09-23T07:00:00.000Z" } },
      },
      {
        windows: () => [window("five_hour", "5-hour", 100, resetsAt), window("seven_day_opus", "Weekly · Opus", 100, inHours(100))],
        hit: () => ({ kind: "window", resetsAt: null, message: "You've hit your session limit" }),
      },
    );
    await service.onTurnEnded(
      { agent: { id: AGENT, provider: "claude" }, turnId: "t", outcome: { kind: "failed", error: { message: "limit" } }, timeline: [] } as never,
      context,
    );
    expect(await limitedUntil(store)).toBe(resetsAt);
  });
});

describe("the address Anthropic sees an account's requests come from", () => {
  const accounts = () => [account(MAIN, "marketing", "main"), account(HELLO, "hello", "managed")] as never;

  it("is checked at once and then every half hour for each signed-in Claude account, and a failed check keeps the last address", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-28T12:00:00Z"));
    let answer: () => Promise<Seen> = async () => ({ ip: "203.0.113.7", country: "US" });
    const egress = vi.fn((_home: string | null) => answer());
    const { service, context } = await setUp({ accounts: accounts() }, { egress });
    const tick = () => (service as unknown as { tick(): Promise<void> }).tick();
    const seen = async () => (await service.view((context as { paseo: never }).paseo)).accounts.find((entry) => entry.id === HELLO)?.egress;
    try {
      await tick();
      await vi.waitFor(async () => expect(await seen()).toEqual({ ip: "203.0.113.7", country: "US", checkedAt: "2026-10-28T12:00:00.000Z", error: null }));
      expect(egress).toHaveBeenCalledTimes(2);

      vi.setSystemTime(new Date("2026-10-28T12:29:00Z"));
      await tick();
      expect(egress).toHaveBeenCalledTimes(2);

      answer = async () => {
        throw new Error("Proxy connection failed: connect ECONNREFUSED 127.0.0.1:7897");
      };
      vi.setSystemTime(new Date("2026-10-28T12:30:00Z"));
      await tick();
      await vi.waitFor(async () =>
        expect(await seen()).toEqual({ ip: "203.0.113.7", country: "US", checkedAt: "2026-10-28T12:00:00.000Z", error: "Proxy connection failed: connect ECONNREFUSED 127.0.0.1:7897" }),
      );
    } finally {
      await service.stop();
    }
  });

  it("is checked again as soon as the account's proxy changes, and isn't shown once its requests go elsewhere first", async () => {
    let answer: Seen = { ip: "203.0.113.7", country: "US" };
    const egress = vi.fn(async (_home: string | null) => answer);
    const { service, context } = await setUp({ accounts: accounts() }, { egress });
    const seen = async () => (await service.view((context as { paseo: never }).paseo)).accounts.find((entry) => entry.id === HELLO)?.egress ?? null;
    try {
      await (service as unknown as { tick(): Promise<void> }).tick();
      await vi.waitFor(async () => expect((await seen())?.ip).toBe("203.0.113.7"));
      answer = null;
      await service.setProxy(HELLO, "http://127.0.0.1:2020");
      await vi.waitFor(async () => expect(await seen()).toBeNull());
      expect(egress).toHaveBeenCalledTimes(3);
    } finally {
      await service.stop();
    }
  });
});
