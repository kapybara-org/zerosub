import { describe, expect, it } from "vitest";
import { backMoment, formatResetMoment } from "./format";
import {
  accountBinding,
  agentWindows,
  describeUsage,
  describeWindow,
  glance,
  glanceLabel,
  glanceTitle,
  holdsBack,
  kindOf,
  nameOf,
  roomLabel,
  tagOf,
  toneOf,
  windowsWorthReading,
} from "./glance";
import type { UsageWindow } from "./model";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const IN_2H = "2026-11-14T14:00:00Z";
const IN_3D = "2026-11-17T12:00:00Z";
const PAST = "2026-11-14T11:00:00Z";

const fiveHour = (usedPercent: number, resetsAt: string | null = IN_2H): UsageWindow => ({ id: "five_hour", label: "5-hour", usedPercent, resetsAt });
const weekly = (usedPercent: number, resetsAt: string | null = IN_3D): UsageWindow => ({ id: "seven_day", label: "Weekly", usedPercent, resetsAt });
const fable = (usedPercent: number, resetsAt: string | null = IN_3D): UsageWindow => ({ id: "weekly_fable", label: "Weekly · Fable", usedPercent, resetsAt });
const opus = (usedPercent: number): UsageWindow => ({ id: "seven_day_opus", label: "Weekly · Opus", usedPercent, resetsAt: IN_3D });

// The pill shows the figure alone; its glyph says which window it is, so the tag stands in for it here.
const shown = (windows: UsageWindow[], model: string | null = "claude-opus-5-5") =>
  glance(windows, model, NOW).map((entry) => `${entry.tag} ${glanceLabel(entry, NOW)}`);

describe("glance", () => {
  it("shows the 5-hour window while it's the busiest", () => {
    expect(shown([fiveHour(42), weekly(20)])).toEqual(["5h 42%"]);
  });

  it("shows the weekly window once it has less room left than the 5-hour", () => {
    expect(shown([fiveHour(12), weekly(61)])).toEqual(["week 61%"]);
  });

  it("adds the busiest other window while the 5-hour is nearly spent", () => {
    expect(shown([fiveHour(87), weekly(21)])).toEqual(["5h 87%", "week 21%"]);
    expect(shown([fiveHour(85), weekly(95)])).toEqual(["week 95%", "5h 85%"]);
    expect(shown([fiveHour(79), weekly(21)])).toEqual(["5h 79%"]);
  });

  it("shows a model's own window only to agents running that model", () => {
    const windows = [fiveHour(30), weekly(40), fable(100)];
    expect(shown(windows, "claude-fable-5-2")).toEqual(["Fable 3d"]);
    expect(shown(windows, "claude-opus-5-5")).toEqual(["week 40%"]);
    expect(shown(windows, null)).toEqual(["week 40%"]);
  });

  it("pairs a nearly spent 5-hour with the model's window when that's the busier of the rest", () => {
    expect(shown([fiveHour(92), weekly(40), fable(64)], "claude-fable-5-2")).toEqual(["5h 92%", "Fable 64%"]);
  });

  it("leaves out a window whose reset has passed, and shows nothing without a reading", () => {
    expect(shown([fiveHour(100, PAST), weekly(30)])).toEqual(["week 30%"]);
    expect(shown([])).toEqual([]);
    expect(shown([fiveHour(100, PAST)])).toEqual([]);
  });

  it("names Codex windows by their length", () => {
    const primary: UsageWindow = { id: "primary", label: "5-hour", usedPercent: 10, resetsAt: IN_2H, minutes: 300 };
    const secondary: UsageWindow = { id: "secondary", label: "30-day", usedPercent: 55, resetsAt: IN_3D, minutes: 43_200 };
    expect(shown([primary, secondary], null)).toEqual(["month 55%"]);
    expect(glance([primary, secondary], null, NOW).map((entry) => entry.kind)).toEqual(["monthly"]);
  });

  it("colours a window as it nears its end", () => {
    expect([0, 69, 70, 89, 90, 100].map(toneOf)).toEqual(["calm", "calm", "warning", "warning", "danger", "danger"]);
    expect(glance([fiveHour(93)], null, NOW)[0]).toMatchObject({ kind: "session", tone: "danger" });
  });

  it("breaks a tie with the window that stays full the longest", () => {
    expect(agentWindows([fiveHour(100), weekly(100)], null, NOW).map((window) => window.id)).toEqual(["seven_day", "five_hour"]);
  });
});

describe("windowsWorthReading", () => {
  const ids = (windows: UsageWindow[], model: string | null = "claude-opus-5-5") => windowsWorthReading(windows, model, NOW).map((window) => window.id);
  const IN_10H = "2026-11-14T22:00:00Z";

  it("keeps every live window, other models' too, in the reading's order", () => {
    expect(ids([fiveHour(50), weekly(19), fable(27)])).toEqual(["five_hour", "seven_day", "weekly_fable"]);
  });

  it("drops what a full limit makes moot: the 5-hour beside a full week", () => {
    expect(ids([fiveHour(7), weekly(100, IN_10H), fable(30)])).toEqual(["seven_day", "weekly_fable"]);
    expect(ids([fiveHour(7), weekly(100), fable(30)])).toEqual(["seven_day"]);
  });

  it("lets only a limit that stops the agent make others moot", () => {
    // A full Fable window doesn't stop an Opus agent: its 5-hour and week still count.
    expect(ids([fiveHour(10), weekly(40), fable(100)])).toEqual(["five_hour", "seven_day", "weekly_fable"]);
    expect(ids([fiveHour(10), weekly(40), fable(100)], "claude-fable-5-2")).toEqual(["weekly_fable"]);
  });

  it("keeps a full 5-hour with the week, which resets later, and drops passed resets", () => {
    expect(ids([fiveHour(100), weekly(40)])).toEqual(["five_hour", "seven_day"]);
    expect(ids([fiveHour(60, PAST), weekly(40)])).toEqual(["seven_day"]);
  });
});

describe("holdsBack", () => {
  it("matches a model's window on whole words of the model id", () => {
    expect(holdsBack(opus(10), "claude-opus-5-5")).toBe(true);
    expect(holdsBack(opus(10), "claude-opus-5-5[1m]")).toBe(true);
    expect(holdsBack(opus(10), "opus")).toBe(true);
    expect(holdsBack(opus(10), "claude-sonnet-5-5")).toBe(false);
    expect(holdsBack({ id: "weekly_claude_design", label: "Weekly · Claude Design", usedPercent: 1, resetsAt: null }, "claude-fable-5-2")).toBe(false);
    expect(holdsBack(weekly(10), null)).toBe(true);
  });
});

describe("kindOf, tagOf and nameOf", () => {
  it("name a window in words a glance reads", () => {
    expect([fiveHour(1), weekly(1), fable(1)].map((window) => [kindOf(window), tagOf(window), nameOf(window)])).toEqual([
      ["session", "5h", "5-hour limit"],
      ["weekly", "week", "Weekly limit"],
      ["model", "Fable", "Fable limit"],
    ]);
    expect(tagOf({ id: "secondary", label: "Weekly", usedPercent: 1, resetsAt: null, minutes: 10_080 })).toBe("week");
    expect(nameOf({ id: "secondary", label: "30-day", usedPercent: 1, resetsAt: null, minutes: 43_200 })).toBe("Monthly limit");
  });
});

describe("a full window", () => {
  it("shows the wait instead of the percentage", () => {
    const in97m = new Date(NOW + 97 * 60_000).toISOString();
    expect(glanceLabel(describeWindow(fiveHour(100, in97m)), NOW)).toBe("1h 37m");
    expect(glanceLabel(describeWindow(weekly(100)), NOW)).toBe("3d");
    expect(glanceLabel(describeWindow(weekly(100, null)), NOW)).toBe("Full");
  });
});

describe("glanceTitle", () => {
  // Clock times follow the machine's time zone, so the expected moments come from the same formatter.
  const in3d = formatResetMoment(IN_3D, NOW)!;
  const in2h = formatResetMoment(IN_2H, NOW)!;

  it("says when the window turns over, as a clock time", () => {
    expect(in3d).toMatch(/^[A-Z][a-z]{2} \d\d:\d\d$/);
    expect(in2h).toMatch(/^\d\d:\d\d$/);
    expect(glanceTitle(describeWindow(weekly(54)), NOW)).toBe(`Weekly limit · resets ${in3d}`);
    expect(glanceTitle(describeWindow(fiveHour(76)), NOW)).toBe(`5-hour limit · resets ${in2h}`);
  });

  it("says when a full window is back", () => {
    expect(glanceTitle(describeWindow(fiveHour(100)), NOW)).toBe(`5-hour limit · back at ${in2h}`);
    expect(glanceTitle(describeWindow(weekly(100)), NOW)).toBe(`Weekly limit · back ${backMoment(in3d)}`);
    expect(backMoment("Fri 08:12")).toBe("Fri at 08:12");
  });

  it("falls back to the share used without a known reset", () => {
    expect(glanceTitle(describeWindow(fable(64, null)), NOW)).toBe("Fable limit · 64% used");
    expect(glanceTitle(describeWindow(weekly(100, null)), NOW)).toBe("Weekly limit reached");
  });
});

describe("describeUsage", () => {
  it("says the whole reading in one sentence", () => {
    expect(describeUsage(describeWindow(weekly(54)), NOW)).toBe("Weekly limit: 54% used, resets in 3d");
    expect(describeUsage(describeWindow(fiveHour(100)), NOW)).toBe("5-hour limit reached, resets in 2h");
    expect(describeUsage(describeWindow(fable(64, null)), NOW)).toBe("Fable limit: 64% used");
  });
});

describe("accountBinding and roomLabel", () => {
  it("weigh an account by its own busiest window, as room left", () => {
    const binding = accountBinding([fiveHour(12), weekly(95), fable(100)], NOW)!;
    expect(binding.window.id).toBe("seven_day");
    expect(roomLabel(binding, NOW)).toBe("5% left · week");
    expect(roomLabel(describeWindow(fiveHour(100)), NOW)).toBe("full, back in 2h");
    expect(accountBinding([fable(100)], NOW)).toBeNull();
    expect(roomLabel(describeWindow(fiveHour(0)), NOW)).toBe("100% left");
  });
});
