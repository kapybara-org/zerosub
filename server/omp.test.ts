import { describe, expect, it } from "vitest";
import { joinAccounts } from "./omp";

const limit = (usedFraction: number) => ({ id: "anthropic:5h", label: "5 Hour", amount: { usedFraction } });

describe("joinAccounts", () => {
  it("pairs same-provider accounts with their own usage by account id, whatever the report order", () => {
    const accounts = [
      { provider: "anthropic", credentialId: 3, label: "a@example.com", type: "oauth" },
      { provider: "anthropic", credentialId: 4, label: "b@example.com", type: "oauth" },
    ];
    const reports = [
      { provider: "anthropic", limits: [limit(0.9)], metadata: { accountId: "acct-b" } },
      { provider: "anthropic", limits: [limit(0.1)], metadata: { accountId: "acct-a" } },
    ];
    const resets = [
      { provider: "anthropic", credentialId: 3, accountId: "acct-a", availableCount: 0, redeemableCount: 0 },
      { provider: "anthropic", credentialId: 4, accountId: "acct-b", availableCount: 2, redeemableCount: 0, unavailableReason: "cooldown" },
    ];
    const [a, b] = joinAccounts(accounts, reports, resets);
    expect(a?.windows[0]?.usedPercent).toBe(10);
    expect(a?.resets).toBeNull();
    expect(b?.windows[0]?.usedPercent).toBe(90);
    expect(b?.resets).toMatchObject({ available: 2, usableNow: false });
  });

  it("shows no usage rather than a guess when same-provider accounts can't be told apart", () => {
    const accounts = [
      { provider: "github-copilot", credentialId: 7, label: "one", type: "oauth" },
      { provider: "github-copilot", credentialId: 8, label: "two", type: "oauth" },
    ];
    const reports = [{ provider: "github-copilot", limits: [limit(0.5)] }];
    expect(joinAccounts(accounts, reports, []).map((account) => account.windows)).toEqual([[], []]);
    expect(joinAccounts(accounts.slice(0, 1), reports, [])[0]?.windows).toHaveLength(1);
  });

  it("falls back to the account's newest recorded reading when OMP has no live one", () => {
    const accounts = [{ provider: "anthropic", credentialId: 3, label: "a@example.com", type: "oauth" }];
    const resets = [{ provider: "anthropic", credentialId: 3, accountId: "acct-a", availableCount: 0, redeemableCount: 0 }];
    const row = (recordedAt: number, accountId: string, usedFraction: number) => ({
      recordedAt,
      provider: "anthropic",
      accountId,
      limitId: "anthropic:5h",
      label: "5 Hour",
      usedFraction,
    });
    const history = [row(1_000, "acct-a", 0.2), row(2_000, "acct-a", 0.3), row(3_000, "acct-b", 0.9)];
    const [account] = joinAccounts(accounts, [], resets, history);
    expect(account?.windows.map((window) => window.usedPercent)).toEqual([30]);
    expect(account?.usageAt).toBe(new Date(2_000).toISOString());
  });
});
