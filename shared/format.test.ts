import { describe, expect, it } from "vitest";
import {
  accountSubtitle,
  canStandIn,
  describeReopen,
  egressText,
  formatAge,
  formatCredits,
  formatCountdown,
  formatPlan,
  formatResetAt,
  formatResetIn,
  isDisabled,
  moveProblem,
  peakUsage,
  pillText,
  shortLabel,
  shortWindowLabel,
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

describe("formatResetAt", () => {
  // Local times, so it reads the same in every time zone. 28 October 2026 is a Wednesday.
  const now = new Date(2026, 9, 28, 15, 20).getTime();
  const at = (...parts: [number, number, number, number, number, number?, number?]) => new Date(...parts).toISOString();

  it("gives the time today, the weekday within the week, and the date a week on", () => {
    expect(formatResetAt(at(2026, 9, 28, 18, 0), now)).toBe("18:00");
    expect(formatResetAt(at(2026, 9, 29, 2, 5), now)).toBe("Thu 02:05");
    expect(formatResetAt(at(2026, 10, 3, 9, 0), now)).toBe("Tue 09:00");
    // Today's weekday again: the date says it isn't today.
    expect(formatResetAt(at(2026, 10, 4, 9, 0), now)).toBe("Nov 4 09:00");
  });

  it("rounds to the minute, so readings a moment apart read the same", () => {
    expect(formatResetAt(at(2026, 9, 28, 17, 59, 59, 600), now)).toBe("18:00");
  });

  it("has nothing to say once the time has passed, or when there's none", () => {
    expect(formatResetAt(at(2026, 9, 28, 15, 0), now)).toBeNull();
    expect(formatResetAt(null, now)).toBeNull();
    expect(formatResetAt("not a date", now)).toBeNull();
  });
});

describe("formatCountdown", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  it("counts hours and minutes, days and hours from a day on, as the status line does", () => {
    expect(formatCountdown("2026-10-28T15:26:40Z", now)).toBe("3h26m");
    expect(formatCountdown("2026-10-29T05:26:00Z", now)).toBe("17h26m");
    expect(formatCountdown("2026-10-30T05:40:00Z", now)).toBe("1d17h");
    expect(formatCountdown("2026-10-28T12:26:00Z", now)).toBe("26m");
    // Each unit is written even when it's nothing, so every entry reads alike.
    expect(formatCountdown("2026-10-28T15:00:00Z", now)).toBe("3h0m");
    expect(formatCountdown("2026-10-30T12:20:00Z", now)).toBe("2d0h");
    expect(formatCountdown("2026-10-28T12:00:30Z", now)).toBe("0m");
  });

  it("has nothing to say once the time has passed, or when there's none", () => {
    expect(formatCountdown("2026-10-28T11:59:00Z", now)).toBeNull();
    expect(formatCountdown(null, now)).toBeNull();
    expect(formatCountdown("not a date", now)).toBeNull();
  });
});

describe("egressText", () => {
  const now = Date.parse("2026-10-28T12:00:00Z");
  const egress = (checkedAt: string | null, ip: string | null = "203.0.113.7", error: string | null = null) => ({ ip, country: "US", checkedAt, error });

  it("gives the address Anthropic sees and its country", () => {
    expect(egressText(egress("2026-10-28T11:55:00Z"), now)).toBe("IP: 203.0.113.7 (US)");
    expect(egressText({ ...egress("2026-10-28T11:55:00Z"), country: null }, now)).toBe("IP: 203.0.113.7");
  });

  it("says how old the address is once it's been an hour, as when checks fail since", () => {
    expect(egressText(egress("2026-10-28T11:20:00Z", "203.0.113.7", "timed out"), now)).toBe("IP: 203.0.113.7 (US)");
    expect(egressText(egress("2026-10-28T10:50:00Z", "203.0.113.7", "timed out"), now)).toBe("IP: 203.0.113.7 (US, 1h ago)");
  });

  it("says it couldn't check when it never could, and nothing before the first check", () => {
    expect(egressText(egress(null, null, "Client network socket disconnected"), now)).toBe("IP: couldn't check");
    expect(egressText(null, now)).toBeNull();
  });
});

describe("shortWindowLabel", () => {
  it("shortens the window names Claude and Codex readings use", () => {
    expect(shortWindowLabel("5-hour")).toBe("5h");
    expect(shortWindowLabel("Weekly")).toBe("7d");
    expect(shortWindowLabel("3-day")).toBe("3d");
    expect(shortWindowLabel("90-minute")).toBe("90m");
    expect(shortWindowLabel("Usage")).toBe("Usage");
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
    auth: "subscription",
    api: null,
    apiEditable: false,
    email: "work@example.com",
    plan: "max",
    organization: null,
    status: "ready",
    disabled: false,
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
    externalHome: false,
    proxy: null,
    proxyEditable: true,
    inheritedProxy: null,
    proxyBlocked: null,
    proxyFile: null,
    proxyFollowers: [],
    launcher: "claude-work.sh",
    egress: null,
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

describe("account state for the app", () => {
  const base = { status: "ready" as const, disabled: false, auth: "subscription" as const };

  it("knows an account is disabled even when it's signed out too", () => {
    expect(isDisabled(base)).toBe(false);
    expect(isDisabled({ ...base, status: "signed_out", disabled: true })).toBe(true);
    // Older servers only said so through the status.
    expect(isDisabled({ ...base, status: "disabled", disabled: false })).toBe(true);
  });

  it("only lets ready subscription accounts take work over, as the server does", () => {
    const ready = { ...base, family: "claude" as const };
    expect(canStandIn(ready)).toBe(true);
    expect(canStandIn({ ...ready, auth: "api" })).toBe(false);
    expect(canStandIn({ ...ready, status: "limited" })).toBe(false);
    expect(canStandIn({ ...ready, status: "disabled" })).toBe(false);
    expect(canStandIn({ ...ready, status: "signed_out" })).toBe(false);
    // Pi's own login may be an API key too.
    expect(canStandIn({ ...ready, family: "pi" })).toBe(false);
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
