import { describe, expect, it } from "vitest";
import {
  accountSubtitle,
  describeReopen,
  formatAge,
  formatCredits,
  formatExtraUsage,
  formatPlan,
  formatResetIn,
  moveProblem,
  peakUsage,
  pillText,
  shortLabel,
  staleNotice,
  usageSummary,
} from "./format";
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
    auth: "subscription",
    api: null,
    apiEditable: false,
    proxy: null,
    proxyEditable: false,
    inheritedProxy: null,
    proxyFile: null,
    proxyFollowers: [],
    launcher: null,
    egress: null,
    externalHome: false,
    moving: null,
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
    expect(formatCredits({ balance: 57714.93, unlimited: false })).toBe("57,714 ChatGPT credits left");
    expect(formatCredits({ balance: 1, unlimited: false })).toBe("1 ChatGPT credit left");
    expect(formatCredits({ balance: 0.4, unlimited: false })).toBe("Less than 1 ChatGPT credit left");
    expect(formatCredits({ balance: null, unlimited: false })).toBe("ChatGPT credits available");
    expect(formatCredits({ balance: null, unlimited: true })).toBe("Unlimited ChatGPT credits");
  });

  it("names plans and trims long labels", () => {
    expect(formatPlan("prolite")).toBe("Pro Lite");
    expect(formatPlan("max")).toBe("Max");
    expect(formatPlan("something_new")).toBe("Something_new");
    expect(shortLabel({ label: "lovelace@analytical.example" })).toBe("lovelace@analytic…");
  });
});

describe("staleNotice", () => {
  it("says how old the data shown is and why it isn't newer", () => {
    expect(staleNotice(NOW - 3 * 60_000, "Plugin is not available", NOW)).toBe(
      "Showing data from 3m ago · couldn't refresh: Plugin is not available",
    );
    expect(staleNotice(NOW - 5_000, "Plugin RPC timed out", NOW)).toBe("Showing data from a moment ago · couldn't refresh: Plugin RPC timed out");
    expect(staleNotice(null, "Plugin is not available", NOW)).toBe("Couldn't refresh: Plugin is not available");
  });
});

describe("pillText", () => {
  const work = { label: "work", email: "ada@example.com" };

  it("names the account an agent runs on", () => {
    expect(pillText(work, null, null)).toEqual({ label: "work", title: "Account: work (ada@example.com)" });
  });

  it("names both accounts while the session hasn't moved yet, and says when it will", () => {
    expect(pillText(work, { label: "lovelace@analytical.example" }, "idle")).toEqual({
      label: "lovelace@an… → work",
      title: "Account: lovelace@analytical.example, moving to work (ada@example.com) once it's idle",
    });
    expect(pillText(work, { label: "personal" }, "turn").title).toBe(
      "Account: personal, moving to work (ada@example.com) when its current turn ends",
    );
    expect(pillText(work, { label: "personal" }, "background").title).toBe(
      "Account: personal, moving to work (ada@example.com) once the background work it left running stops",
    );
    // Not moved unattended, a reload that didn't work, or no CLI to reload with: not "once it's idle", which won't happen.
    expect(pillText(work, { label: "personal" }, "restart").title).toBe(
      "Account: personal, moving to work (ada@example.com) when its session next starts",
    );
  });
});

describe("move outcomes", () => {
  const nothing = { reopened: [], deferred: [], failed: [], pending: [], continuedIn: null };

  it("sums up what moving agents came to, including moves still going on", () => {
    expect(describeReopen("work is now the default", nothing)).toBe("work is now the default");
    expect(
      describeReopen("work is disabled", { ...nothing, reopened: ["a"], pending: ["b", "c"], deferred: ["d"], failed: [{ agentId: "e", error: "x" }] }),
    ).toBe(
      "work is disabled · 1 agent(s) switched · 2 still switching (their timelines will say when) · 1 will switch after their current turn · 1 couldn't be reloaded and will switch when their session next starts",
    );
  });

  it("says why one agent didn't move now, and only then", () => {
    expect(moveProblem(nothing, "work")).toBeNull();
    expect(moveProblem({ ...nothing, deferred: ["a"] }, "work")).toBeNull();
    expect(moveProblem({ ...nothing, pending: ["a"] }, "work")).toBeNull();
    expect(moveProblem({ ...nothing, failed: [{ agentId: "a", error: "Timed out closing previous session during refresh" }] }, "work")).toBe(
      "Couldn't reload this agent onto work (Timed out closing previous session during refresh), so it moves when its session next starts.",
    );
  });
});

describe("formatExtraUsage", () => {
  it("shows spend and the monthly cap in the account's currency", () => {
    expect(formatExtraUsage({ enabled: true, spend: 1234, limit: 5000, currency: "USD" })).toBe("Extra usage on · $12.34 of $50.00 this month");
    expect(formatExtraUsage({ enabled: true, spend: 123456, limit: null, currency: "EUR" })).toBe("Extra usage on · €1,234.56 spent this month");
    expect(formatExtraUsage({ enabled: true, spend: 50, limit: 1000, currency: "cad" })).toBe("Extra usage on · 0.50 CAD of 10.00 CAD this month");
  });

  it("says only that it's on when the spend isn't known, and nothing when it's off", () => {
    expect(formatExtraUsage({ enabled: true, spend: null, limit: 5000, currency: "USD" })).toBe("Extra usage on");
    expect(formatExtraUsage({ enabled: false, spend: 0, limit: 5000, currency: "USD" })).toBeNull();
  });
});
