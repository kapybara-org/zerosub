import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";
import { absentPi } from "./fakes.test-support";

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-egress-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  // Retried: a write the test set off in the background can still be landing in it.
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function account(id: string, label: string, kind: "main" | "managed") {
  return { id, family: "claude" as const, label, kind, home: kind === "main" ? null : join(tmpdir(), id), createdAt: "2026-09-23T00:00:00.000Z" };
}

type Seen = { ip: string; country: string | null } | null;

/** A service whose Claude accounts' requests Anthropic sees come from what `egress` answers. */
async function setUp(state: Partial<StoredState>, options: { egress: (home: string | null) => Promise<Seen> }) {
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
      usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
      redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
      login: async () => {
        throw new Error("not in tests");
      },
      logout: async () => undefined,
      detectLimit: () => null,
      detectSignOut: () => null,
      ...(family === "claude" ? { egress: options.egress, setProxy: async () => undefined } : {}),
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
