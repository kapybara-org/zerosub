import type { AccountView, AgentRoute, Credits, Egress, ExtraUsage, UsageWindow } from "./model";
import type { ReopenSummary } from "./rpc";

/** "in 2h 14m", "in 3d 4h", "now". */
export function formatResetIn(resetsAt: string | null, now: number = Date.now()): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const minutes = Math.round((at - now) / 60_000);
  if (minutes <= 0) return "now";
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0 ? `in ${hours}h` : `in ${hours}h ${rest}m`;
  }
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `in ${days}d` : `in ${days}d ${restHours}h`;
}

export function formatPercent(value: number): string {
  return `${Math.round(Math.min(100, Math.max(0, value)))}%`;
}

/** "57,714 ChatGPT credits left", "Unlimited ChatGPT credits", or "ChatGPT credits available" when the balance isn't given. */
export function formatCredits(credits: Credits): string {
  if (credits.unlimited) return "Unlimited ChatGPT credits";
  if (credits.balance === null) return "ChatGPT credits available";
  // Rounding a last fraction of a credit down would read as none left.
  if (credits.balance < 1) return "Less than 1 ChatGPT credit left";
  const whole = String(Math.floor(credits.balance)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${whole} ChatGPT credit${whole === "1" ? "" : "s"} left`;
}

const CURRENCY_SIGNS: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/** An amount in minor units of `currency` (cents for USD): "$12.34", "1,234.50 CAD". */
function formatMoney(minor: number, currency: string | null): string {
  const [whole, cents] = (Math.max(0, minor) / 100).toFixed(2).split(".") as [string, string];
  const amount = `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${cents}`;
  const sign = currency ? CURRENCY_SIGNS[currency.toUpperCase()] : undefined;
  if (sign) return `${sign}${amount}`;
  return currency ? `${amount} ${currency.toUpperCase()}` : amount;
}

/**
 * "Extra usage on · $12.34 of $50.00 this month", "Extra usage on · $12.34 spent this month", or
 * "Extra usage on" when the spend isn't known. `null` when it's off: nothing to show then.
 */
export function formatExtraUsage(extra: ExtraUsage): string | null {
  if (!extra.enabled) return null;
  if (extra.spend === null) return "Extra usage on";
  const spent = formatMoney(extra.spend, extra.currency);
  return extra.limit === null
    ? `Extra usage on · ${spent} spent this month`
    : `Extra usage on · ${spent} of ${formatMoney(extra.limit, extra.currency)} this month`;
}

/** Claude's 5-hour and weekly windows, and Codex's two (see `parseUsage`, `parseRateLimits`). */
const ACCOUNT_WINDOWS = new Set(["five_hour", "seven_day", "primary", "secondary"]);

/**
 * Whether a full window stops the whole account. The others only cap one model or surface, such as
 * Claude's "Weekly · Opus": the account still works with the rest, and a turn that does hit one
 * says so itself. Windows ZeroSub doesn't know count as the narrower kind.
 */
export function capsAccount(window: UsageWindow): boolean {
  return ACCOUNT_WINDOWS.has(window.id);
}

/** The busiest window that caps the whole account: how much room it has left for any model. */
export function accountPeak(windows: readonly UsageWindow[]): UsageWindow | null {
  return peakUsage(windows.filter(capsAccount));
}

/** The busiest of `windows`, whatever it caps. */
export function peakUsage(windows: readonly UsageWindow[]): UsageWindow | null {
  let peak: UsageWindow | null = null;
  for (const limit of windows) {
    if (!peak || limit.usedPercent > peak.usedPercent) peak = limit;
  }
  return peak;
}

const PLAN_LABELS: Record<string, string> = {
  max: "Max",
  pro: "Pro",
  prolite: "Pro Lite",
  team: "Team",
  enterprise: "Enterprise",
  plus: "Plus",
  go: "Go",
  business: "Business",
  self_serve_business_prolite: "Business",
  self_serve_business_usage_based: "Business",
  enterprise_cbp_automation: "Enterprise",
  enterprise_cbp_usage_based: "Enterprise",
  ent26: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
  free: "Free",
};

export function formatPlan(plan: string | null): string | null {
  if (!plan) return null;
  const key = plan.toLowerCase();
  return PLAN_LABELS[key] ?? plan.charAt(0).toUpperCase() + plan.slice(1);
}

/** Short name for a composer pill: the nickname, trimmed to fit. */
export function shortLabel(account: Pick<AccountView, "label">, max = 18): string {
  const label = account.label.trim();
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

const MOVES_WHEN: Record<NonNullable<AgentRoute["waiting"]>, string> = {
  idle: "once it's idle",
  turn: "when its current turn ends",
  background: "once the background work it left running stops",
  restart: "when its session next starts",
};

/**
 * A composer pill's label and tooltip for an agent routed to `account`. While its session still
 * runs on another account, both are named, so the pill never claims an account the agent isn't
 * using yet, and the tooltip says when the move happens.
 */
export function pillText(
  account: Pick<AccountView, "label" | "email">,
  running: Pick<AccountView, "label"> | null,
  waiting: AgentRoute["waiting"],
): { label: string; title: string } {
  const named = `${account.label}${account.email && account.email !== account.label ? ` (${account.email})` : ""}`;
  if (!running) return { label: shortLabel(account), title: `Account: ${named}` };
  return {
    label: `${shortLabel(running, 12)} → ${shortLabel(account, 12)}`,
    title: `Account: ${running.label}, moving to ${named} ${MOVES_WHEN[waiting ?? "idle"]}`,
  };
}

/** What moving agents came to, after `prefix`: "work is now the default · 2 agent(s) switched · …". */
export function describeReopen(prefix: string, summary: ReopenSummary): string {
  const parts = [prefix];
  if (summary.continuedIn) parts.push(`continuing in “${summary.continuedIn.title}”`);
  if (summary.reopened.length > 0) parts.push(`${summary.reopened.length} agent(s) switched`);
  if (summary.pending.length > 0) parts.push(`${summary.pending.length} still switching (their timelines will say when)`);
  if (summary.deferred.length > 0) parts.push(`${summary.deferred.length} will switch after their current turn`);
  if (summary.failed.length > 0) parts.push(`${summary.failed.length} couldn't be reloaded and will switch when their session next starts`);
  return parts.join(" · ");
}

/** Why moving one agent to `to` didn't happen now, for its account button and `/account`; null when it did or will by itself. */
export function moveProblem(summary: ReopenSummary, to: string): string | null {
  const failed = summary.failed[0];
  if (!failed) return null;
  return `Couldn't reload this agent onto ${to} (${failed.error.replace(/\.$/, "")}), so it moves when its session next starts.`;
}

/** Why an agent can't be moved onto an account at its limit while automatic switching is on. */
export function limitedPick(label: string): string {
  return `${label} is at its limit, and with automatic switching on the agent would move straight off it again. Pick another account, or mark ${label} as available again on its card in Accounts if it has room.`;
}

/** One line summarising an account's headroom, e.g. "42% of 5-hour used · resets in 2h". */
/**
 * The line under an account's name: its email, plus its organization when that adds something.
 * Claude names a personal organization after its owner ("…'s Organization"), which only repeats it.
 */
export function accountSubtitle(account: Pick<AccountView, "email" | "organization">): string | null {
  const organization = account.organization?.trim() || null;
  const telling =
    organization && organization.toLowerCase() !== account.email?.toLowerCase() && !/'s organi[sz]ation$/i.test(organization)
      ? organization
      : null;
  return [account.email, telling].filter(Boolean).join(" · ") || null;
}

/** "just now", "6m ago", "3h ago", "2d ago". */
export function formatAge(at: string, now: number = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

/** How old an address may get before it says so: checks run every half hour. */
const EGRESS_FRESH_MS = 60 * 60_000;

/** "IP: 203.0.113.7 (US)", with its age once that's an hour; null before the first check. */
export function egressText(egress: Egress | null, now: number = Date.now()): string | null {
  if (!egress) return null;
  if (!egress.ip) return egress.error ? "IP: couldn't check" : null;
  const old = egress.checkedAt && now - Date.parse(egress.checkedAt) >= EGRESS_FRESH_MS ? formatAge(egress.checkedAt, now) : null;
  const notes = [egress.country, old].filter(Boolean).join(", ");
  return `IP: ${egress.ip}${notes ? ` (${notes})` : ""}`;
}

export function usageSummary(account: AccountView, now: number = Date.now()): string | null {
  if (account.status === "disabled") return "Disabled for now";
  if (account.status === "limited") {
    const reset = formatResetIn(account.limitedUntil, now);
    return reset ? `Limit reached · resets ${reset}` : "Limit reached";
  }
  const peak = account.usage ? peakUsage(account.usage.windows) : null;
  if (!peak) return null;
  const reset = formatResetIn(peak.resetsAt, now);
  const base = `${formatPercent(peak.usedPercent)} of ${peak.label.toLowerCase()} used`;
  return reset ? `${base} · resets ${reset}` : base;
}

/** The note over state the daemon stopped answering for: "Showing data from 3m ago · couldn't refresh: …". */
export function staleNotice(updatedAt: number | null, error: string, now: number = Date.now()): string {
  if (updatedAt === null) return `Couldn't refresh: ${error}`;
  const age = formatAge(new Date(updatedAt).toISOString(), now);
  return `Showing data from ${age === "just now" ? "a moment ago" : age} · couldn't refresh: ${error}`;
}
