import { formatPercent, formatResetMoment, shortLabel } from "../shared/format";
import { holdsBack, isFull, kindOf, scopeOf, toneOf, windowsWorthReading, type UsageTone, type WindowKind } from "../shared/glance";
import { accountGlyph, type AccountGlyph } from "../shared/glyph";
import type { AccountView, AgentAccounts, AgentRoute, StateView } from "../shared/model";
import { modelClass, modelName, planAccounts, sourceOfView } from "../shared/plan-input";
import { fmtIn, rank, shouldMove, type PlanAccount, type PlanRequest, type Ranked } from "../shared/planner";
import type { ReopenSummary } from "../shared/rpc";

/** The accounts one agent may use, as the panel edits them before they are saved. */
export type AgentDraft = AgentAccounts;

/** One of an account's limits, as a row's details list them. */
export interface AccountWindowLine {
  kind: WindowKind;
  /** "5-hour", "Weekly", "Fable". */
  name: string;
  usedPercent: number;
  tone: UsageTone;
  full: boolean;
  /** When it resets, on the clock: "19:42", "Fri 08:12"; null when not known or passed. */
  resets: string | null;
  /** It holds this agent back; false for another model's limit (Fable's, for an Opus agent). */
  applies: boolean;
}

/** One account in the agent's panel. */
export interface AgentAccountRow {
  id: string;
  label: string;
  checked: boolean;
  /** The agent's session runs on it now. */
  now: boolean;
  glyph: AccountGlyph;
  /** Why it sits where it does, in the planner's words: "46% left · resets in 2d 3h". */
  why: string;
  /** It can't take the agent's next turn (full, or out for its model). */
  full: boolean;
  /** The figure the row shows: the share used of the glyph's window ("45%"), or once full the wait ("2h 28m"). */
  meta: string;
  /** The account's limits still worth reading, in the reading's order: what hovering the row shows. */
  lines: AccountWindowLine[];
  /** Said instead of the limits when there are none to show: "Signed out · sign in from Manage accounts". */
  note: string | null;
}

/**
 * The account's limits, in the order its reading lists them, for an agent running `model`: its own
 * and those of other models (Fable's room weighs in the plan), leaving out the ones a full limit
 * makes moot (the 5-hour beside a full week).
 */
export function windowLines(account: AccountView, model: string | null, now: number = Date.now()): AccountWindowLine[] {
  const usage = account.usage;
  if (!usage) return [];
  return windowsWorthReading(usage.windows, model, now).map((limit) => {
    const kind = kindOf(limit);
    return {
      kind,
      name: kind === "model" ? (scopeOf(limit) ?? limit.label) : limit.label,
      usedPercent: limit.usedPercent,
      tone: toneOf(limit.usedPercent),
      full: isFull(limit),
      resets: formatResetMoment(limit.resetsAt, now),
      applies: holdsBack(limit, model),
    };
  });
}

/** A row's details as one sentence, for screen readers: the reason, then each limit. */
export function spokenDetails(row: Pick<AgentAccountRow, "why" | "lines" | "note">): string {
  const limits = row.lines.map(
    (line) =>
      `${line.applies ? line.name : `${line.name} only`} ${line.full ? "full" : `${formatPercent(line.usedPercent)} used`}${line.resets ? `, resets ${line.resets}` : ""}`,
  );
  return [row.why, ...limits, row.note].filter(Boolean).join(". ");
}

/** The reason as a row's details show it: without "resets in …", which the limits above it already say. */
export function detailReason(why: string): string {
  return why.replace(/(?: ·|,) resets in [^·]+?(?= ·|$)/g, "");
}

/** What a row says instead of its limits when it has none to show. */
export function noteOf(account: AccountView, lines: readonly AccountWindowLine[]): string | null {
  if (account.status === "signed_out") return "Signed out · sign in from Manage accounts";
  if (account.status === "disabled") return "Turned off in Manage accounts";
  return lines.length === 0 ? "No usage reading yet" : null;
}

/** Where the agent's next turn runs, as the panel says it. */
export type NextTurn =
  | { kind: "stay"; on: string; detail: string; quiet?: boolean }
  | { kind: "go"; to: string; detail: string }
  | { kind: "full"; model: string; detail: string; canOverflow: boolean };

export interface AgentPlan {
  /** "Fable 5.2", or null while the model isn't known yet. */
  model: string | null;
  /** "Fable", "Opus": the model in a short phrase ("Smart for Fable"). */
  modelShort: string;
  nowOn: AccountView;
  checked: AgentAccountRow[];
  others: AgentAccountRow[];
  next: NextTurn;
  draft: AgentDraft;
  /** The user picked this agent's accounts (or is picking them now): until then they all count. */
  chosen: boolean;
}

/** Ties keep the plain order: the default first, then the CLI login, then the list's own. */
function tieOrder(accounts: readonly AccountView[]): string[] {
  return accounts
    .map((account, index) => ({ account, index }))
    .sort(
      (a, b) =>
        Number(b.account.isDefault) - Number(a.account.isDefault) ||
        Number(b.account.kind === "main") - Number(a.account.kind === "main") ||
        a.index - b.index,
    )
    .map(({ account }) => account.id);
}

/** The account the agent's session runs on now: still the old one while a switch waits. */
export function runningAccount(accounts: readonly AccountView[], route: AgentRoute | undefined): AccountView | undefined {
  const id = route?.pendingAccountId ?? route?.accountId;
  return accounts.find((account) => account.id === id) ?? accounts.find((account) => account.isDefault) ?? accounts[0];
}

/** The short name of the agent's model for a phrase: "Fable", "Opus"; "this model" when unknown. */
export function modelShortName(model: string | null | undefined): string {
  return modelName(model)?.split(" ")[0] ?? "this model";
}

/**
 * The saved choice, or all accounts checked in the planner's order while there is none. Accounts
 * added since keep their place: unchecked, at the end of a dragged order.
 */
export function draftOf(saved: AgentAccounts | null | undefined, accounts: readonly AccountView[], smartOrder: readonly string[]): AgentDraft {
  const ids = accounts.map((account) => account.id);
  if (!saved) return { pool: [...ids], mode: "smart", order: [...smartOrder], overflow: "wait" };
  const pool = saved.pool.filter((id) => ids.includes(id));
  const order = [...saved.order.filter((id) => ids.includes(id)), ...smartOrder.filter((id) => !saved.order.includes(id))];
  return { pool: pool.length > 0 ? pool : [...ids], mode: saved.mode, order, overflow: saved.overflow };
}

interface Inputs {
  accounts: AccountView[];
  plans: PlanAccount[];
  base: PlanRequest;
  nowOn: AccountView;
}

function inputsOf(state: StateView, route: AgentRoute | undefined, family: string, model: string | null, now: number): Inputs | null {
  const accounts = state.accounts.filter((account) => account.family === family);
  const nowOn = runningAccount(accounts, route);
  if (!nowOn) return null;
  // The agent runs its next turn on its own account: its load counts there, as the server counts it.
  const plans = planAccounts(accounts.map(sourceOfView), model, now).map((plan) => (plan.id === nowOn.id ? { ...plan, load: plan.load + 1 } : plan));
  const plan = state.plan;
  const base: PlanRequest = {
    model: modelClass(model),
    keepFable: plan?.keepFable ?? false,
    paceH: plan?.paceH,
    horizonH: plan ? (plan.horizonH ?? Number.POSITIVE_INFINITY) : undefined,
    prev: tieOrder(accounts),
  };
  return { accounts, plans, base, nowOn };
}

/** The planner's order for the agent with nothing picked yet: what "Smart" starts from. */
export function smartOrder(state: StateView, route: AgentRoute | undefined, family: string, model: string | null, now: number = Date.now()): string[] {
  const inputs = inputsOf(state, route, family, model, now);
  return inputs ? rank(inputs.plans, { ...inputs.base, kind: "move" }).map((row) => row.id) : [];
}

function soonest(rows: readonly Ranked[]): number | null {
  const backs = rows.map((row) => row.back).filter((back) => Number.isFinite(back) && back > 0);
  return backs.length > 0 ? Math.min(...backs) : null;
}

/**
 * What the agent's account panel shows for `draft`: its checked accounts in the order its next
 * turns try them (the planner's, or the one dragged), the others apart, and where the next turn
 * runs. Computed on the screen with the server's own planner and plan, so it says what the server
 * will do; the server decides again from fresh readings when the turn ends.
 */
export function agentPlan(
  state: StateView,
  route: AgentRoute | undefined,
  family: string,
  model: string | null,
  draft: AgentDraft,
  chosen: boolean,
  now: number = Date.now(),
): AgentPlan | null {
  const inputs = inputsOf(state, route, family, model, now);
  if (!inputs) return null;
  const { accounts, plans, base, nowOn } = inputs;
  const pool = draft.pool.filter((id) => accounts.some((account) => account.id === id));
  const inPool = (id: string) => pool.includes(id);
  const manual = draft.mode === "manual" ? draft.order.filter(inPool) : null;
  const request: PlanRequest = { ...base, pool, manual };
  const rows = rank(plans, { ...request, kind: "move", overflow: true });
  const info = new Map(rows.map((row) => [row.id, row]));
  const move = shouldMove({ account: nowOn.id, model: base.model ?? "other" }, plans, { ...request, overflow: draft.overflow === "others" });

  let checkedIds: string[];
  let otherIds: string[];
  if (draft.mode === "manual") {
    checkedIds = [...draft.order.filter(inPool), ...pool.filter((id) => !draft.order.includes(id))];
    otherIds = [...draft.order.filter((id) => !inPool(id)), ...rows.map((row) => row.id).filter((id) => !inPool(id) && !draft.order.includes(id))];
  } else {
    checkedIds = rows.filter((row) => !row.outside).map((row) => row.id);
    otherIds = rows.filter((row) => row.outside).map((row) => row.id);
  }
  // Staying put, the account it stays on leads the list: that is where its next turn goes.
  const stays = !move?.target;
  if (draft.mode === "smart" && stays && checkedIds.includes(nowOn.id)) checkedIds = [nowOn.id, ...checkedIds.filter((id) => id !== nowOn.id)];

  const describe = (id: string, checked: boolean): AgentAccountRow | null => {
    const account = accounts.find((candidate) => candidate.id === id);
    const row = info.get(id);
    if (!account || !row) return null;
    const full = row.tier >= 1;
    // "Use first" only means something among the agent's own accounts.
    const why = checked ? row.why : row.why.replace(/^Use first · /, "");
    const glyph = accountGlyph(account, model, now);
    const off = account.status === "signed_out" ? "Signed out" : account.status === "disabled" ? "Off" : null;
    const back = Number.isFinite(row.back) && row.back > 0 ? fmtIn(row.back) : "";
    const lines = off ? [] : windowLines(account, model, now);
    return {
      id,
      label: shortLabel(account),
      checked,
      now: id === nowOn.id,
      glyph,
      why: full && checked && draft.mode === "manual" ? `Skipped · ${why}` : why,
      full,
      meta: off ?? (full ? back || "Full" : formatPercent(glyph.usedPercent)),
      lines,
      note: noteOf(account, lines),
    };
  };
  const present = <T>(row: T | null): row is T => row !== null;
  const checked = checkedIds.map((id) => describe(id, true)).filter(present);
  const others = otherIds.map((id) => describe(id, false)).filter(present);

  const short = modelShortName(model);
  const label = (id: string) => shortLabel(accounts.find((account) => account.id === id) ?? { label: id });
  let next: NextTurn;
  if (move?.target && (chosen || move.reason === "model" || move.reason === "wall")) {
    const cause = {
      order: "First in your order",
      unchecked: `Leaves ${label(nowOn.id)}, which you unchecked`,
      model: `${short} is full on ${label(nowOn.id)}`,
      wall: `${label(nowOn.id)} is at its limit`,
      "wall-soon": `${label(nowOn.id)} runs out during the next turn`,
    }[move.reason];
    // The cause alone: the planner's own reasoning stays on the row it picked.
    const outside = move.outside ? " · not checked, until one of yours is back" : "";
    next = { kind: "go", to: move.target, detail: cause + outside };
  } else if (move && !move.target && move.reason !== "wall-soon" && chosen) {
    const back = soonest(rows.filter((row) => !row.outside));
    if (move.reason === "unchecked" && draft.overflow === "others") {
      next = { kind: "stay", on: nowOn.id, detail: `None of your checked accounts can take it${back !== null ? ` · back in ${fmtIn(back)}` : ""}` };
    } else {
      next = {
        kind: "full",
        model: short,
        detail: `Waits${back !== null ? ` ${fmtIn(back)}` : ""} and notifies you`,
        canOverflow: draft.overflow === "wait",
      };
    }
  } else if (route?.atWall) {
    next = { kind: "full", model: short, detail: "Waits and notifies you", canOverflow: true };
  } else {
    const here = info.get(nowOn.id);
    const calm = here !== undefined && here.tier === 0;
    next = { kind: "stay", on: nowOn.id, detail: calm ? "Nothing to gain by moving" : (here?.why ?? ""), quiet: calm };
  }

  return { model: modelName(model), modelShort: short, nowOn, checked, others, next, draft: { ...draft, pool }, chosen };
}

/**
 * Whether a row offers "Use now": somewhere else the agent can run its next turn. Not where it runs
 * already, nor a full, signed-out or turned-off account (the planner ranks those last, as full).
 */
export function canUse(row: Pick<AgentAccountRow, "now" | "full">): boolean {
  return !row.now && !row.full;
}

/** What moving the agent to `label` came to, as the panel says it once the server answers. */
export function describeUse(label: string, summary: Pick<ReopenSummary, "reopened" | "deferred" | "failed" | "continuedIn">): string {
  if (summary.continuedIn) return `Continuing in “${summary.continuedIn.title}” on ${label}`;
  if (summary.reopened.length > 0) return `Now on ${label}`;
  if (summary.deferred.length > 0) return `Moves to ${label} once this turn ends`;
  if (summary.failed.length > 0) return `Moves to ${label} when its session restarts`;
  return `Runs on ${label}`;
}

/** Checks or unchecks an account; the last checked one stays. Null: refused. */
export function toggled(draft: AgentDraft, id: string): AgentDraft | null {
  if (draft.pool.includes(id)) {
    if (draft.pool.length <= 1) return null;
    return { ...draft, pool: draft.pool.filter((candidate) => candidate !== id) };
  }
  // Checked again, it comes back after the last checked account in a dragged order.
  const order = draft.order.filter((candidate) => candidate !== id);
  let last = -1;
  order.forEach((candidate, index) => {
    if (draft.pool.includes(candidate)) last = index;
  });
  order.splice(last + 1, 0, id);
  return { ...draft, pool: [...draft.pool, id], order };
}

/** Moves a checked account to `index` among the checked ones, which makes the order the user's. */
export function moved(draft: AgentDraft, shown: readonly string[], id: string, index: number): AgentDraft {
  const checked = shown.filter((candidate) => candidate !== id);
  checked.splice(Math.max(0, Math.min(checked.length, index)), 0, id);
  const rest = draft.order.filter((candidate) => !checked.includes(candidate));
  return { ...draft, mode: "manual", order: [...checked, ...rest] };
}
