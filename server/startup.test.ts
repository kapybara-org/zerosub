import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-startup-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function adapter(family: "claude" | "codex"): FamilyAdapter {
  return {
    family,
    portable: family === "claude",
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async () => ({}),
    identity: async () => ({ signedIn: true, email: null, plan: null, organization: null, identity: null }),
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: () => null,
    detectSignOut: () => null,
  };
}

/** Every upkeep pass the service starts, so the test can wait for them before it stops the service. */
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
    const store = new StateStore(join(root, "state.json"));
    const service = new Service(
      { claude: adapter("claude"), codex: adapter("codex") },
      store,
      { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
      { locate: async () => null } as unknown as Reopener,
    );
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
      expect(ids).toEqual(expect.arrayContaining([MAIN_ACCOUNT_ID.claude, MAIN_ACCOUNT_ID.codex]));
    } finally {
      await service.stop();
      await Promise.all(ticks);
    }
  });
});
