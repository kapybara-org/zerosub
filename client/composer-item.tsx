import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import * as paseoClient from "@getpaseo/plugin/client";
import * as paseoUi from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { View } from "react-native";
import { accountPeak, accountTitle, formatCredits, formatPercent, isDisabled, paceVerdict, pillText } from "../shared/format";
import { ACCOUNT_METADATA_KEY, AGENT_METADATA_KEY, HAND_OFF, type AccountView, type StateView } from "../shared/model";
import { AccountPillButton } from "./account-pill-button";
import { watchControl } from "./control-visibility";
import { accountName, agentMenu, pillLabel, pillTitle, usageLine } from "./pills";
import { moveAgent, useStore, type ZeroSubStore } from "./store";

/**
 * Paseo 0.16's composer items, as far as the account control uses them. The plugin SDK this builds
 * against (0.9.1) doesn't list them, and an older app doesn't have them: there the control is left out.
 */
interface Composer {
  /** `agent`: a running agent. `draft`: a new agent in a workspace. `new-workspace`: the New workspace screen. */
  readonly context: "agent" | "draft" | "new-workspace";
  readonly agent: { readonly provider: string | null; readonly metadata: Readonly<Record<string, unknown>> };
  /** In a composer without an agent, what's set is sent when the agent is created. `null` removes a key. */
  setMetadata(patch: Record<string, string | null>): Promise<void>;
}

interface SelectProps {
  title: string;
  icon: string;
  value: string;
  options: readonly AccountOption[];
  onValueChange(event: { value: string }): void | Promise<void>;
}

/** Paseo 0.16's searchable list: what it shows on the control is `value.label`, apart from the entries. */
interface ComboboxProps {
  title: string;
  icon: string;
  value: { id: string; label: string } | null;
  search(input: { query: string }): Promise<readonly ComboboxEntry[]>;
  onSelect(input: { item: ComboboxEntry }): void | Promise<void>;
}

export interface ComboboxEntry {
  id: string;
  label: string;
  description?: string;
}

interface ComposerItems {
  addComposerItem?(item: { id: string; Component: ComponentType<PluginHostProps> }): () => void;
}

export interface AccountOption {
  value: string;
  label: string;
  description?: string;
}

export interface AccountChoices {
  value: string;
  options: AccountOption[];
  icon: string;
  /** The control's name, which Paseo shows as its label and tooltip and heads its list with: "Claude account". */
  title: string;
}

/** Beside an agent's account in its list, when the agent started there because the account's weekly reset was near. */
export const WEEKLY_RESET_NOTE = "Weekly reset was near";

/** The option that names no account: the agent starts, or goes back to, where the default sends it. */
export const FOLLOW = "follow";
/** The option that opens the Accounts screen. */
export const MANAGE = "manage";

/**
 * What the account control offers in a composer whose agent doesn't exist yet, or null when there's
 * nothing to choose: fewer than two accounts, the account button turned off, a provider ZeroSub
 * doesn't route, or a host whose Paseo keeps no agent metadata to carry the choice in (an app from
 * 0.16 can be talking to an older host, which would then fail to create the agent). Only accounts
 * that can take a new agent are offered, as routing would pass over the others. The first option
 * names none and says where the agent starts then.
 */
export function accountChoices(state: StateView, provider: string | null, chosen: unknown): AccountChoices | null {
  if (!state.showComposerPill || state.agentMetadata !== true || !provider) return null;
  const family = state.providers[provider];
  if (!family) return null;
  const accounts = state.accounts.filter((account) => account.family === family);
  if (accounts.length < 2) return null;
  const offered = accounts.filter((account) => takesAgents(state, account));

  // Without a choice: the one-time pick, else (when spreading) the account with the most room, else the default.
  const picked = offered.find((account) => account.nextAgentUntil);
  const usual = picked ?? (state.balanceNewAgents ? undefined : offered.find((account) => account.isDefault));
  const pacedId = state.pacedNext?.[family];
  const pacedLabel = offered.find((account) => account.id === pacedId)?.label;
  // A one-time pick sends the next agent there, whatever pacing would choose.
  const picks = (account: AccountView) => !picked && pacedId === account.id;
  const options: AccountOption[] = [
    usual
      ? { value: FOLLOW, label: usual.label, description: detail(usual, picks(usual), picked ? "Picked for the next new agent" : "Default") }
      : { value: FOLLOW, label: "Automatic", description: pacedLabel ? `Pacing picks ${pacedLabel}` : "The account with the most room" },
  ];
  for (const account of offered) {
    if (account !== usual) options.push({ value: account.id, label: account.label, description: detail(account, picks(account)) });
  }
  // A choice that's no longer offered (the provider changed, or its account can't take agents now) reads as none.
  const value = options.some((option) => option.value === chosen) ? (chosen as string) : FOLLOW;
  return { value, options, icon: "CircleUserRound", title: accountTitle(family) };
}

/**
 * What the account control offers for a running agent: the account it's on first (named with the
 * one it's moving from while a move is under way, as on the account button), then the accounts it
 * can move to, going back to the default, and the Accounts screen. The agent's account also says
 * when the agent started on it because its weekly reset was near. Null when the agent isn't routed
 * or its provider has one account. What needs a confirmation, a banked reset or a fork to the other
 * provider, stays with the account button, which shows for it (see pills.ts).
 */
export function agentChoices(state: StateView, agentId: string): AccountChoices | null {
  if (!state.showComposerPill) return null;
  const route = state.agents.find((entry) => entry.agentId === agentId);
  if (!route || route.inComposer === false) return null;
  const accounts = state.accounts.filter((account) => account.family === route.family);
  const current = accounts.find((account) => account.id === route.accountId);
  if (!current || accounts.length < 2) return null;
  const running = route.pendingAccountId ? state.accounts.find((account) => account.id === route.pendingAccountId) : undefined;
  const { label } = pillText(current, running ?? null, route.waiting ?? (state.canReopen ? "idle" : "restart"));
  // As on the account button: pacing's verdict names the account it picks for the next new agent.
  const next = (account: AccountView) => state.pacedNext?.[account.family] === account.id;
  // Why the agent is on this account, which the account button's menu says as "Started here: weekly
  // reset was near": with the control there, that button doesn't show for an agent that isn't at a
  // limit. Short, as a list cuts a description to one line. On this account it stands in place of
  // pacing's verdict, which the others keep; without pacing the usage comes after it.
  const options: AccountOption[] = [
    { value: current.id, label, description: detail(current, next(current), route.selectionReason === "weekly_reset" ? WEEKLY_RESET_NOTE : undefined) },
  ];
  // Codex threads can't change accounts in place and continue in the task's tab for the account;
  // Grok conversations stay on theirs, so the others aren't offered.
  const stays = !route.movable && !HAND_OFF[route.family];
  for (const account of accounts) {
    if (stays || account === current || !takesAgents(state, account)) continue;
    options.push({ value: account.id, label: route.movable ? account.label : `Continue on ${account.label}`, description: detail(account, next(account)) });
  }
  if (route.pinned && route.movable) {
    const fallback = accounts.find((account) => account.isDefault);
    options.push({ value: FOLLOW, label: fallback ? `Follow default (${fallback.label})` : "Follow default" });
  }
  options.push({ value: MANAGE, label: "Manage accounts…" });
  return { value: current.id, options, icon: current.status === "limited" ? "CircleAlert" : "CircleUserRound", title: accountTitle(route.family) };
}

/**
 * A running agent's control as the account button shows it (see pills.ts), while
 * `keepComposerPill` is on: the control says the account's usage (`5h 71 · 7d 66`), and each entry
 * the account's name and state, with its usage and how long until each window resets. The same
 * entries as `agentChoices`, in the same order. Null where that is.
 */
export function agentFace(
  state: StateView,
  agentId: string,
  now = Date.now(),
): { icon: string; value: { id: string; label: string }; tooltip: string; entries: ComboboxEntry[]; choices: AccountChoices } | null {
  const choices = agentChoices(state, agentId);
  const route = state.agents.find((entry) => entry.agentId === agentId);
  const current = state.accounts.find((account) => account.id === choices?.value);
  if (!choices || !route || !current) return null;
  const entries = choices.options.map((option): ComboboxEntry => {
    const account = state.accounts.find((candidate) => candidate.id === option.value);
    // The way back to the default and the Accounts screen; and the agent's own while it's moving,
    // which names both accounts as the button does.
    if (!account || (account === current && route.pendingAccountId)) return { id: option.value, label: option.label };
    const name = accountName(state, account, now);
    const usage = usageLine(account, now);
    return { id: option.value, label: account === current || route.movable ? name : `Continue on ${name}`, ...(usage ? { description: usage } : {}) };
  });
  return { icon: choices.icon, value: { id: choices.value, label: pillLabel(state, current, route, now) }, tooltip: pillTitle(state, current, route, now), entries, choices };
}

/** As routing takes them: an account at its limit only with automatic switching off. */
function takesAgents(state: StateView, account: AccountView): boolean {
  return account.status !== "signed_out" && !isDisabled(account) && !(state.autoSwitch && account.status === "limited");
}

function detail(account: AccountView, next: boolean, lead?: string): string | undefined {
  // A pace and a lead: the lead (a one-time pick, or why the agent started here) wins over pacing's verdict.
  if (account.pace) return lead ?? paceVerdict(account.pace, next);
  const parts = lead ? [lead] : [];
  if (account.status === "limited") parts.push("Limit reached");
  else {
    // A full window of one model only (Claude's "Weekly · Opus") isn't the account's room.
    const peak = account.usage ? accountPeak(account.usage.windows) : null;
    if (peak) parts.push(`${formatPercent(peak.usedPercent)} used`);
    const credits = account.usage?.credits;
    if (peak && credits) parts.push(formatCredits(credits));
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/**
 * The Account control, in every composer. Where the agent doesn't exist yet (a new agent's tab, the
 * New workspace screen) the choice travels in the new agent's metadata, and routing starts the
 * agent on it. For a running agent it shows the agent's account and moves the agent, so the account
 * stays in one place once the first message is sent. Paseo says nothing of which agent a composer
 * belongs to but that agent's metadata, so the daemon keeps the agent's ID there (see
 * `AGENT_METADATA_KEY`), and until it's there the control shows nothing.
 *
 * `added` says whether the control is there, for the account button to step back (see pills.ts).
 * With `keepComposerPill` on, the button steps back only while a running agent's control
 * is on screen, which each control reports (see `useControlShown`).
 */
export function contributeComposerItem(client: PluginClientContext, store: ZeroSubStore): { added: boolean; stop(): void } {
  const none = { added: false, stop() {} };
  const { useComposer } = paseoClient as unknown as { useComposer?: () => Composer };
  const { Select, Combobox } = paseoUi as unknown as {
    Select?: ComponentType<SelectProps>;
    Combobox?: ComponentType<ComboboxProps>;
  };
  const host = client as unknown as ComposerItems;
  if (typeof host.addComposerItem !== "function" || typeof useComposer !== "function" || !Select) return none;

  const move = (state: StateView, agentId: string, choices: AccountChoices, value: string): void | Promise<void> => {
    if (value === MANAGE) return client.openSurface("accounts");
    if (value === choices.value) return;
    const accountId = value === FOLLOW ? null : value;
    const family = state.agents.find((entry) => entry.agentId === agentId)?.family;
    const to = state.accounts.find((account) => (accountId ? account.id === accountId : account.family === family && account.isDefault));
    return moveAgent(store, agentId, accountId, to?.label ?? "the default account");
  };

  const AgentControl = ({ state, agentId, provider, choices, host }: { state: StateView; agentId: string; provider: string | null; choices: AccountChoices; host: PluginHostProps }) => {
    const { ref, inSheet, onLayout } = useControlShown(agentId);
    const Menu = useMemo(() => (provider ? agentMenu(client, store, { id: agentId, provider }) : null), [agentId, provider]);
    // As the account button shows it. Off a phone, on the web, the button itself: a pill that says
    // the usage and opens the button's own menu above it, which Paseo's lists can't draw (an entry a
    // line); on a phone, where the control is only ever in the composer's sheet, a list that says
    // the usage, rather than a menu over the sheet. The native apps get the list too, also on a
    // tablet or a phone on its side, where the composer isn't compact: the pill's menu is placed
    // with `position: fixed`, which only React Native for the web has.
    const face = state.keepComposerPill ? agentFace(state, agentId) : null;
    // In the composer's sheet (a dialog of Paseo's), the list below too: see `inDialog`.
    if (face && Menu && host.layout.platform === "web" && !host.layout.compact && !inSheet) {
      return (
        <View ref={ref} collapsable={false} onLayout={onLayout}>
          <AccountPillButton host={host} agentId={agentId} title={face.tooltip} icon={face.icon} label={face.value.label} Menu={Menu} />
        </View>
      );
    }
    return (
      <View ref={ref} collapsable={false} onLayout={onLayout}>
        {face && Combobox ? (
          <Combobox
            title={face.choices.title}
            icon={face.icon}
            value={face.value}
            search={async ({ query }) => matching(face.entries, query)}
            onSelect={({ item }) => move(state, agentId, face.choices, item.id)}
          />
        ) : (
          <Select
            title={choices.title}
            icon={choices.icon}
            value={choices.value}
            options={choices.options}
            onValueChange={({ value }) => move(state, agentId, choices, value)}
          />
        )}
      </View>
    );
  };

  const AccountItem = (host: PluginHostProps) => {
    const composer = useComposer();
    const { state } = useStore(store);
    if (!state) return null;
    if (composer.context === "agent") {
      const agentId = composer.agent.metadata[AGENT_METADATA_KEY];
      const choices = typeof agentId === "string" ? agentChoices(state, agentId) : null;
      if (!choices || typeof agentId !== "string") return null;
      return <AgentControl state={state} agentId={agentId} provider={composer.agent.provider} choices={choices} host={host} />;
    }
    const choices = accountChoices(state, composer.agent.provider, composer.agent.metadata[ACCOUNT_METADATA_KEY]);
    if (!choices) return null;
    return (
      <Select
        title={choices.title}
        icon={choices.icon}
        value={choices.value}
        options={choices.options}
        onValueChange={({ value }) => composer.setMetadata({ [ACCOUNT_METADATA_KEY]: value === FOLLOW ? null : value })}
      />
    );
  };

  try {
    return { added: true, stop: host.addComposerItem({ id: "account", Component: AccountItem }) };
  } catch (error) {
    console.warn("[ZeroSub] could not add the account control to composers", error);
    return none;
  }
}

/** How often a mounted control checks whether it's on screen: Paseo moves it without telling. */
const VISIBILITY_CHECK_MS = 500;

/**
 * Reports whether this mount of `agentId`'s control is on screen (see control-visibility.ts),
 * for the account button to show only where it isn't: in a composer too narrow for the control,
 * which Paseo then hides in the toolbar and moves to the composer's sheet. And whether this mount
 * is the one in that sheet.
 */
function useControlShown(agentId: string) {
  const ref = useRef<View>(null);
  const watch = useRef<{ check(): void } | null>(null);
  const [inSheet, setInSheet] = useState(false);
  useEffect(() => {
    const watcher = watchControl(agentId, () => ref.current, setInSheet, VISIBILITY_CHECK_MS);
    watch.current = watcher;
    return () => {
      watch.current = null;
      watcher.stop();
    };
  }, [agentId]);
  // Laid out again as its tab comes into view or leaves it: checked then, not only on the timer.
  const onLayout = useCallback(() => watch.current?.check(), []);
  return { ref, inSheet, onLayout };
}

/** The entries whose name or usage has `query` in it, all of them for none. */
export function matching(entries: readonly ComboboxEntry[], query: string): ComboboxEntry[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [...entries];
  return entries.filter((entry) => `${entry.label} ${entry.description ?? ""}`.toLowerCase().includes(wanted));
}
