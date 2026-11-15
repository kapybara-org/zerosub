import { formatCountdown, formatPercent, shortLabel } from "../shared/format";
import { accountRing, accountRoom, holdsBack, isFull, type AccountRing } from "../shared/glance";
import { accountGlyph, type AccountGlyph } from "../shared/glyph";
import type { AccountView, StateView } from "../shared/model";
import { limitHolds } from "../shared/plan-input";
import { noteOf, windowLines, type AccountWindowLine } from "./agent-plan";

/** An agent as the pills follow it. */
export interface TrackedAgent {
  id: string;
  workspaceId: string;
  provider: string;
  /** The model it runs, as resolved by the provider when known ("claude-fable-5-2"). */
  model: string | null;
}

/** The account an agent runs on, as its account pill shows it: its route, else the default, else the first. */
export function accountOf(state: StateView, agent: Pick<TrackedAgent, "id" | "provider">): AccountView | null {
  const family = state.providers[agent.provider];
  if (!family) return null;
  const accounts = state.accounts.filter((account) => account.family === family);
  const route = state.agents.find((entry) => entry.agentId === agent.id);
  return (
    accounts.find((account) => account.id === route?.accountId) ??
    accounts.find((account) => account.isDefault) ??
    accounts[0] ??
    null
  );
}

/** The option of the start-screen picker that opens the Accounts screen instead of picking one. */
export const MANAGE_ACCOUNTS = "zerosub:manage-accounts";

export interface StartingOption {
  value: string;
  label: string;
  description?: string;
}

/** One account in the start-screen picker, laid out like a row of an agent's panel. */
export interface StartingRow {
  id: string;
  label: string;
  /** New agents start on it now. */
  current: boolean;
  /** Its glyph for the model picked in the composer. */
  glyph: AccountGlyph;
  /** The figure the row shows, as an agent's panel does: the share used ("45%"), or once full the wait ("2h 28m"). */
  meta: string;
  /** What it has left in words, for screen readers: "46% left · week", "full, back in 2h". */
  room: string | null;
  /** Its limits still worth reading for that model: what hovering the row shows. */
  lines: AccountWindowLine[];
  /** Said instead of the limits when there are none to show. */
  note: string | null;
}

/** The account a new agent starts on, and what the composer offers instead. */
export interface StartingChoice {
  /** Where the next new agent starts: a one-time pick ("Use for the next new agent"), else the default, else the first account. */
  current: AccountView;
  /** `current` is a one-time pick: only the next new agent starts there, then they follow the default again. */
  once: boolean;
  ring: AccountRing;
  /** Its glyph for the model picked in the composer (none yet: the account's busiest limit). */
  glyph: AccountGlyph;
  /** Each account that can become the default, the current one included. */
  rows: StartingRow[];
  /** The same accounts with what they have left, then the way to the Accounts screen: Paseo's own picker, on a host without `Modal`. */
  options: StartingOption[];
}

/** How long until `account` can take a turn of `model`: its own limit, a model's, or a full window that holds that model back. */
function backIn(account: AccountView, model: string | null, now: number): string | null {
  const until: string[] = [];
  if (account.status === "limited" && account.limitedUntil) until.push(account.limitedUntil);
  for (const limit of account.modelLimits ?? []) if (Date.parse(limit.until) > now && limitHolds(limit, model)) until.push(limit.until);
  for (const limit of account.usage?.windows ?? []) if (isFull(limit) && holdsBack(limit, model) && limit.resetsAt) until.push(limit.resetsAt);
  const latest = until.filter((at) => Date.parse(at) > now).sort((a, b) => Date.parse(b) - Date.parse(a))[0];
  return latest ? formatCountdown(latest, now) : null;
}

function startingRow(account: AccountView, current: boolean, model: string | null, now: number): StartingRow {
  const glyph = accountGlyph(account, model, now);
  const off = account.status === "signed_out" ? "Signed out" : account.status === "disabled" ? "Off" : null;
  const lines = off ? [] : windowLines(account, model, now);
  return {
    id: account.id,
    label: shortLabel(account),
    current,
    glyph,
    meta: off ?? (glyph.usedPercent >= 100 ? (backIn(account, model, now) ?? "Full") : formatPercent(glyph.usedPercent)),
    room: accountRoom(account, now),
    lines,
    note: noteOf(account, lines),
  };
}

/**
 * What the composer of an agent not started yet shows for `provider`, with the figures of `model`
 * (the one picked beside it, when known): where the next new agent starts, which a one-time pick
 * decides before the default does. Only an account that can run can become the default, so
 * signed-out and set-aside ones are left out, except the current one. Null for a provider ZeroSub
 * doesn't manage, without accounts, or with the pills turned off.
 */
export function startingChoice(state: StateView, provider: string | null, model: string | null = null, now: number = Date.now()): StartingChoice | null {
  if (!state.showComposerPill || !provider) return null;
  const family = state.providers[provider];
  if (!family) return null;
  const accounts = state.accounts.filter((account) => account.family === family);
  // A one-time pick, made on the Accounts screen or from the command center, wins for the next agent.
  const once = accounts.find((account) => account.nextAgentUntil && Date.parse(account.nextAgentUntil) > now);
  const current = once ?? accounts.find((account) => account.isDefault) ?? accounts[0];
  if (!current) return null;
  const eligible = accounts.filter((account) => account === current || (account.status !== "signed_out" && account.status !== "disabled"));
  const options: StartingOption[] = eligible.map((account) => {
    const room = accountRoom(account, now);
    return room ? { value: account.id, label: shortLabel(account), description: room } : { value: account.id, label: shortLabel(account) };
  });
  options.push({ value: MANAGE_ACCOUNTS, label: "Manage accounts…" });
  return {
    current,
    once: once !== undefined,
    ring: accountRing(current, now),
    glyph: accountGlyph(current, model, now),
    rows: eligible.map((account) => startingRow(account, account === current, model, now)),
    options,
  };
}
