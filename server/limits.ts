import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { LimitHit, LimitKind } from "./adapter";

type TurnEvent = { outcome: PluginTurnOutcome; timeline: readonly AgentTimelineItem[] };

/**
 * Claude Code's exact wording for hard limits (2.1.x templates: `You've hit your ${limit}${suffix}`),
 * plus the legacy `Claude AI usage limit reached|<epoch>`. Each must be followed by the CLI's own
 * separator (" · …", ".") or end the line, so prose like "You've hit your GitHub API rate limit"
 * never matches. Warnings ("You've used 80%…") and capacity 429s ("…not your usage limit") are
 * deliberately absent: switching accounts doesn't help with those.
 */
const END = String.raw`(?=\s*(?:·|\.|$))`;
const APOSTROPHE = "['’]";
const CLAUDE_LIMITS: ReadonlyArray<{ pattern: RegExp; kind: LimitKind }> = [
  { pattern: new RegExp(`^You${APOSTROPHE}ve hit your (?:session |weekly |Opus |Sonnet |Fable )?limit${END}`, "i"), kind: "window" },
  { pattern: new RegExp(`^You${APOSTROPHE}ve reached your (?:Fable|Opus|Sonnet|Haiku)(?: [\\w.]{1,10})? limit${END}`), kind: "window" },
  { pattern: /Claude AI usage limit reached\|\d{9,}/, kind: "window" },
  {
    pattern: new RegExp(
      `^You${APOSTROPHE}ve hit your (?:usage credit limit|team${APOSTROPHE}s shared budget|(?:monthly|individual) spend limit|(?:org|channel)${APOSTROPHE}s monthly (?:usage|spend) limit)${END}`,
      "i",
    ),
    kind: "budget",
  },
  { pattern: new RegExp(`^You${APOSTROPHE}re out of (?:usage credits|extra usage)${END}`, "i"), kind: "budget" },
  { pattern: /^Your org is out of usage\s*·/i, kind: "budget" },
  { pattern: new RegExp(`^Your seat type doesn${APOSTROPHE}t include (?:usage credits|extra usage|usage)\\b`, "i"), kind: "budget" },
  { pattern: /^Your usage allocation has been disabled by your admin/i, kind: "budget" },
  { pattern: new RegExp(`^Your group${APOSTROPHE}s usage limit is set to \\$0`, "i"), kind: "budget" },
  { pattern: /^Fable(?: [^·\n]{1,40})? requires usage credits\./, kind: "budget" },
];

/** Codex's messages for plan limits (typographic apostrophe) and workspace budgets, plus the raw error type. */
const CODEX_LIMITS: ReadonlyArray<{ pattern: RegExp; kind: LimitKind }> = [
  { pattern: new RegExp(`^You${APOSTROPHE}ve hit your usage limit\\b`, "i"), kind: "window" },
  { pattern: /^The usage limit has been reached\b/i, kind: "window" },
  { pattern: /"type"\s*:\s*"usage_limit_reached"/, kind: "window" },
  { pattern: /^Your workspace is out of credits\b/i, kind: "budget" },
  { pattern: /^You hit your spend cap\b/i, kind: "budget" },
];

const CLAUDE_SIGNED_OUT =
  /^(?:Not logged in\s*·|Invalid API key\s*·|OAuth token (?:has expired|has been revoked)|Failed to authenticate\. API Error: 401)/i;
const CODEX_SIGNED_OUT =
  /refresh token was already used|please log out and sign in again|access token could not be refreshed|refresh_token_reused|refresh_token_expired/i;

const SYSTEM_ERROR = /^\[System Error\]\s*/;
const MAX_NOTICE = 400;

function clean(text: string): string {
  return text.replace(SYSTEM_ERROR, "").replace(/^API Error:\s*/i, "").trim();
}

/**
 * Where a CLI-generated notice can appear in a finished turn: the failure message, error items,
 * Paseo's `[System Error]` rows, and — for Claude, which reports limits as a synthetic reply — the
 * final assistant messages. Ordinary replies earlier in the turn are never inspected.
 */
function notices(event: TurnEvent, includeFinalReplies: boolean): string[] {
  const found: string[] = [];
  if (event.outcome.kind === "failed") found.push(event.outcome.error.message);
  let replies = 0;
  for (let index = event.timeline.length - 1; index >= 0; index -= 1) {
    const item = event.timeline[index];
    if (!item) continue;
    if (item.type === "user_message") break;
    if (item.type === "error") found.push(item.message);
    else if (item.type === "notification" && item.level !== "info") found.push(item.message);
    else if (item.type === "assistant_message") {
      if (SYSTEM_ERROR.test(item.text)) found.push(item.text);
      else if (includeFinalReplies && replies < 2) found.push(item.text);
      replies += 1;
    }
  }
  return found.map(clean).filter((text) => text.length > 0 && text.length <= MAX_NOTICE);
}

function firstLine(text: string): string {
  return (text.split("\n")[0] ?? text).trim();
}

export function detectClaudeLimit(event: TurnEvent, now: Date = new Date()): LimitHit | null {
  for (const text of notices(event, true)) {
    const line = firstLine(text);
    const match = CLAUDE_LIMITS.find(({ pattern }) => pattern.test(line));
    if (match) return { message: line, kind: match.kind, resetsAt: parseClaudeReset(line, now) };
  }
  return null;
}

export function detectCodexLimit(event: TurnEvent, now: Date = new Date()): LimitHit | null {
  for (const text of notices(event, false)) {
    const match = CODEX_LIMITS.find(({ pattern }) => pattern.test(text));
    if (match) return { message: firstLine(text), kind: match.kind, resetsAt: parseCodexReset(text, now) };
  }
  return null;
}

/** A turn that failed because the account's login is no longer valid. */
export function detectClaudeSignOut(event: TurnEvent): string | null {
  for (const text of notices(event, true)) if (CLAUDE_SIGNED_OUT.test(firstLine(text))) return firstLine(text);
  return null;
}

export function detectCodexSignOut(event: TurnEvent): string | null {
  for (const text of notices(event, false)) if (CODEX_SIGNED_OUT.test(text)) return firstLine(text);
  return null;
}

// --------------------------------------------------------------------------- reset times

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * "· resets 3pm (Asia/Kolkata)", "· resets 3:30pm (America/New_York)",
 * "· resets Sep 25, 3pm (Europe/Berlin)", or the legacy "|1790150000" epoch.
 */
export function parseClaudeReset(text: string, now: Date): string | null {
  const epoch = text.match(/usage limit reached\|(\d{9,})/i);
  if (epoch?.[1]) return new Date(Number(epoch[1]) * 1000).toISOString();
  const match = text.match(
    /resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i,
  );
  if (!match) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zone] = match;
  const hour = to24(Number(hourText), meridiem ?? "a");
  const minute = Number(minuteText ?? 0);
  const timeZone = zone && isTimeZone(zone.trim()) ? zone.trim() : undefined;
  const month = monthName ? MONTHS.indexOf(monthName.toLowerCase()) : -1;
  return nextOccurrence(now, { month: month >= 0 ? month : null, day: dayText ? Number(dayText) : null, hour, minute, timeZone });
}

/** "try again at 3:45 PM" or "try again at Sep 24, 2026 3:45 PM", in the daemon's local time. */
export function parseCodexReset(text: string, now: Date): string | null {
  const match = text.match(
    /try again at\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:(\d{4})\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([AaPp])\.?[Mm]\.?/,
  );
  if (!match) return null;
  const [, monthName, dayText, yearText, hourText, minuteText, meridiem] = match;
  const hour = to24(Number(hourText), meridiem ?? "a");
  const minute = Number(minuteText ?? 0);
  const month = monthName ? MONTHS.indexOf(monthName.toLowerCase()) : -1;
  if (yearText && month >= 0 && dayText) {
    const at = new Date(Number(yearText), month, Number(dayText), hour, minute);
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
  }
  return nextOccurrence(now, { month: month >= 0 ? month : null, day: dayText ? Number(dayText) : null, hour, minute });
}

function to24(hour: number, meridiem: string): number {
  const pm = meridiem.toLowerCase() === "p";
  if (hour === 12) return pm ? 12 : 0;
  return pm ? hour + 12 : hour;
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of `instant` in `timeZone` (or the local zone). */
function partsIn(instant: number, timeZone?: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  return { year: get("year"), month: get("month") - 1, day: get("day"), hour: get("hour") % 24, minute: get("minute") };
}

/** The UTC instant at which `timeZone`'s wall clock reads the given date and time. */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, timeZone?: string): number {
  const wall = Date.UTC(year, month, day, hour, minute);
  let guess = wall;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const seen = partsIn(guess, timeZone);
    const delta = wall - Date.UTC(seen.year, seen.month, seen.day, seen.hour, seen.minute);
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}

function nextOccurrence(
  now: Date,
  target: { month: number | null; day: number | null; hour: number; minute: number; timeZone?: string },
): string | null {
  const today = partsIn(now.getTime(), target.timeZone);
  if (target.month !== null && target.day !== null) {
    let at = zonedInstant(today.year, target.month, target.day, target.hour, target.minute, target.timeZone);
    if (at < now.getTime() - 60_000) {
      at = zonedInstant(today.year + 1, target.month, target.day, target.hour, target.minute, target.timeZone);
    }
    return new Date(at).toISOString();
  }
  let at = zonedInstant(today.year, today.month, today.day, target.hour, target.minute, target.timeZone);
  if (at <= now.getTime()) {
    const tomorrow = partsIn(now.getTime() + 24 * 3_600_000, target.timeZone);
    at = zonedInstant(tomorrow.year, tomorrow.month, tomorrow.day, target.hour, target.minute, target.timeZone);
  }
  return new Date(at).toISOString();
}
