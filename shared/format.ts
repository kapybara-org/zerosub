import type { AccountView, UsageWindow } from "./model";

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

/** The busiest window decides how close an account is to being cut off. */
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
