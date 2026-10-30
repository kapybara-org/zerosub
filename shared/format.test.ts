import { describe, expect, it } from "vitest";
import { accountSubtitle, formatAge, formatCredits, formatPlan, formatResetIn, peakUsage, shortLabel, usageSummary } from "./format";
import type { AccountView } from "./model";

const NOW = Date.parse("2026-09-23T12:00:00Z");

describe("formatResetIn", () => {
  it("renders compact relative times", () => {
    expect(formatResetIn("2026-09-23T12:45:00Z", NOW)).toBe("in 45m");
    expect(formatResetIn("2026-09-23T14:00:00Z", NOW)).toBe("in 2h");
    expect(formatResetIn("2026-09-23T14:10:00Z", NOW)).toBe("in 2h 10m");
    expect(formatResetIn("2026-09-26T15:00:00Z", NOW)).toBe("in 3d 3h");
    expect(formatResetIn("2026-09-23T11:00:00Z", NOW)).toBe("now");
    expect(formatResetIn(null, NOW)).toBeNull();
    expect(formatResetIn("not a date", NOW)).toBeNull();
  });
});

describe("accountSubtitle", () => {
  it("drops an organization that only repeats the owner", () => {
    const email = "ada@example.com";
    expect(accountSubtitle({ email, organization: "ada@example.com's Organization" })).toBe(email);
    expect(accountSubtitle({ email, organization: "Ada's Organization" })).toBe(email);
    expect(accountSubtitle({ email, organization: email })).toBe(email);
    expect(accountSubtitle({ email, organization: null })).toBe(email);
  });

  it("keeps a real organization", () => {
    expect(accountSubtitle({ email: "a@acme.dev", organization: "Acme Engineering" })).toBe("a@acme.dev · Acme Engineering");
    expect(accountSubtitle({ email: null, organization: null })).toBeNull();
  });
});

describe("formatAge", () => {
  it("reads naturally", () => {
    expect(formatAge("2026-09-23T11:59:30Z", NOW)).toBe("just now");
    expect(formatAge("2026-09-23T11:54:00Z", NOW)).toBe("6m ago");
    expect(formatAge("2026-09-23T09:00:00Z", NOW)).toBe("3h ago");
    expect(formatAge("2026-09-21T12:00:00Z", NOW)).toBe("2d ago");
    expect(formatAge("garbage", NOW)).toBe("just now");
  });
});

describe("account presentation", () => {
  const account: AccountView = {
    id: "claude-a",
    family: "claude",
    label: "work",
    kind: "managed",
    email: "work@example.com",
    plan: "max",
    organization: null,
    status: "ready",
    isDefault: false,
    limitedUntil: null,
    usage: {
      fetchedAt: "2026-09-23T11:59:00Z",
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 30, resetsAt: "2026-09-23T14:00:00Z" },
        { id: "seven_day", label: "Weekly", usedPercent: 71.6, resetsAt: "2026-09-25T12:00:00Z" },
      ],
      error: null,
      cached: false,
      resets: null,
      credits: null,
    },
    agentCount: 2,
    home: "/homes/claude-a",
  };

  it("summarises the busiest window", () => {
    expect(peakUsage(account.usage?.windows ?? [])?.id).toBe("seven_day");
    expect(usageSummary(account, NOW)).toBe("72% of weekly used · resets in 2d");
  });

  it("puts a reached limit first", () => {
    expect(usageSummary({ ...account, status: "limited", limitedUntil: "2026-09-23T13:30:00Z" }, NOW)).toBe(
      "Limit reached · resets in 1h 30m",
    );
  });

  it("names the credits a full window falls back on", () => {
    expect(formatCredits({ balance: 57714.93, unlimited: false })).toBe("57,714 credits left");
    expect(formatCredits({ balance: 1, unlimited: false })).toBe("1 credit left");
    expect(formatCredits({ balance: null, unlimited: false })).toBe("Credits available");
    expect(formatCredits({ balance: null, unlimited: true })).toBe("Unlimited credits");
    const usage = account.usage && {
      ...account.usage,
      windows: [{ id: "primary", label: "Weekly", usedPercent: 100, resetsAt: "2026-09-25T12:00:00Z" }],
      credits: { balance: 1200, unlimited: false },
    };
    expect(usageSummary({ ...account, usage }, NOW)).toBe("100% of weekly used · 1,200 credits left");
  });

  it("names plans and trims long labels", () => {
    expect(formatPlan("prolite")).toBe("Pro Lite");
    expect(formatPlan("max")).toBe("Max");
    expect(formatPlan("something_new")).toBe("Something_new");
    expect(shortLabel({ label: "lovelace@analytical.example" })).toBe("lovelace@analytic…");
  });
});
