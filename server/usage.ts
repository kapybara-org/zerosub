import { join } from "node:path";
import { UsageSchema, type Usage } from "../shared/model";
import type { UsageRead } from "./adapter";
import { readJson, writeJsonAtomic } from "./json-file";
import { dataDir } from "./paths";

/** How close a limit notice's reset time must be to a window's for that window to be the full one. */
const MATCH_MS = 20 * 60_000;

/** How long to wait after the provider asks us to slow down (HTTP 429), from its `Retry-After`. */
export function retryDelayMs(retryAfter: string | null, now: number = Date.now()): number {
  const fallback = 2 * 60_000;
  if (!retryAfter) return fallback;
  const seconds = Number(retryAfter);
  const ms = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(retryAfter) - now;
  if (!Number.isFinite(ms)) return fallback;
  return Math.min(30 * 60_000, Math.max(30_000, ms));
}

/**
 * The reading with the window a limit notice is about shown as full, since the notice is the
 * freshest word on usage there is. That window is the one resetting when the notice says it will;
 * when several do, the fullest one.
 */
export function showLimit(usage: Usage, resetsAt: string | null): Usage {
  const at = resetsAt ? Date.parse(resetsAt) : Number.NaN;
  if (!Number.isFinite(at)) return usage;
  let match = -1;
  for (const [index, window] of usage.windows.entries()) {
    if (!window.resetsAt || Math.abs(Date.parse(window.resetsAt) - at) > MATCH_MS) continue;
    if (match < 0 || window.usedPercent > (usage.windows[match]?.usedPercent ?? 0)) match = index;
  }
  if (match < 0) return usage;
  return {
    ...usage,
    windows: usage.windows.map((window, index) => (index === match ? { ...window, usedPercent: Math.max(100, window.usedPercent) } : window)),
  };
}

/**
 * The reading to show after a refresh. A failed or rate-limited refresh keeps the last windows, and
 * the CLI's own cached copy only replaces a reading it is newer than.
 */
export function mergeUsage(previous: Usage | undefined, next: Usage): Usage {
  if (!previous || previous.windows.length === 0) return next;
  if (next.windows.length === 0) return { ...previous, error: next.error };
  if (next.cached && Date.parse(next.fetchedAt) <= Date.parse(previous.fetchedAt)) return previous;
  return next;
}

/** A reading this old that a refresh couldn't replace says so, rather than passing for current. */
export const STALE_MS = 10 * 60_000;

/**
 * The reading to show after a refresh attempt. When the attempt wasn't a live reading and what's
 * shown is older than `STALE_MS`, the reading keeps its windows but says since when and why.
 */
export function markStale(shown: Usage, attempt: UsageRead, now: number = Date.now()): Usage {
  if (shown.windows.length === 0) return shown;
  if (!attempt.cached && !attempt.error && attempt.windows.length > 0) return shown;
  const at = Date.parse(shown.fetchedAt);
  if (!Number.isFinite(at) || now - at <= STALE_MS) return shown;
  return { ...shown, error: `Stale since ${clock(at)}: ${staleReason(attempt)}` };
}

function staleReason(attempt: UsageRead): string {
  if (attempt.error) return attempt.error;
  if (attempt.retryAt) return `usage reads are rate-limited; retrying after ${clock(attempt.retryAt)}`;
  if (attempt.cached) return "the sign-in needs renewing, so only the CLI's cached copy is available";
  return "no live reading came back";
}

function clock(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

/** A usage report as Paseo's Usage section takes it (`@getpaseo/plugin/server/usage`, Paseo 0.11+). */
export type UsageSourceReport =
  | {
      status: "available";
      planLabel?: string;
      windows: Array<{
        id: string;
        label: string;
        usedPct: number;
        remainingPct: number;
        resetsAt: string | null;
        tone: "ok" | "warning" | "danger";
        summary?: true;
      }>;
      balances: [];
      details: [];
    }
  | { status: "error"; error: string };

/** An account's reading for Paseo's Usage section; one that isn't current is an error there, not a number. */
export function usageReport(usage: Usage | undefined, plan: string | null): UsageSourceReport {
  if (!usage) return { status: "error", error: "ZeroSub has no usage reading for this account yet." };
  if (usage.error) return { status: "error", error: usage.error };
  if (usage.windows.length === 0) return { status: "error", error: "No usage windows came back." };
  return {
    status: "available",
    ...(plan ? { planLabel: plan } : {}),
    windows: usage.windows.map((window, index) => ({
      id: window.id,
      label: window.label,
      usedPct: window.usedPercent,
      remainingPct: Math.max(0, 100 - window.usedPercent),
      resetsAt: window.resetsAt,
      tone: window.usedPercent > 90 ? "danger" : window.usedPercent >= 70 ? "warning" : "ok",
      ...(index < 2 ? { summary: true as const } : {}),
    })),
    balances: [],
    details: [],
  };
}

function usagePath(): string {
  return join(dataDir(), "usage.json");
}

/** Each account's last reading, as `saveReadings` left it, so a reload never blanks the cards. */
export async function loadReadings(): Promise<Map<string, Usage>> {
  const readings = new Map<string, Usage>();
  const saved = await readJson(usagePath()).catch(() => undefined);
  if (!saved || typeof saved !== "object") return readings;
  for (const [accountId, value] of Object.entries(saved)) {
    const parsed = UsageSchema.safeParse(value);
    if (parsed.success) readings.set(accountId, parsed.data);
  }
  return readings;
}

export function saveReadings(readings: ReadonlyMap<string, Usage>): Promise<void> {
  return writeJsonAtomic(usagePath(), Object.fromEntries(readings));
}
