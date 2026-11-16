import { backMoment, capsAccount, formatCountdown, formatCredits, formatPercent, formatResetMoment } from "./format";
import type { AccountView, UsageWindow } from "./model";

/** What a window caps, which picks its icon: a clock for the 5-hour, a calendar for the weekly… */
export type WindowKind = "session" | "weekly" | "monthly" | "model";

/** How close a window is to its end, which picks its colour. */
export type UsageTone = "calm" | "warning" | "danger";

export interface GlanceWindow {
  window: UsageWindow;
  kind: WindowKind;
  /** Its short name next to the percentage: "5h", "week", "month", "Fable". */
  tag: string;
  /** Its name in a sentence: "5-hour limit", "Weekly limit", "Fable limit". */
  name: string;
  tone: UsageTone;
}

/** Same thresholds as the bars on the Accounts screen (`UsageBar`). */
export const WARNING_AT = 70;
export const DANGER_AT = 90;
/** From here the 5-hour window is nearly spent, so the room left once it resets matters too. */
export const SESSION_NEARLY_SPENT_AT = 80;

const DAY_MINUTES = 24 * 60;
const WEEK_MINUTES = 7 * DAY_MINUTES;

export function toneOf(usedPercent: number): UsageTone {
  if (usedPercent >= DANGER_AT) return "danger";
  if (usedPercent >= WARNING_AT) return "warning";
  return "calm";
}

/** The model or surface a narrower window caps: "Opus" for Claude's "Weekly · Opus". */
export function scopeOf(window: UsageWindow): string | null {
  if (capsAccount(window)) return null;
  const parts = window.label.split("·");
  const scope = parts.length > 1 ? parts[parts.length - 1]!.trim() : "";
  return scope || null;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Whether `window` holds back an agent running `model`. The account's own windows hold back every
 * agent; one model's window ("Weekly · Fable") only those running that model ("claude-fable-5-2").
 * With the model unknown, a model's window is left out rather than shown for the wrong one.
 */
export function holdsBack(window: UsageWindow, model: string | null): boolean {
  if (capsAccount(window)) return true;
  const scope = scopeOf(window);
  if (!scope || !model) return false;
  const modelTokens = new Set(tokens(model));
  const scopeTokens = tokens(scope);
  return scopeTokens.length > 0 && scopeTokens.every((token) => modelTokens.has(token));
}

export function kindOf(window: UsageWindow): WindowKind {
  if (!capsAccount(window)) return "model";
  if (window.id === "five_hour") return "session";
  if (window.id === "seven_day") return "weekly";
  // Codex says how long its two windows are; without that, the first is the short one.
  const minutes = window.minutes ?? (window.id === "primary" ? 300 : WEEK_MINUTES);
  if (minutes <= DAY_MINUTES) return "session";
  return minutes <= WEEK_MINUTES ? "weekly" : "monthly";
}

/**
 * The short name beside the percentage, in words a glance reads: "5h", "week", "month". A model's
 * window says the model ("Fable"). Codex windows are named by their length.
 */
export function tagOf(window: UsageWindow, kind: WindowKind = kindOf(window)): string {
  if (kind === "model") return scopeOf(window) ?? window.label;
  if (kind === "weekly") return "week";
  if (kind === "monthly") return "month";
  const minutes = window.minutes ?? 300;
  return `${Math.max(1, Math.round(minutes / 60))}h`;
}

/** The window's name in a sentence: "5-hour limit", "Weekly limit", "Fable limit". */
export function nameOf(window: UsageWindow, kind: WindowKind = kindOf(window)): string {
  if (kind === "model") return `${scopeOf(window) ?? window.label} limit`;
  if (kind === "weekly") return "Weekly limit";
  if (kind === "monthly") return "Monthly limit";
  return `${tagOf(window, kind).replace("h", "-hour")} limit`;
}

/** Whether the window has no room left: the agent waits for its reset. */
export function isFull(window: UsageWindow): boolean {
  return window.usedPercent >= 100;
}

function resetsAt(window: UsageWindow): number {
  const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

/**
 * The windows that hold back an agent running `model`, busiest first. A window whose reset has
 * already passed is left out: its reading predates the reset, so it no longer says anything.
 */
export function agentWindows(windows: readonly UsageWindow[], model: string | null, now: number = Date.now()): UsageWindow[] {
  return windows
    .filter((window) => holdsBack(window, model) && resetsAt(window) > now)
    .sort((a, b) => b.usedPercent - a.usedPercent || resetsAt(b) - resetsAt(a));
}

/**
 * The windows still worth reading, in their own order. Once a window that holds the agent back is
 * full, the ones that reset before it frees up change nothing (a 5-hour window beside a full week)
 * and are left out, like a window whose reset has passed.
 */
export function windowsWorthReading(windows: readonly UsageWindow[], model: string | null, now: number = Date.now()): UsageWindow[] {
  const live = windows.filter((window) => resetsAt(window) > now);
  const blocks = (window: UsageWindow) => holdsBack(window, model) && isFull(window);
  const blockedUntil = Math.max(Number.NEGATIVE_INFINITY, ...live.filter(blocks).map(resetsAt));
  return live.filter((window) => blocks(window) || resetsAt(window) > blockedUntil);
}

/**
 * What to show at a glance for an agent: the window that holds it back the most, whichever it is
 * (the weekly once it's busier than the 5-hour, or the model's own). While the 5-hour is nearly
 * spent, a second one too: the 5-hour and the busiest of the rest, so the room left once it resets
 * shows before it's needed. Empty without a usable reading.
 */
export function glance(windows: readonly UsageWindow[], model: string | null, now: number = Date.now()): GlanceWindow[] {
  const ranked = agentWindows(windows, model, now);
  const first = ranked[0];
  if (!first) return [];
  const session = ranked.find((window) => kindOf(window) === "session");
  const shown = [first];
  if (session && session.usedPercent >= SESSION_NEARLY_SPENT_AT) {
    const second = session === first ? ranked[1] : session;
    if (second) shown.push(second);
  }
  return shown.map(describeWindow);
}

export function describeWindow(window: UsageWindow): GlanceWindow {
  const kind = kindOf(window);
  return { window, kind, tag: tagOf(window, kind), name: nameOf(window, kind), tone: toneOf(window.usedPercent) };
}

/**
 * The window that bounds an account for any agent: the busiest of its own windows, leaving out the
 * ones that cap a single model. What the account menu weighs accounts by.
 */
export function accountBinding(windows: readonly UsageWindow[], now: number = Date.now()): GlanceWindow | null {
  const first = agentWindows(windows, null, now)[0];
  return first ? describeWindow(first) : null;
}

/**
 * The pill's text: "87%", "54%", "64%". The glyph beside it already says which window (a clock, a
 * calendar, a sparkle), so the figure stands alone. Once full, the wait instead, since the
 * percentage no longer says anything: "1h 37m", or "Full" without a known reset.
 */
export function glanceLabel(entry: GlanceWindow, now: number = Date.now()): string {
  if (!isFull(entry.window)) return formatPercent(entry.window.usedPercent);
  return formatCountdown(entry.window.resetsAt, now) ?? "Full";
}

/**
 * The pill's tooltip. The pill already says how much, so this says when, as a clock time rather
 * than a countdown to work out: "Weekly limit · resets Fri 08:12", "5-hour limit · back at 04:35".
 * Without a known reset, the share used instead: "Fable limit · 64% used".
 */
export function glanceTitle(entry: GlanceWindow, now: number = Date.now()): string {
  const moment = formatResetMoment(entry.window.resetsAt, now);
  if (isFull(entry.window)) return moment ? `${entry.name} · back ${backMoment(moment)}` : `${entry.name} reached`;
  return `${entry.name} · ${moment ? `resets ${moment}` : `${formatPercent(entry.window.usedPercent)} used`}`;
}

/**
 * The whole reading of a window in one sentence, for screen readers in the usage card, where the
 * share used isn't on screen beside it: "Weekly limit: 54% used, resets in 3d 4h".
 */
export function describeUsage(entry: GlanceWindow, now: number = Date.now()): string {
  const wait = formatCountdown(entry.window.resetsAt, now);
  if (isFull(entry.window)) return `${entry.name} reached${wait ? `, resets in ${wait}` : ""}`;
  return `${entry.name}: ${formatPercent(entry.window.usedPercent)} used${wait ? `, resets in ${wait}` : ""}`;
}

/**
 * The room an account has, for picking one: "46% left · week", or "full, back in 1h 37m". Room
 * rather than use, since that is what a choice weighs.
 */
export function roomLabel(entry: GlanceWindow, now: number = Date.now()): string {
  if (isFull(entry.window)) {
    const wait = formatCountdown(entry.window.resetsAt, now);
    return wait ? `full, back in ${wait}` : "full";
  }
  // Untouched, every window has all its room: naming one would only add noise.
  if (Math.round(entry.window.usedPercent) <= 0) return "100% left";
  return `${formatPercent(100 - entry.window.usedPercent)} left · ${entry.tag}`;
}

/**
 * What an account has left, after its name in a picker: "46% left · week", "full, back in 1h 37m",
 * "signed out". Null without a reading to weigh it by.
 */
export function accountRoom(account: AccountView, now: number = Date.now()): string | null {
  if (account.status === "signed_out") return "signed out";
  if (account.status === "disabled") return "disabled";
  const binding = account.usage ? accountBinding(account.usage.windows, now) : null;
  const credits = account.usage?.credits ? formatCredits(account.usage.credits) : null;
  if (account.status === "limited" && !(binding && isFull(binding.window))) {
    const wait = formatCountdown(account.limitedUntil, now);
    return [wait ? `full, back in ${wait}` : "full", credits].filter(Boolean).join(" · ");
  }
  if (!binding) return null;
  // Credits keep an account going past full windows, so they only matter once it's full.
  return [roomLabel(binding, now), isFull(binding.window) ? credits : null].filter(Boolean).join(" · ");
}

/** How an account's ring looks: its binding window, full once it's limited, dashed when it can't run. */
export interface AccountRing {
  usedPercent: number;
  tone: UsageTone;
  dashed: boolean;
}

export function accountRing(account: AccountView, now: number = Date.now()): AccountRing {
  if (account.status === "signed_out" || account.status === "disabled") return { usedPercent: 0, tone: "calm", dashed: true };
  if (account.status === "limited") return { usedPercent: 100, tone: "danger", dashed: false };
  const binding = account.usage ? accountBinding(account.usage.windows, now) : null;
  return { usedPercent: binding?.window.usedPercent ?? 0, tone: binding?.tone ?? "calm", dashed: false };
}
