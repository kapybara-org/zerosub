import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

const MANAGED = "claude-managed";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-usage-source-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root; // saved usage lands here, never in the real ~/.paseo
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-09-23T08:00:00Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

const live = (usedPercent: number): UsageRead => ({
  fetchedAt: new Date().toISOString(),
  windows: [{ id: "five_hour", label: "5-hour", usedPercent, resetsAt: "2026-09-23T10:00:00.000Z" }],
  error: null,
  cached: false,
  resets: null,
});

async function setUp(reads: Array<() => UsageRead> | (() => UsageRead)) {
  const store = new StateStore(join(root, "state.json"));
  const account = (id: string, kind: "main" | "managed") => ({
    id,
    family: "claude" as const,
    label: id,
    kind,
    home: kind === "main" ? null : join(root, id),
    email: `${id}@example.com`,
    plan: "pro",
    signedIn: true,
    createdAt: "2026-09-23T00:00:00.000Z",
  });
  await store.update((draft) =>
    Object.assign(draft, {
      accounts: [account(MAIN_ACCOUNT_ID.claude, "main"), account(MANAGED, "managed")],
      defaults: { claude: MAIN_ACCOUNT_ID.claude, codex: null },
    }),
  );
  const next = typeof reads === "function" ? reads : () => (reads.shift() ?? (() => live(0)))();
  const adapter = {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    usage: async () => next(),
  } as unknown as FamilyAdapter;
  const service = new Service({ claude: adapter, codex: adapter }, store, {} as FamilyResolver, {} as Reopener);
  return { service, store };
}

describe("usage readings that can't be refreshed", () => {
  it("say since when and why once they are old, and recover on the next live read", async () => {
    const rateLimited = (): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null, retryAt: Date.now() + 120_000 });
    const { service } = await setUp([() => live(30), rateLimited, rateLimited, () => live(45)]);
    await service.refreshUsage(MANAGED, true);
    expect(await service.usageSourceReport(MANAGED)).toMatchObject({ status: "available", windows: [{ usedPct: 30 }] });

    vi.setSystemTime(Date.now() + 2 * 60_000);
    await service.refreshUsage(MANAGED, true);
    expect(await service.usageSourceReport(MANAGED)).toMatchObject({ status: "available", windows: [{ usedPct: 30 }] });

    vi.setSystemTime(Date.now() + 10 * 60_000);
    await service.refreshUsage(MANAGED, true);
    // Due for a read, but the provider asked to wait until 08:14, so the report doesn't ask again.
    const stale = await service.usageSourceReport(MANAGED);
    expect(stale).toEqual({ status: "error", error: expect.stringMatching(/^Stale since 08:00 UTC: usage reads are rate-limited; retrying after 08:14 UTC$/) });

    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(await service.usageSourceReport(MANAGED)).toMatchObject({ status: "available", windows: [{ usedPct: 45 }] });
  });
});

describe("usage source", () => {
  it("lists every signed-in account", async () => {
    const { service, store } = await setUp([]);
    await store.update((draft) => {
      const managed = draft.accounts.find((account) => account.id === MANAGED);
      if (managed) managed.signedIn = false;
    });
    expect(await service.usageAccounts()).toEqual([
      { key: MAIN_ACCOUNT_ID.claude, label: `${MAIN_ACCOUNT_ID.claude}@example.com`, harness: "Claude", input: { accountId: MAIN_ACCOUNT_ID.claude } },
    ]);
  });

  it("reads an account again before reporting a reading that is due", async () => {
    let calls = 0;
    const { service } = await setUp(() => live(++calls * 10));
    expect(await service.usageSourceReport(MANAGED)).toMatchObject({ status: "available", planLabel: "pro", windows: [{ usedPct: 10 }] });
    expect(await service.usageSourceReport(MANAGED)).toMatchObject({ windows: [{ usedPct: 10 }] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    expect(await service.usageSourceReport(MANAGED)).toMatchObject({ windows: [{ usedPct: 20 }] });
    expect(await service.usageSourceReport("gone")).toEqual({ status: "error", error: "This account is no longer in ZeroSub." });
  });
});
