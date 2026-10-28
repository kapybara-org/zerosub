import { describe, expect, it } from "vitest";
import { buildOverlay, type OmpControls } from "./omp-controls";

const work = { provider: "anthropic", accountId: "acct-work", orgId: "org-1" };
const personal = { provider: "anthropic", accountId: "acct-personal", orgId: null };

describe("buildOverlay", () => {
  it("prefers one account with a reclaim threshold OMP accepts, above whichever reserve applies", () => {
    const controls: OmpControls = {
      preferred: [work],
      reserves: [
        { ...work, reservePct: 90 },
        { ...personal, reservePct: 0 },
      ],
      settings: {},
    };
    expect(buildOverlay(controls, 10, true)).toEqual({
      auth: {
        accountPolicies: [
          { provider: "anthropic", account: { accountId: "acct-work", orgId: "org-1" }, reservePct: 90, priority: 100, reclaimAbovePct: 100 },
          { provider: "anthropic", account: { accountId: "acct-personal" }, reservePct: 0 },
        ],
      },
    });
    const [policy] = (buildOverlay({ preferred: [work], reserves: [], settings: {} }, 10, true).auth?.accountPolicies ?? []) as Array<
      Record<string, number>
    >;
    expect(policy?.reclaimAbovePct).toBeGreaterThan(10);
  });

  it("writes settings under OMP's sections and leaves account policies to the user's own config when told to", () => {
    const controls: OmpControls = {
      preferred: [work],
      reserves: [],
      settings: { "retry.waitForUsageReset": false, "codexResets.keepCredits": 1 },
    };
    expect(buildOverlay(controls, 10, false)).toEqual({
      retry: { waitForUsageReset: false },
      codexResets: { keepCredits: 1 },
    });
  });
});
