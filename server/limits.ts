import type { AgentTimelineItem, LimitHit, LimitKind, TurnEvent } from "./adapter";
import { isTurnPrompt } from "./handoff";

/**
 * Claude Code's exact wording for hard limits (2.1.x templates: `You've hit your ${limit}${suffix}`),
 * plus the legacy `Claude AI usage limit reached|<epoch>`. Each must be followed by the CLI's own
 * separator (" · …", ".") or end the line, so prose like "You've hit your GitHub API rate limit"
 * never matches. Warnings ("You've used 80%…") and capacity 429s ("…not your usage limit") are
 * deliberately absent: switching accounts doesn't help with those. Claude Code 2.1.312 renamed the
 * session limit the "5-hour limit"; older builds still print "session limit". A plain "usage limit"
 * is a budget: Claude Code prints it for an org on usage-based billing, and as its fallback when the
 * API names no window it knows. Usage readings show neither.
 */
const END = String.raw`(?=\s*(?:·|\.|$))`;
const APOSTROPHE = "['’]";
const CLAUDE_LIMITS: ReadonlyArray<{ pattern: RegExp; kind: LimitKind }> = [
  { pattern: new RegExp(`^You${APOSTROPHE}ve hit your (?:5-hour |session |weekly |Opus |Sonnet |Fable )?limit${END}`, "i"), kind: "window" },
  { pattern: new RegExp(`^You${APOSTROPHE}ve reached your (?:Fable|Opus|Sonnet|Haiku)(?: [\\w.]{1,10})? limit${END}`), kind: "window" },
  { pattern: /Claude AI usage limit reached\|\d{9,}/, kind: "window" },
  {
    pattern: new RegExp(
      `^You${APOSTROPHE}ve hit your (?:usage limit|usage credit limit|team${APOSTROPHE}s shared budget|(?:monthly|individual) spend limit|individual usage limit|(?:org|channel)${APOSTROPHE}s monthly (?:usage|spend) limit)${END}`,
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

/**
 * Anthropic refusing the key a Pi account sends (`401 {"type":"error","error":{"type":"authentication_error",
 * "message":"invalid x-api-key"}}`). Other providers' refusals word it otherwise, so a model of
 * another provider failing on the account doesn't mark its Anthropic key as refused.
 */
const PI_SIGNED_OUT = /"type"\s*:\s*"authentication_error"|invalid x-api-key/i;

const SYSTEM_ERROR = /^\[System Error\]\s*/;
const MAX_NOTICE = 400;

function clean(text: string): string {
  return text.replace(SYSTEM_ERROR, "").replace(/^API Error:\s*/i, "").trim();
}

/**
 * A turn's rows in a page of the agent's timeline (oldest first), to read as that turn. Paseo 0.13
 * tags each row of a live turn with the turn's id, but providers count turns per session, so an
 * earlier turn can carry the same id. Reading back from the turn's last row, another turn's prompt
 * is where this one began. Rows of other turns, and rows without an id, are left out.
 */
export function turnRows(entries: ReadonlyArray<{ item: AgentTimelineItem; turnId?: string }>, turnId: string): AgentTimelineItem[] {
  const rows: AgentTimelineItem[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.turnId === turnId) rows.push(entry.item);
    else if (rows.length > 0 && entry.turnId && isTurnPrompt(entry.item)) break;
  }
  return rows.reverse();
}

/**
 * Where a CLI-generated notice can appear in a finished turn: the failure message, error items,
 * Paseo's `[System Error]` rows, and — for Claude, which reports limits as a synthetic reply — the
 * final assistant messages. Ordinary replies earlier in the turn are never inspected. A turn that
 * failed before it started has only its failure: Paseo never recorded its message, so the timeline
 * still ends with the previous turn.
 */
function notices(event: TurnEvent, includeFinalReplies: boolean): string[] {
  const found: string[] = [];
  if (event.outcome.kind === "failed") found.push(event.outcome.error.message);
  const timeline = event.turnId === null ? [] : event.timeline;
  let replies = 0;
  for (let index = timeline.length - 1; index >= 0; index -= 1) {
    const item = timeline[index];
    if (!item) continue;
    if (isTurnPrompt(item)) break;
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

/** The model a Claude limit notice names ("hit your Fable limit", "reached your Fable 5.2 limit"), lowercase. */
const CLAUDE_SCOPE = new RegExp(`^You${APOSTROPHE}ve (?:hit|reached) your (Opus|Sonnet|Fable|Haiku)\\b`, "i");

export function detectClaudeLimit(event: TurnEvent, now: Date = new Date()): LimitHit | null {
  for (const text of notices(event, true)) {
    const line = firstLine(text);
    const match = CLAUDE_LIMITS.find(({ pattern }) => pattern.test(line));
    if (match) {
      const scope = match.kind === "window" ? (line.match(CLAUDE_SCOPE)?.[1]?.toLowerCase() ?? null) : null;
      return { message: line, kind: match.kind, resetsAt: parseClaudeReset(line, now), scope };
    }
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

/** A Pi turn that failed because Anthropic refused the account's key. */
export function detectPiSignOut(event: TurnEvent): string | null {
  for (const text of notices(event, false)) if (PI_SIGNED_OUT.test(text)) return firstLine(text);
  return null;
}

export function detectCodexSignOut(event: TurnEvent): string | null {
  for (const text of notices(event, false)) if (CODEX_SIGNED_OUT.test(text)) return firstLine(text);
  return null;
}

// --------------------------------------------------------------------------- Azure OpenAI (API key)

/** How long an Azure account is set aside after a rate limit (HTTP 429) without a "retry after". */
export const AZURE_RATE_LIMIT_MS = 60_000;
/** How long after an exhausted quota or spend limit (`insufficient_quota`), which doesn't lift in seconds. */
export const AZURE_QUOTA_MS = 30 * 60_000;
const AZURE_RATE_LIMIT_MAX_MS = 10 * 60_000;

/** Codex's words for an exhausted API quota (`CodexErr::QuotaExceeded`) and the raw error code. */
const AZURE_QUOTA = /insufficient_quota|quota exceeded|exceeded your current quota/i;
/** A rate limit, as Codex reports a 429 after its retries ("exceeded retry limit, last status: 429 …") or Azure words it. */
const AZURE_RATE_LIMIT = /\b429\b|too many requests|rate[ _-]?limit(?:ed|_exceeded)?\b|exceeded (?:the )?(?:token )?rate limit/i;
/** Azure refusing the key (or the endpoint refusing it): 401/403, or Azure's own wording. */
const AZURE_REFUSED =
  /\b401\b|\b403\b|unauthorized|forbidden|invalid subscription key|access denied due to invalid|invalid api key|incorrect api key/i;

/** "Please retry after 20 seconds" / "retry-after: 20", as Azure's 429 bodies say it. */
function azureRetryAfterMs(text: string): number | null {
  const match = text.match(/retry[ -]after:?\s*(\d{1,5})\s*(?:s\b|sec|second)?/i);
  if (!match?.[1]) return null;
  return Math.min(AZURE_RATE_LIMIT_MAX_MS, Math.max(10_000, Number(match[1]) * 1_000));
}

/**
 * A turn on an Azure OpenAI account that failed on the API's quota or rate limit. Azure has no 5-hour
 * or weekly windows, so either one is a short cooldown (`window` for a rate limit, `budget` for an
 * exhausted quota), after which the account counts as available again: failover moves on, or stops,
 * without coming straight back to it.
 *
 * Only a failed turn is read: these patterns are broad (a status code), and a completed turn's
 * warnings can carry another service's, like an MCP server's "HTTP 429" while it starts.
 */
export function detectAzureLimit(event: TurnEvent, now: Date = new Date()): LimitHit | null {
  if (event.outcome.kind !== "failed") return null;
  for (const text of notices(event, false)) {
    if (AZURE_QUOTA.test(text)) {
      return { kind: "budget", message: firstLine(text), resetsAt: new Date(now.getTime() + AZURE_QUOTA_MS).toISOString() };
    }
    if (AZURE_RATE_LIMIT.test(text)) {
      const wait = azureRetryAfterMs(text) ?? AZURE_RATE_LIMIT_MS;
      return { kind: "window", message: firstLine(text), resetsAt: new Date(now.getTime() + wait).toISOString() };
    }
  }
  return null;
}

/**
 * A failed turn on an Azure OpenAI account that looks like its key (or endpoint) was refused. Only a
 * hint, as for `detectAzureLimit`: a 401 or 403 in the turn can still be another service's, so the
 * service asks Azure about the key before taking the account for signed out (see `confirmSignedOut`).
 */
export function detectAzureSignOut(event: TurnEvent): string | null {
  if (event.outcome.kind !== "failed") return null;
  for (const text of notices(event, false)) if (AZURE_REFUSED.test(text) && !AZURE_RATE_LIMIT.test(text)) return firstLine(text);
  return null;
}

// --------------------------------------------------------------------------- AWS Bedrock (Claude on AWS)

/** How long a Bedrock account is set aside after throttling (`ThrottlingException`, 429, "Too many tokens"). */
export const BEDROCK_THROTTLE_MS = 60_000;
/** How long after an exceeded service quota, which usually lifts within minutes. */
export const BEDROCK_QUOTA_MS = 5 * 60_000;

const BEDROCK_QUOTA = /ServiceQuotaExceeded|service quota|quota exceeded/i;
const BEDROCK_THROTTLED = /ThrottlingException|Too many (?:tokens|requests)|\b429\b|rate (?:exceeded|limit)/i;
/**
 * Bedrock naming the model as one the account can't use: not enabled for it ("You don't have access
 * to the model with the specified model ID"), a wrong ID ("The provided model identifier is invalid")
 * or one that needs an inference profile. AWS's own wording, which no other service in a turn prints,
 * so the account is marked without asking AWS about its credentials again.
 */
const BEDROCK_MODEL_REFUSED =
  /don['’]t have access to the model with the specified model ID|provided model identifier is invalid|Invocation of model ID .{1,200} with on-demand throughput isn['’]t supported/i;
/**
 * Credentials or access refused. Only a hint: an AccessDenied or a 403 can be another service's (an
 * MCP server's, a tool's), so the service asks AWS about the credentials before taking the account
 * for signed out (see `confirmSignedOut`).
 */
const BEDROCK_REFUSED =
  /AccessDeniedException|not authorized to perform|UnrecognizedClientException|InvalidSignatureException|security token included in the request is (?:invalid|expired)|ExpiredToken|Could not load credentials|Unable to locate credentials|\b40[13]\b/i;
/** How Claude Code words an API failure in its reply: "API Error: 429 …", "API Error (model): 400 …". */
const API_ERROR = /^(?:\[System Error\]\s*)?API Error\b/i;

/**
 * Notices from a turn on Bedrock. A failed turn gives its failure and error rows. Either kind gives
 * Claude Code's own error replies: of the turn's last two replies (the window main's Claude detectors
 * read, see `notices`), those that start "API Error", as Claude Code words an API failure. Paseo before
 * 0.16 reports such a turn as completed, so a completed turn is read for them too. Nothing else in a
 * completed turn counts: its warnings and error rows (an MCP server's "HTTP 401 Unauthorized" while it
 * starts, an AccessDenied in a tool's output) are other services', and an ordinary reply that only
 * mentions a 429 isn't an error at all.
 */
function apiNotices(event: TurnEvent): string[] {
  const found = event.outcome.kind === "failed" ? notices(event, false) : [];
  const timeline = event.turnId === null ? [] : event.timeline;
  let replies = 0;
  for (let index = timeline.length - 1; index >= 0 && replies < 2; index -= 1) {
    const item = timeline[index];
    if (!item) continue;
    if (isTurnPrompt(item)) break;
    if (item.type !== "assistant_message") continue;
    replies += 1;
    if (API_ERROR.test(item.text)) found.push(clean(item.text));
  }
  return found.filter((text) => text.length > 0 && text.length <= MAX_NOTICE);
}

/**
 * A turn on an AWS Bedrock account that failed throttled or over a service quota (see `apiNotices`). Bedrock has no 5-hour
 * or weekly windows, so either is a short cooldown, as for Azure (see `detectAzureLimit`).
 */
export function detectBedrockLimit(event: TurnEvent, now: Date = new Date()): LimitHit | null {
  for (const text of apiNotices(event)) {
    if (BEDROCK_QUOTA.test(text)) return { kind: "budget", message: firstLine(text), resetsAt: new Date(now.getTime() + BEDROCK_QUOTA_MS).toISOString() };
    if (BEDROCK_THROTTLED.test(text)) return { kind: "window", message: firstLine(text), resetsAt: new Date(now.getTime() + BEDROCK_THROTTLE_MS).toISOString() };
  }
  return null;
}

/**
 * A turn on an AWS Bedrock account that failed because its credentials, access or model were refused
 * (see `apiNotices`): what AWS said, and whether it named the model (`model`), which needs no check of
 * the credentials.
 */
export function detectBedrockRefusal(event: TurnEvent): { message: string; model: boolean } | null {
  const texts = apiNotices(event).filter((text) => !BEDROCK_THROTTLED.test(text) && !BEDROCK_QUOTA.test(text));
  for (const text of texts) if (BEDROCK_MODEL_REFUSED.test(text)) return { message: firstLine(text), model: true };
  for (const text of texts) if (BEDROCK_REFUSED.test(text)) return { message: firstLine(text), model: false };
  return null;
}

/**
 * Claude Code's own words when the model it was asked for isn't offered in the account's region: "The
 * model eu.anthropic.claude-sonnet-4-5-20250929-v1:0 is not available on your bedrock deployment. Try
 * --model to switch to …". It says so for a model alias (`sonnet`) whose built-in Bedrock default is
 * older than what the region has, so only that model is out, not the account.
 */
const BEDROCK_MODEL_UNAVAILABLE = /^The model (\S{1,200}) is not available on your bedrock deployment\b/i;

/**
 * A turn on an AWS Bedrock account whose model Claude Code found missing in the account's region (see
 * `BEDROCK_MODEL_UNAVAILABLE`), and the model it named. Read like main's Claude notices: the failure,
 * error rows and the last two replies, of a failed or completed turn. The wording is Claude Code's
 * own, anchored at the start, so no other service's message or ordinary reply matches.
 */
export function detectBedrockModelUnavailable(event: TurnEvent): { message: string; model: string } | null {
  for (const text of notices(event, true)) {
    const line = firstLine(text);
    const match = line.match(BEDROCK_MODEL_UNAVAILABLE);
    if (match?.[1]) return { message: line, model: match[1] };
  }
  return null;
}

/** Paseo refusing to start a turn in Claude's Auto mode where Claude Code runs on Bedrock (`CLAUDE_CODE_USE_BEDROCK`). */
const BEDROCK_AUTO_MODE = /Claude Auto mode requires the Anthropic API/i;

/**
 * A turn on an AWS Bedrock account Paseo wouldn't start because the agent is in Claude's Auto mode,
 * which needs the Anthropic API: Paseo's message. Read like main's Claude notices (the failure, error
 * rows and the last two replies, of a failed or completed turn); the wording is Paseo's own.
 */
export function detectBedrockAutoModeRefusal(event: TurnEvent): string | null {
  for (const text of notices(event, true)) if (BEDROCK_AUTO_MODE.test(text)) return firstLine(text);
  return null;
}

// --------------------------------------------------------------------------- reset times

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * "· resets 3pm (Asia/Kolkata)", "· resets 3:30pm (America/New_York)",
 * "· resets Sep 25, 3pm (Europe/Berlin)" ("Sep 25 at 3pm" where the CLI's ICU is newer), or the
 * legacy "|1790150000" epoch. A reset in the next calendar year also carries the year
 * ("Jan 2, 2027"), which rolling the date forward already gives.
 */
export function parseClaudeReset(text: string, now: Date): string | null {
  const epoch = text.match(/usage limit reached\|(\d{9,})/i);
  if (epoch?.[1]) return new Date(Number(epoch[1]) * 1000).toISOString();
  const match = text.match(
    /resets\s+(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+\d{4})?,?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?(?:\s*\(([^)]+)\))?/i,
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
