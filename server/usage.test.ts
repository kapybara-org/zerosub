import { describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import { SwitchGuard } from "./switch-guard";
import { markStale, mergeUsage, retryDelayMs, showLimit, STALE_MS, usageReport } from "./usage";

const reading = (patch: Partial<Usage> = {}): Usage => ({
  fetchedAt: "2026-09-23T08:00:00.000Z",
  windows: [
    { id: "five_hour", label: "5-hour", usedPercent: 92, resetsAt: "2026-09-23T08:10:00.000Z" },
    { id: "seven_day", label: "Weekly", usedPercent: 9, resetsAt: "2026-09-29T20:00:00.000Z" },
    { id: "weekly_fable", label: "Weekly · Fable", usedPercent: 0, resetsAt: "2026-09-29T20:00:00.000Z" },
  ],
  error: null,
  cached: false,
  resets: null,
  ...patch,
});

describe("showLimit", () => {
  it("fills the window that resets when the limit notice says", () => {
    const shown = showLimit(reading(), "2026-09-23T08:10:00.000Z");
    expect(shown.windows.map((window) => window.usedPercent)).toEqual([100, 9, 0]);
  });

  it("picks the fullest of windows resetting together", () => {
    const shown = showLimit(reading(), "2026-09-29T20:00:00.000Z");
    expect(shown.windows.map((window) => window.usedPercent)).toEqual([92, 100, 0]);
  });

  it("leaves the reading alone when no window matches or the time is unknown", () => {
    expect(showLimit(reading(), "2026-09-25T00:00:00.000Z")).toEqual(reading());
    expect(showLimit(reading(), null)).toEqual(reading());
  });
});

describe("mergeUsage", () => {
  it("keeps the last windows through a failed or rate-limited refresh", () => {
    const merged = mergeUsage(reading(), reading({ fetchedAt: "2026-09-23T08:05:00.000Z", windows: [], error: "offline" }));
    expect(merged.windows).toHaveLength(3);
    expect(merged.error).toBe("offline");
    expect(merged.fetchedAt).toBe("2026-09-23T08:00:00.000Z");
  });

  it("only lets the CLI's cached copy replace an older reading", () => {
    const older = reading({ fetchedAt: "2026-09-23T07:00:00.000Z", cached: true });
    expect(mergeUsage(reading(), older)).toEqual(reading());
    const newer = reading({ fetchedAt: "2026-09-23T08:30:00.000Z", cached: true });
    expect(mergeUsage(reading(), newer)).toBe(newer);
    expect(mergeUsage(undefined, older)).toBe(older);
  });
});

describe("markStale", () => {
  const now = Date.parse("2026-09-23T08:00:00.000Z") + STALE_MS + 60_000;

  it("leaves a live reading and a recent kept reading as they are", () => {
    expect(markStale(reading(), reading(), now)).toEqual(reading());
    const recent = Date.parse("2026-09-23T08:05:00.000Z");
    expect(markStale(reading(), reading({ windows: [], error: null, cached: false }), recent)).toEqual(reading());
  });

  it("says why a reading older than the limit was kept", () => {
    const limited = markStale(reading(), { ...reading({ cached: true }), retryAt: Date.parse("2026-09-23T08:13:00.000Z") }, now);
    expect(limited.error).toBe("Stale since 08:00 UTC: usage reads are rate-limited; retrying after 08:13 UTC");
    expect(limited.windows).toEqual(reading().windows);
    expect(markStale(reading(), reading({ windows: [], error: "offline" }), now).error).toBe("Stale since 08:00 UTC: offline");
    expect(markStale(reading(), reading({ fetchedAt: "2026-09-23T07:00:00.000Z", cached: true }), now).error).toBe(
      "Stale since 08:00 UTC: the sign-in needs renewing, so only the CLI's cached copy is available",
    );
  });

  it("never labels an old cached copy as current", () => {
    const cached = reading({ fetchedAt: "2026-09-23T06:00:00.000Z", cached: true });
    expect(markStale(cached, cached, now).error).toMatch(/^Stale since 06:00 UTC: /);
  });

  it("has nothing to mark without windows", () => {
    const empty = reading({ windows: [], error: "Not signed in." });
    expect(markStale(empty, empty, now)).toBe(empty);
  });
});

describe("usageReport", () => {
  it("turns a current reading into a Paseo usage report", () => {
    expect(usageReport(reading(), "pro")).toEqual({
      status: "available",
      planLabel: "pro",
      windows: [
        { id: "five_hour", label: "5-hour", usedPct: 92, remainingPct: 8, resetsAt: "2026-09-23T08:10:00.000Z", tone: "danger", summary: true },
        { id: "seven_day", label: "Weekly", usedPct: 9, remainingPct: 91, resetsAt: "2026-09-29T20:00:00.000Z", tone: "ok", summary: true },
        { id: "weekly_fable", label: "Weekly · Fable", usedPct: 0, remainingPct: 100, resetsAt: "2026-09-29T20:00:00.000Z", tone: "ok" },
      ],
      balances: [],
      details: [],
    });
  });

  it("reports a stale or missing reading as an error rather than as current", () => {
    expect(usageReport(reading({ error: "Stale since 08:00 UTC: offline" }), null)).toEqual({
      status: "error",
      error: "Stale since 08:00 UTC: offline",
    });
    expect(usageReport(undefined, null)).toEqual({ status: "error", error: "ZeroSub has no usage reading for this account yet." });
  });
});

describe("retryDelayMs", () => {
  it("reads seconds and dates, within sane bounds", () => {
    const now = Date.parse("2026-09-23T08:00:00Z");
    expect(retryDelayMs("120", now)).toBe(120_000);
    expect(retryDelayMs("1", now)).toBe(30_000);
    expect(retryDelayMs("86400", now)).toBe(30 * 60_000);
    expect(retryDelayMs("Wed, 23 Sep 2026 08:05:00 GMT", now)).toBe(5 * 60_000);
    expect(retryDelayMs(null, now)).toBe(2 * 60_000);
    expect(retryDelayMs("soon", now)).toBe(2 * 60_000);
  });
});

describe("SwitchGuard", () => {
  it("counts only moves that happened, within the window", () => {
    const guard = new SwitchGuard(2, 10_000);
    expect(guard.allows("a", 0)).toBe(true);
    guard.note("a", 0);
    guard.note("a", 1_000);
    expect(guard.allows("a", 2_000)).toBe(false);
    expect(guard.allows("b", 2_000)).toBe(true);
    expect(guard.allows("a", 10_500)).toBe(true);
    guard.forget("a");
    expect(guard.allows("a", 2_000)).toBe(true);
  });
});
