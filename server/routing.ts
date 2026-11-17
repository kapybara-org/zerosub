import { accountPeak } from "../shared/format";
import { isAzureAccount, PACE_GATE_PERCENT, type Family, type PaceView, type Usage, type UsageWindow } from "../shared/model";
import { FIVE_HOUR_MINUTES, WEEK_MINUTES } from "./codex";
import {
  accountsOf,
  defaultAccount,
  findAccount,
  mainAccount,
  type Binding,
  type NextAgentPick,
  type StoredAccount,
  type StoredState,
} from "./state";

/** Weekly resets only steer a new agent when every account it could use was read this recently. */
const FRESH_READING_MS = 30 * 60_000;
/** How soon a weekly reset has to be for its account to be preferred. */
const NEAR_RESET_MS = 24 * 60 * 60_000;
/** The most a near-reset account may have used of any window, so it still has room to spare. */
const NEAR_RESET_MAX_USED_PERCENT = 80;
/**
 * An account that has used this much of its 5-hour window is about to run out of it: when spreading
 * new agents, any account under this ranks ahead of every account past it, unless a window that caps
 * it is full (see `mostAvailable`).
 */
const FIVE_HOUR_GATE_PERCENT = PACE_GATE_PERCENT;

const FIVE_HOUR_MS = FIVE_HOUR_MINUTES * 60_000;
const WEEK_MS = WEEK_MINUTES * 60_000;
/** Tunable: how far ahead the 5-hour use is projected. Rests on a low-confidence window size. */
const PACE_HORIZON_MS = 3_600_000;
/** Tunable: a young window's burn rate is measured over at least this long, so a first burst doesn't extrapolate wildly. */
const MIN_FIVE_HOUR_ELAPSED_MS = 1_800_000;
/** Tunable: the least share of the week that counts as elapsed, so a fresh week doesn't inflate the pace. */
const MIN_WEEK_SHARE = 1 / 7;
const UNKNOWN_SCORE = 50;
/** Tunable: 5-hour percent charged for each agent placed on an account since its reading. */
export const PENDING_FIVE_HOUR_PERCENT = 10;
/** Tunable: weekly percent charged for each agent placed on an account since its reading. */
export const PENDING_WEEKLY_PERCENT = 2;
/** How long a placement counts as pending, until a usage reading can show it. */
export const PENDING_MS = 600_000;

export function isLimited(account: StoredAccount, now: number): boolean {
  if (!account.limitedUntil) return false;
  const until = Date.parse(account.limitedUntil);
  return Number.isFinite(until) && until > now;
}

export function isUsable(account: StoredAccount, now: number): boolean {
  return account.signedIn && !account.disabled && !isLimited(account, now);
}

/**
 * Routing may put agents on this account by itself: it's usable and not billed per use. No Pi
 * account is ever picked that way: an added one is an API key, and Pi's own login may be one too,
 * so moving work onto either would move it onto a bill nobody chose.
 */
export function canStandIn(account: StoredAccount, now: number): boolean {
  return account.family !== "pi" && account.auth !== "api" && isUsable(account, now);
}

/**
 * A paid API account that stands in for a subscription (an Azure OpenAI account), marked so when it
 * was added. Like any API account it's billed per use, so routing never puts agents on it by itself
 * unless `paidApiFallback` is on, and then only as a last resort: once no subscription account of the
 * family can stand in (see `mostAvailable`). It can always be picked by hand, or made the default.
 */
export function isLastResort(account: StoredAccount): boolean {
  return isAzureAccount(account);
}

/**
 * Lower is better. Unknown usage ranks in the middle so a known-quiet account wins over a mystery.
 * A full window of one model only, such as "Weekly · Opus", leaves the account its room for the rest.
 * A window whose reset has passed since the reading starts again empty, so an account that just
 * reset ranks by what it has left, not by the full window its last reading showed.
 */
export function headroomScore(usage: Usage | null | undefined, now = Date.now()): number {
  const windows = usage?.windows.map((window) =>
    window.resetsAt && Date.parse(window.resetsAt) <= now ? { ...window, usedPercent: 0 } : window);
  const peak = windows ? accountPeak(windows) : null;
  return peak ? peak.usedPercent : 50;
}

/** The 5-hour window: Codex says how long its windows are, Claude's is known by id. */
export function fiveHourWindow(usage: Usage): UsageWindow | undefined {
  return usage.windows.find((window) => window.minutes === FIVE_HOUR_MINUTES) ??
    usage.windows.find((window) => window.minutes == null && (window.id === "five_hour" || window.id === "primary"));
}

/**
 * Whether the account has used `FIVE_HOUR_GATE_PERCENT` of its 5-hour window, and that window hasn't
 * reset yet. Unknown counts as under the gate.
 */
export function fiveHourGated(usage: Usage | null | undefined, now: number): boolean {
  const short = usage ? fiveHourWindow(usage) : undefined;
  if (!short || !Number.isFinite(short.usedPercent)) return false;
  if (short.resetsAt && Date.parse(short.resetsAt) <= now) return false;
  return short.usedPercent >= FIVE_HOUR_GATE_PERCENT;
}

/** Agents ZeroSub placed on an account that its latest usage reading may not show yet. */
export interface Pacing {
  pendingOf(accountId: string): number;
}

export interface PaceScore {
  /** Projected 5-hour use an hour ahead, plus pending agents. */
  fiveHour: number;
  /** Weekly use against the share of the week that has passed, plus pending agents. */
  weekly: number;
  score: number;
  gated: boolean;
}

export function weeklyWindow(usage: Usage): UsageWindow | undefined {
  return usage.windows.find((window) => window.minutes === WEEK_MINUTES) ??
    usage.windows.find((window) => window.minutes == null && (window.id === "seven_day" || window.id === "secondary"));
}

/** Lower is better. Combines the 5-hour projection and the weekly pace; see the README. */
export function paceScore(usage: Usage | null | undefined, pending: number, now: number): PaceScore {
  const fiveCharge = PENDING_FIVE_HOUR_PERCENT * pending;
  const weekCharge = PENDING_WEEKLY_PERCENT * pending;
  const short = usage ? fiveHourWindow(usage) : undefined;
  const long = usage ? weeklyWindow(usage) : undefined;
  if (!usage || usage.windows.length === 0 || (!short && !long)) {
    const fiveHour = UNKNOWN_SCORE + fiveCharge;
    return { fiveHour, weekly: 0, score: fiveHour, gated: fiveHour >= FIVE_HOUR_GATE_PERCENT };
  }
  const parsed = Date.parse(usage.fetchedAt);
  const fetched = Number.isFinite(parsed) ? Math.min(parsed, now) : now;
  const expired = (window: UsageWindow) => !!window.resetsAt && Date.parse(window.resetsAt) <= now;

  let fiveHour = fiveCharge;
  if (short && Number.isFinite(short.usedPercent) && !expired(short)) {
    const reset = Date.parse(short.resetsAt ?? "");
    if (!Number.isFinite(reset)) fiveHour = short.usedPercent + fiveCharge;
    else {
      const elapsed = Math.max(MIN_FIVE_HOUR_ELAPSED_MS, fetched - (reset - FIVE_HOUR_MS));
      const ahead = Math.min(now + PACE_HORIZON_MS, reset) - fetched;
      fiveHour = short.usedPercent + (short.usedPercent / elapsed) * ahead + fiveCharge;
    }
  }
  let weekly = 0;
  if (long && Number.isFinite(long.usedPercent) && !expired(long)) {
    const reset = Date.parse(long.resetsAt ?? "");
    if (!Number.isFinite(reset)) weekly = long.usedPercent + weekCharge;
    else {
      const share = 1 - (reset - fetched) / WEEK_MS;
      weekly = (long.usedPercent + weekCharge) / Math.min(1, Math.max(MIN_WEEK_SHARE, share));
    }
  }
  return {
    fiveHour,
    weekly,
    score: Math.max(fiveHour, weekly),
    gated: fiveHourGated(usage, now) || fiveHour >= FIVE_HOUR_GATE_PERCENT,
  };
}

/** `paceScore` broken into the parts an account card draws. */
export function paceView(usage: Usage | null | undefined, pending: number, now: number): PaceView {
  const pace = paceScore(usage, pending, now);
  const short = usage ? fiveHourWindow(usage) : undefined;
  const long = usage ? weeklyWindow(usage) : undefined;
  const expired = (window: UsageWindow) => !!window.resetsAt && Date.parse(window.resetsAt) <= now;
  const used = (window: UsageWindow | undefined) =>
    window && Number.isFinite(window.usedPercent) ? (expired(window) ? 0 : window.usedPercent) : null;
  const parsed = usage ? Date.parse(usage.fetchedAt) : Number.NaN;
  const fetched = Number.isFinite(parsed) ? Math.min(parsed, now) : now;
  const weekReset = long?.resetsAt ? Date.parse(long.resetsAt) : Number.NaN;
  const weekElapsed =
    long && Number.isFinite(long.usedPercent) && !expired(long) && Number.isFinite(weekReset)
      ? Math.min(100, Math.max(0, (1 - (weekReset - fetched) / WEEK_MS) * 100))
      : null;
  return {
    fiveHourUsed: used(short),
    fiveHourProjected: pace.fiveHour,
    pendingFiveHour: PENDING_FIVE_HOUR_PERCENT * pending,
    weeklyUsed: used(long),
    pendingWeekly: PENDING_WEEKLY_PERCENT * pending,
    weekElapsed,
    pending,
    gated: pace.gated,
  };
}

/**
 * The usable account with the most room: one under the 5-hour gate before one past it (by peak alone,
 * an account at 81% of its 5 hours beats one at 88% of its week, and runs out minutes later), then
 * the lowest peak, preferring the default, then the CLI login, on ties. An account with a full window
 * that caps it ranks last, gate or not, though it's usable: its limit lifted at the 5-hour reset with
 * its week still full, say, or ChatGPT credits keep it going.
 *
 * With `paidFallback` (the `paidApiFallback` preference), a usable paid API account (`isLastResort`)
 * is chosen once no subscription account can stand in; without it, never.
 */
export function mostAvailable(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
  exclude: ReadonlySet<string> = new Set(),
  paidFallback = false,
  pacing?: Pacing,
): StoredAccount | undefined {
  const preferred = defaultAccount(state, family)?.id;
  const open = accountsOf(state, family).filter((account) => !exclude.has(account.id));
  const subscriptions = open.filter((account) => canStandIn(account, now));
  const candidates =
    subscriptions.length > 0 || !paidFallback ? subscriptions : open.filter((account) => isLastResort(account) && isUsable(account, now));
  const rank = (account: StoredAccount) => {
    const usage = usageOf(account.id);
    const score = headroomScore(usage, now);
    const pace = pacing ? paceScore(usage, pacing.pendingOf(account.id), now) : undefined;
    return [
      score >= 100 ? 2 : (pace ? pace.gated : fiveHourGated(usage, now)) ? 1 : 0,
      pace ? pace.score : score,
      account.id === preferred ? 0 : 1,
      account.kind === "main" ? 0 : 1,
      Date.parse(account.createdAt) || 0,
    ];
  };
  candidates.sort((a, b) => {
    const left = rank(a);
    const right = rank(b);
    for (let index = 0; index < left.length; index += 1) {
      const delta = (left[index] ?? 0) - (right[index] ?? 0);
      if (delta !== 0) return delta;
    }
    return 0;
  });
  return candidates[0];
}

/**
 * A subscription account at a usage-window limit (5-hour or weekly) whose latest reading shows a
 * banked reset it can spend right now. With `autoRedeem` on, a new agent opens on it rather than on
 * a paid stand-in: its first turn hits the limit and spends the reset, as it would with paid fallback
 * off. Signed-out, disabled and budget-limited accounts never count, nor does any API account.
 * Preferred: the default, then the CLI login, then the most resets left.
 */
export function withBankedReset(
  state: StoredState,
  family: Family,
  usageOf: (accountId: string) => Usage | null | undefined,
  now: number,
): StoredAccount | undefined {
  const preferred = defaultAccount(state, family)?.id;
  const left = (account: StoredAccount) => usageOf(account.id)?.resets?.available ?? 0;
  return accountsOf(state, family)
    .filter((account) => account.family !== "pi" && account.auth !== "api" && !isLastResort(account) &&
      account.signedIn && !account.disabled && account.limitKind === "window" && isLimited(account, now))
    .filter((account) => {
      const resets = usageOf(account.id)?.resets;
      return !!resets && resets.available > 0 && resets.usableNow;
    })
    .sort((a, b) =>
      (a.id === preferred ? 0 : 1) - (b.id === preferred ? 0 : 1) ||
      (a.kind === "main" ? 0 : 1) - (b.kind === "main" ? 0 : 1) ||
      left(b) - left(a))[0];
}

/** Prefer a weekly reset within a day only when every usable account has fresh, complete usage. */
function soonestWeeklyReset(state: StoredState, family: Family, usageOf: RouteInput["usageOf"], now: number): StoredAccount | undefined {
  // An API account has no plan windows, and is never preferred for a reset coming up.
  const candidates = accountsOf(state, family).filter((account) => isUsable(account, now) && account.auth !== "api");
  const readings = candidates.map((account) => ({ account, usage: usageOf(account.id) }));
  const complete = readings.every(({ usage }) => {
    if (!usage || usage.error || usage.cached) return false;
    const age = now - Date.parse(usage.fetchedAt);
    const short = usage.windows.find((window) => window.minutes === FIVE_HOUR_MINUTES);
    const weekly = usage.windows.find((window) => window.minutes === WEEK_MINUTES);
    return Number.isFinite(age) && age >= 0 && age <= FRESH_READING_MS && !!short && !!weekly &&
      [short, weekly].every((window) => Number.isFinite(window.usedPercent) && window.usedPercent >= 0 &&
        window.usedPercent <= 100 && window.resetsAt !== null && Date.parse(window.resetsAt) > now);
  });
  if (!complete) return undefined;
  return readings.filter(({ usage }) => {
    const weekly = usage!.windows.find((window) => window.minutes === WEEK_MINUTES)!;
    return usage!.windows.every((window) => window.usedPercent <= NEAR_RESET_MAX_USED_PERCENT) &&
      Date.parse(weekly.resetsAt!) - now <= NEAR_RESET_MS;
  }).sort((a, b) => Date.parse(a.usage!.windows.find((window) => window.minutes === WEEK_MINUTES)!.resetsAt!) -
    Date.parse(b.usage!.windows.find((window) => window.minutes === WEEK_MINUTES)!.resetsAt!))[0]?.account;
}

export interface RouteInput {
  agentId: string;
  family: Family;
  reason: "create" | "resume" | "refresh" | "import";
  now: number;
  autoSwitch: boolean;
  balanceNewAgents: boolean;
  /**
   * Whether an existing conversation can open on a different account. When it can't (Codex), a
   * thread stays on the account it started on, and only brand-new agents are balanced or rerouted.
   */
  portable: boolean;
  usageOf(accountId: string): Usage | null | undefined;
  /**
   * The account the agent's session runs on now. When the account it's routed to has to be skipped
   * and this one can stand in, the agent stays on it rather than following whichever account ranks
   * first at the moment, which would move it again each time two accounts swap places.
   */
  current?: string;
  /** A paid API account may stand in once every subscription account is out (`paidApiFallback`). */
  paidFallback?: boolean;
  /**
   * Banked resets are spent when every account is out (`autoRedeem`). With it, a new agent opens on a
   * limited subscription with a usable reset before a paid stand-in (see `withBankedReset`).
   */
  autoRedeem?: boolean;
  /**
   * The account named for this agent when it was created (`ACCOUNT_METADATA_KEY` in its metadata):
   * chosen in its composer before it existed. Only a new agent without an account takes it.
   */
  requested?: string;
  /**
   * Whether this session may take the one-time "next new agent" pick: one the user's own agents
   * open, not Paseo's helpers (see `takesNextPick` in service.ts). Only a new agent takes it.
   */
  allowNextPick?: boolean;
  /** Agents recently placed on an account; only read while `balanceNewAgents` is on. */
  pendingOf?(accountId: string): number;
}

export interface RouteDecision {
  account: StoredAccount;
  /** A binding to persist so the agent stays where it was routed. */
  bind: Binding | null;
  /** Why the preferred account was skipped, if it was. */
  skipped: { account: StoredAccount; why: "limited" | "signed_out" | "disabled" } | null;
  /**
   * The "next new agent" pick routing looked at, to be cleared: it's spent whether the agent starts
   * on its account or that account couldn't take it.
   */
  nextPick?: NextAgentPick;
}

/**
 * Which account a session opens on: the agent's own binding, else (for a new agent) the account
 * named for it or the one-time pick, else (for balanced new agents) the
 * roomiest account, else the default (the CLI login for an existing Codex thread ZeroSub never
 * routed). An exhausted or signed-out choice is swapped for the roomiest usable account when
 * automatic switching is on — for new agents always, and for existing ones only when their
 * conversation can move between accounts. A disabled choice is always swapped,
 * and the agent keeps its own binding so it returns once the account is enabled again. An agent
 * already running on a usable stand-in keeps it (see `RouteInput.current`).
 */
export function chooseAccount(state: StoredState, input: RouteInput): RouteDecision | null {
  const accounts = accountsOf(state, input.family);
  if (accounts.length === 0) return null;
  const at = new Date(input.now).toISOString();
  const fresh = input.reason === "create";
  const pacing: Pacing | undefined = input.balanceNewAgents
    ? { pendingOf: (id) => input.pendingOf?.(id) ?? 0 }
    : undefined;

  const binding = state.bindings[input.agentId];
  const bound = findAccount(state, binding?.accountId);
  let account = bound && bound.family === input.family ? bound : undefined;
  let bind: Binding | null = null;

  // The account named for this very agent outranks the pick, which waits for an agent that names
  // none. One that can't take the agent is passed over, and the agent routes as usual.
  const takes = (candidate: StoredAccount | undefined): candidate is StoredAccount =>
    candidate?.family === input.family && candidate.signedIn && !candidate.disabled && !(input.autoSwitch && isLimited(candidate, input.now));
  const requested = !account && fresh ? findAccount(state, input.requested) : undefined;
  if (takes(requested)) {
    account = requested;
    bind = { accountId: requested.id, source: "user", at };
  }

  // A pick whose account can't take the agent (at its limit, signed out, disabled, removed) is spent
  // all the same, and the agent routes as usual: kept, it would send every new agent to whichever
  // account stands in for its own until it expires.
  const nextPick = !account && fresh && input.allowNextPick ? (state.nextAgent?.[input.family] ?? undefined) : undefined;
  if (nextPick && Date.parse(nextPick.until) > input.now) {
    const picked = findAccount(state, nextPick.accountId);
    if (takes(picked)) {
      account = picked;
      bind = { accountId: picked.id, source: "user", at };
    }
  }
  if (!account && fresh && input.balanceNewAgents && accounts.length > 1) {
    const nearReset = input.family === "codex" ? soonestWeeklyReset(state, input.family, input.usageOf, input.now) : undefined;
    account = nearReset ?? mostAvailable(state, input.family, input.usageOf, input.now, new Set(), input.paidFallback, pacing);
    // A banked reset is free, so it goes before a paid stand-in, as it does when a turn hits a limit.
    if (account && isLastResort(account) && input.autoRedeem) {
      account = withBankedReset(state, input.family, input.usageOf, input.now) ?? account;
    }
    if (account) bind = { accountId: account.id, source: "balance", at, selectionReason: nearReset ? "weekly_reset" : "headroom" };
  }
  if (!account) {
    // An existing Codex thread ZeroSub never routed (imported from the user's own CLI, or started
    // while ZeroSub was off) ran on the CLI login, so it belongs to that login: on any other account
    // its encrypted reasoning can't be read. Only a brand-new agent follows the default.
    const unrouted = !input.portable && !fresh && !state.sessions[input.agentId] ? mainAccount(state, input.family) : undefined;
    account = unrouted ?? defaultAccount(state, input.family);
    // A thread that can't move is pinned to the account it first opened on.
    if (account && !input.portable) bind = { accountId: account.id, source: "thread", at };
  }
  if (!account) return null;

  let skipped: RouteDecision["skipped"] = null;
  const why = !account.signedIn ? "signed_out" : account.disabled ? "disabled" : isLimited(account, input.now) ? "limited" : null;
  const mayMove = fresh || input.portable;
  if (why && mayMove && (input.autoSwitch || why !== "limited")) {
    const staying = findAccount(state, input.current);
    // A paid stand-in is only kept while no subscription account could take over from it.
    const keeps = (stand: StoredAccount) =>
      !isLastResort(stand) || !accountsOf(state, input.family).some((other) => other.id !== account!.id && canStandIn(other, input.now));
    let alternative =
      staying && staying.family === input.family && staying.id !== account.id && isUsable(staying, input.now) && keeps(staying)
        ? staying
        : mostAvailable(state, input.family, input.usageOf, input.now, new Set([account.id]), input.paidFallback, pacing);
    // Before a paid stand-in, a limited subscription with a usable banked reset: the account itself
    // (it stays, and its first turn spends the reset) or another one.
    if (alternative && isLastResort(alternative) && input.autoRedeem) {
      const banked = withBankedReset(state, input.family, input.usageOf, input.now);
      if (banked) alternative = banked.id === account.id ? undefined : banked;
    }
    if (alternative) {
      skipped = { account, why };
      account = alternative;
      // A thread that can't move lives where it starts. Otherwise a disabled account keeps its
      // agents' bindings, so they return when it's enabled again; a limit re-pins them.
      bind =
        !input.portable
          ? { accountId: alternative.id, source: "thread", at }
          : why === "disabled"
            ? null
            : { accountId: alternative.id, source: "auto", at };
    }
  }
  return { account, bind, skipped, nextPick };
}

/** The account an agent is routed to right now, without side effects (for display). */
export function effectiveAccountId(state: StoredState, agentId: string, family: Family): string | undefined {
  const bound = findAccount(state, state.bindings[agentId]?.accountId);
  if (bound && bound.family === family) return bound.id;
  return defaultAccount(state, family)?.id;
}
