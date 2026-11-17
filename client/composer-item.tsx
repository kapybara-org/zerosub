import type { PluginClientContext } from "@getpaseo/plugin/client";
import * as paseoClient from "@getpaseo/plugin/client";
import * as paseoUi from "@getpaseo/plugin/client/ui";
import type { ComponentType } from "react";
import { accountPeak, formatCredits, formatPercent } from "../shared/format";
import { ACCOUNT_METADATA_KEY, type AccountView, type StateView } from "../shared/model";
import { useStore, type ZeroSubStore } from "./store";

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

interface ComposerItems {
  addComposerItem?(item: { id: string; Component: ComponentType }): () => void;
}

export interface AccountOption {
  value: string;
  label: string;
  description?: string;
}

export interface AccountChoices {
  value: string;
  options: AccountOption[];
}

/** The option that names no account: the agent starts where any new agent would. */
export const FOLLOW = "follow";

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
  const offered = accounts.filter(
    (account) => account.status !== "signed_out" && account.status !== "disabled" && !(state.autoSwitch && account.status === "limited"),
  );

  // Without a choice: the one-time pick, else (when spreading) the account with the most room, else the default.
  const picked = offered.find((account) => account.nextAgentUntil);
  const usual = picked ?? (state.balanceNewAgents ? undefined : offered.find((account) => account.isDefault));
  const options: AccountOption[] = [
    usual
      ? { value: FOLLOW, label: usual.label, description: detail(usual, picked ? "Picked for the next new agent" : "Default") }
      : { value: FOLLOW, label: "Automatic", description: "The account with the most room" },
  ];
  for (const account of offered) {
    if (account !== usual) options.push({ value: account.id, label: account.label, description: detail(account) });
  }
  // A choice that's no longer offered (the provider changed, or its account can't take agents now) reads as none.
  const value = options.some((option) => option.value === chosen) ? (chosen as string) : FOLLOW;
  return { value, options };
}

function detail(account: AccountView, lead?: string): string | undefined {
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
 * An account control in the composer of an agent that doesn't exist yet: a new agent's tab, and the
 * New workspace screen. A running agent has its account button (see pills.ts), which needs an agent
 * to belong to. The choice travels in the new agent's metadata, and routing starts the agent on it.
 */
export function contributeComposerItem(client: PluginClientContext, store: ZeroSubStore): () => void {
  const { useComposer } = paseoClient as unknown as { useComposer?: () => Composer };
  const { Select } = paseoUi as unknown as { Select?: ComponentType<SelectProps> };
  const host = client as unknown as ComposerItems;
  if (typeof host.addComposerItem !== "function" || typeof useComposer !== "function" || !Select) return () => {};

  const AccountItem = () => {
    const composer = useComposer();
    const { state } = useStore(store);
    if (composer.context === "agent" || !state) return null;
    const choices = accountChoices(state, composer.agent.provider, composer.agent.metadata[ACCOUNT_METADATA_KEY]);
    if (!choices) return null;
    return (
      <Select
        title="Account"
        icon="CircleUserRound"
        value={choices.value}
        options={choices.options}
        onValueChange={({ value }) => composer.setMetadata({ [ACCOUNT_METADATA_KEY]: value === FOLLOW ? null : value })}
      />
    );
  };

  try {
    return host.addComposerItem({ id: "account", Component: AccountItem });
  } catch (error) {
    console.warn("[ZeroSub] could not add the account control for new agents", error);
    return () => {};
  }
}
