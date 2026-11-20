import { useHosts, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { accountSubtitle, describeReopen, formatAge, formatCredits, formatExtraUsage, formatPlan, isDisabled, staleNotice, usageSummary } from "../shared/format";
import { FAMILY_LABEL, HAND_OFF, shownFamilies, type AccountView, type Family, type StateView } from "../shared/model";
import { preferences } from "../shared/preferences";
import {
  clearAccountLimit,
  removeAccount,
  renameAccount,
  setAccountEnabled,
  setAccountSessionsShared,
  setDefaultAccount,
  setNextAgentAccount,
} from "../shared/rpc";
import { AddAccountModal } from "./add-account";
import { ApiAccountModal } from "./api-account";
import { AzureAccountModal, AzureUsage, azureCardDetails } from "./azure-account";
import { BedrockAccountModal, BedrockUsage, bedrockCardDetails } from "./bedrock-account";
import { ForkDestinationRows, OpenCodeForkRows } from "./fork-settings";
import { AddPiAccountModal, ApiKeyModal, HomesHint, PiSectionNotes, ProxyModal, ShellHint, piCardDetails } from "./pi-accounts";
import { PaceSection } from "./pace";
import { ResetConfirm, redeemToast, resetBadge } from "./reset-confirm";
import { describe, stoppedWaiting, useStore, VISIBLE_POLL_MS, type ZeroSubStore } from "./store";
import { Badge, Button, Card, IconButton, UsageBar, useText, type TooltipAlign } from "./ui";
import { cardActions, splitCardActions, claudeCardDetails, removeText, type CardActionKey } from "./card-actions";

type Theme = PluginSurfaceProps["theme"];

export function AccountsSurface(props: PluginSurfaceProps & { store: ZeroSubStore }) {
  const { theme, layout, host, store } = props;
  const { state, error, updatedAt } = useStore(store);
  const text = useText(theme);
  const [adding, setAdding] = useState<{ family: Family; accountId?: string } | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshUsage = useCallback(async () => {
    setRefreshing(true);
    try {
      await store.refresh({ refreshUsage: true });
    } finally {
      setRefreshing(false);
    }
  }, [store]);
  // Each host runs its own copy of the plugin with its own accounts; Paseo's host picker switches.
  const hosts = useHosts();
  const multiHost = hosts.length > 1;
  const hostStatus = hosts.find((entry) => entry.serverId === host.id)?.status;
  const offline = hostStatus !== undefined && hostStatus !== "online";
  // Keep usage moving while the screen is open.
  useEffect(() => store.watch(VISIBLE_POLL_MS), [store]);

  // An optional provider (Pi, Grok, Cursor) shows once its CLI login is registered (its CLI is there,
  // and for Grok and Cursor a Paseo provider runs it) or an account of it was added.
  const families = shownFamilies(state?.accounts ?? []);
  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <ScrollView
        contentContainerStyle={{
          padding: layout.compact ? 16 : 28,
          gap: layout.compact ? 20 : 28,
          maxWidth: 820,
          width: "100%",
          alignSelf: "center",
        }}
      >
        <View style={{ gap: 6 }}>
          <Text style={[text.small, { fontWeight: "600", letterSpacing: 0.4 }]}>ZeroSub</Text>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={text.title} accessibilityRole="header">
              Subscription accounts
            </Text>
            {state ? (
              <IconButton
                theme={theme}
                icon="RefreshCw"
                label="Refresh usage"
                tooltip="Refresh usage for every account now"
                tooltipPlacement="bottom"
                busy={refreshing}
                onPress={() => void refreshUsage()}
              />
            ) : null}
          </View>
          <Text style={text.muted}>
            Keep several Claude, ChatGPT, Grok and Cursor accounts signed in, and run Pi on several Anthropic API keys. Each agent uses one;{" "}
            {state?.autoSwitch
              ? state.autoContinue
                ? "when a Claude or ChatGPT account hits its limit, agents move to another and keep going."
                : "when a Claude or ChatGPT account hits its limit, agents move to another and wait for you there."
              : "when an account hits its limit, move its agents to another from their account button, or turn on automatic switching below."}
          </Text>
        </View>

        {multiHost ? <HostScope theme={theme} label={host.label} /> : null}

        {error && (offline || !state) ? (
          <Card theme={theme}>
            <Text style={text.danger}>
              {offline
                ? `Can't reach ${host.label}. Its accounts are saved on that machine${
                    state ? "; this is how they looked last." : " and show up here once it reconnects."
                  }`
                : `Could not reach the daemon: ${error}`}
            </Text>
            <Button
              theme={theme}
              label="Try again"
              icon="RefreshCw"
              tooltip="Ask this host for its accounts again"
              tooltipAlign="start"
              onPress={() => void store.refresh()}
            />
          </Card>
        ) : null}

        {/* The daemon stopped answering, or answered with an error: say how old what's shown is. */}
        {error && state && !offline ? (
          <StaleNotice theme={theme} message={staleNotice(updatedAt, error)} onRetry={() => void store.refresh()} />
        ) : null}

        {state?.warnings.map((warning) => (
          <Card theme={theme} key={warning}>
            <Text style={text.warning}>{warning}</Text>
          </Card>
        ))}

        {!state && !error ? <Text style={text.muted}>Loading accounts…</Text> : null}

        {state
          ? families.map((family) => (
              <FamilySection
                key={family}
                family={family}
                accounts={state.accounts.filter((account) => account.family === family)}
                state={state}
                theme={theme}
                compact={layout.compact}
                store={store}
                onAdd={() => setAdding({ family })}
                onSignIn={(account) => setAdding({ family, accountId: account.id })}
              />
            ))
          : null}

        <AutomationSettings theme={theme} compact={layout.compact} />
      </ScrollView>

      {adding?.family === "pi" ? (
        <AddPiAccountModal theme={theme} store={store} onClose={() => setAdding(null)} />
      ) : adding ? (
        <AddAccountModal
          theme={theme}
          layout={layout}
          host={host}
          multiHost={multiHost}
          store={store}
          family={adding.family}
          accountId={adding.accountId}
          onClose={() => setAdding(null)}
        />
      ) : null}
    </View>
  );
}

/** Over the last state shown while the daemon doesn't answer; it goes once a refresh works again. */
function StaleNotice({ theme, message, onRetry }: { theme: Theme; message: string; onRetry(): void }) {
  const text = useText(theme);
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{
        flexDirection: "row",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 10,
        paddingVertical: 8,
        paddingHorizontal: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Icon name="CircleAlert" size={16} color={theme.colors.statusWarning} />
      <Text style={[text.small, { flex: 1, minWidth: 160 }]}>{message}</Text>
      <Button
        theme={theme}
        size="small"
        icon="RefreshCw"
        label="Try again"
        tooltip="Ask this host for its accounts again"
        tooltipAlign="end"
        onPress={onRetry}
      />
    </View>
  );
}

/** Says whose accounts these are when the app knows several hosts. */
function HostScope({ theme, label }: { theme: Theme; label: string }) {
  const text = useText(theme);
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 10,
        padding: 12,
        borderRadius: 10,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <Icon name="Server" size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={text.strong}>Accounts on {label}</Text>
        <Text style={text.small}>
          Only agents on this host use them. Each host keeps its own accounts and settings, so sign in on
          each host you use. Switch hosts with the host picker at the top; a host shows up there once ZeroSub
          is installed on it.
        </Text>
      </View>
    </View>
  );
}

const SECTION_TITLE: Record<Family, string> = { claude: "Claude", codex: "ChatGPT (Codex)", pi: "Pi", grok: "Grok", cursor: "Cursor" };

function FamilySection({
  family,
  accounts,
  state,
  theme,
  compact,
  store,
  onAdd,
  onSignIn,
}: {
  family: Family;
  accounts: AccountView[];
  state: StateView;
  theme: Theme;
  compact: boolean;
  store: ZeroSubStore;
  onAdd(): void;
  onSignIn(account: AccountView): void;
}) {
  const text = useText(theme);
  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={text.heading} accessibilityRole="header">
          {SECTION_TITLE[family]}
        </Text>
        <Button
          theme={theme}
          icon="Plus"
          label={compact ? "Add" : "Add account"}
          accessibilityLabel={`Add ${FAMILY_LABEL[family]} account`}
          tooltip={
            family === "pi"
              ? "Add a Pi account with an Anthropic API key and its own proxy"
              : family === "codex"
                ? "Sign in another ChatGPT account, or add an Azure OpenAI key"
                : family === "claude"
                  ? "Sign in another Claude account, or add an API key or AWS Bedrock"
                  : `Sign in another ${FAMILY_LABEL[family]} account`
          }
          tooltipAlign="end"
          onPress={onAdd}
        />
      </View>
      {accounts.length === 0 ? (
        <Text style={text.muted}>No {FAMILY_LABEL[family]} accounts yet.</Text>
      ) : null}
      {family === "pi" ? <PiSectionNotes theme={theme} state={state} accounts={accounts} store={store} /> : null}
      {family === "claude" && state.launchers ? (
        <ShellHint
          theme={theme}
          directory={state.launchers}
          accounts={accounts}
          example="claude-<account>.sh"
          note="Each runs claude on its account, with its settings and proxy, whatever your shell exports."
        />
      ) : null}
      {family === "claude" && state.claudeHomes ? <HomesHint theme={theme} family="claude" homes={state.claudeHomes} store={store} /> : null}
      {!HAND_OFF[family] ? (
        <Text style={text.small}>
          A {FAMILY_LABEL[family]} conversation stays on the account it started on. New agents use the default account, or the
          one you pick for them.
        </Text>
      ) : null}
      {chunk(accounts, compact ? 1 : 2).map((row) => (
        <View key={row.map((account) => account.id).join()} style={{ flexDirection: "row", gap: 10 }}>
          {row.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              theme={theme}
              store={store}
              paidFallback={state.paidApiFallback ?? false}
              compact={compact}
              onSignIn={() => onSignIn(account)}
            />
          ))}
          {!compact && row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </View>
  );
}

/** One of the icon buttons in a card's header. */
interface CardAction {
  key: string;
  icon: string;
  label: string;
  tooltip: string;
  tone?: "danger";
  busy?: boolean;
  onPress(): void;
}

function AccountCard({
  account,
  theme,
  store,
  paidFallback,
  compact,
  onSignIn,
}: {
  account: AccountView;
  theme: Theme;
  store: ZeroSubStore;
  /** Paid API accounts (Azure, Bedrock) may take work over by themselves once every subscription is out. */
  paidFallback: boolean;
  /** A phone-sized screen: the header's buttons get a row of their own, so the name keeps its room. */
  compact: boolean;
  onSignIn(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [busy, setBusy] = useState<"default" | "remove" | "clear" | "toggle" | "usage" | "next" | "sessions" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [editingApi, setEditingApi] = useState(false);
  const [editingProxy, setEditingProxy] = useState(false);
  const api = account.auth === "api";
  // An Azure OpenAI account's endpoint, key and prices have a form of their own.
  const azure = account.azure !== null;
  const [editingAzure, setEditingAzure] = useState(false);
  // So do an AWS Bedrock account's region, credentials, models and prices.
  const bedrock = account.bedrock !== null;
  const [editingBedrock, setEditingBedrock] = useState(false);
  const details = bedrock
    ? [bedrockCardDetails(account), claudeCardDetails(account)].filter(Boolean).join(" · ")
    : (piCardDetails(account) ?? claudeCardDetails(account) ?? azureCardDetails(account));
  const [confirmRemove, setConfirmRemove] = useState(false);
  // A wide card's buttons past the first few, shown under the name (see `splitCardActions`).
  const [moreActions, setMoreActions] = useState(false);
  // Moving the sessions folder copies and renames files, so the card's button asks first.
  const [confirmSessions, setConfirmSessions] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const resets = account.usage?.resets ?? null;
  const credits = account.usage?.credits ?? null;
  const extraUsage = account.usage?.extraUsage ? formatExtraUsage(account.usage.extraUsage) : null;
  const plan = azure || bedrock ? null : formatPlan(account.plan);
  const summary = usageSummary(account);
  const subtitle = accountSubtitle(account);
  const signedOut = account.status === "signed_out";
  // A signed-out account reports only that as its status, but may be disabled too.
  const disabled = isDisabled(account);
  const faded = disabled ? { opacity: 0.55 } : null;
  const windows = account.usage?.windows ?? [];
  const agents = account.agentCount === 0 ? "No agents" : `${account.agentCount} agent${account.agentCount === 1 ? "" : "s"}`;
  const freshness = !signedOut && account.usage && windows.length > 0 ? `updated ${formatAge(account.usage.fetchedAt)}` : null;

  // Sets the account aside for a while, or brings it back; its agents move off it and back.
  const toggle = useCallback(async () => {
    const enabling = isDisabled(account);
    setBusy("toggle");
    try {
      const result = await store.rpc(setAccountEnabled, { accountId: account.id, enabled: enabling });
      const message = describeReopen(`${account.label} is ${enabling ? "enabled" : "disabled"}`, result);
      const stayed =
        result.stayed > 0
          ? ` · ${result.stayed} ${FAMILY_LABEL[account.family]} conversation${result.stayed === 1 ? " stays" : "s stay"} on it (they can't change accounts)`
          : "";
      toast.show(`${message}${stayed}`, { variant: result.failed.length > 0 ? "warning" : "success", durationMs: 5_000 });
    } catch (error) {
      if (stoppedWaiting(error)) toast.show(stillMoving(account.label), { variant: "info", durationMs: 5_000 });
      else toast.error(describe(error));
    } finally {
      setBusy(null);
    }
  }, [account, store, toast]);

  const makeDefault = useCallback(async () => {
    setBusy("default");
    try {
      const summary = await store.rpc(setDefaultAccount, { accountId: account.id });
      toast.show(describeReopen(`${account.label} is now the default`, summary), { variant: summary.failed.length > 0 ? "warning" : "success" });
      await store.refresh();
    } catch (error) {
      if (stoppedWaiting(error)) toast.show(stillMoving(account.label), { variant: "info", durationMs: 5_000 });
      else toast.error(describe(error));
    } finally {
      setBusy(null);
    }
  }, [account, store, toast]);

  const nextAgent = useCallback(async () => {
    setBusy("next");
    const enabled = !account.nextAgentUntil;
    try {
      await store.rpc(setNextAgentAccount, { accountId: account.id, enabled });
      toast.show(enabled ? `Your next new agent starts on ${account.label} (for the next 10 minutes)` : "Next new agent: back to the default", { variant: "success" });
      await store.refresh();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setBusy(null);
    }
  }, [account, store, toast]);

  // Read the way this account's Claude Code reaches Anthropic: through its own proxy, if it has one.
  // What comes back, a reading or why there's none, shows on the card.
  const refreshUsage = useCallback(async () => {
    setBusy("usage");
    try {
      await store.refresh({ refreshUsage: true, accountId: account.id });
    } finally {
      setBusy(null);
    }
  }, [account.id, store]);

  // Shares the account's sessions folder with the CLI's own, or gives it its own again.
  const shareSessions = useCallback(async () => {
    const share = !account.sessionsShared;
    setBusy("sessions");
    try {
      await store.rpc(setAccountSessionsShared, { accountId: account.id, shared: share });
      toast.show(share ? `${account.label} now uses the default sessions folder` : `${account.label} now uses its own sessions folder`, { variant: "success" });
      await store.refresh();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setBusy(null);
      setConfirmSessions(false);
    }
  }, [account, store, toast]);

  // For when the user knows better, e.g. after upgrading the plan or buying credits.
  const markAvailable = useCallback(async () => {
    setBusy("clear");
    try {
      await store.rpc(clearAccountLimit, { accountId: account.id });
      toast.show(`${account.label} is available again`, { variant: "success" });
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setBusy(null);
    }
  }, [account, store, toast]);

  const remove = useCallback(async () => {
    setBusy("remove");
    try {
      const result = await store.rpc(removeAccount, { accountId: account.id });
      const removed = account.externalHome ? `Removed ${account.label} from ZeroSub; its sign-in and files are kept` : `Removed ${account.label}`;
      // An older server only says how many agents ran on it, not how moving them went.
      const message = result.moves
        ? describeReopen(removed, result.moves)
        : result.movedAgents > 0
          ? `${removed}; ${result.movedAgents} agent(s) move off it`
          : removed;
      toast.show(message, { variant: result.moves?.failed.length ? "warning" : "success" });
      await store.refresh();
    } catch (error) {
      if (stoppedWaiting(error)) {
        toast.show(`Still removing ${account.label} and moving its agents off it. Their timelines say when each has switched.`, {
          variant: "info",
          durationMs: 5_000,
        });
        void store.refresh();
      } else {
        toast.error(describe(error));
      }
    } finally {
      setBusy(null);
      setConfirmRemove(false);
    }
  }, [account, store, toast]);

  const offered: Record<CardActionKey, CardAction> = {
    clear: {
      key: "clear",
      icon: "CircleCheck",
      label: "Mark as available again (it has room)",
      tooltip: "Mark as available: use it again before its limit resets, e.g. after upgrading",
      busy: busy === "clear",
      onPress: () => void markAvailable(),
    },
    next: {
      key: "next",
      icon: account.nextAgentUntil ? "CircleX" : "SquarePlus",
      label: account.nextAgentUntil ? "Cancel: next new agent goes back to the default" : "Use for the next new agent",
      tooltip: account.nextAgentUntil
        ? "Your next new agent starts here. Click to cancel"
        : "Next new agent: the next agent you start (new workspace or tab) uses this account, once",
      busy: busy === "next",
      onPress: () => void nextAgent(),
    },
    default: {
      key: "default",
      icon: "Star",
      label: "Make default",
      tooltip: "Make default: new agents start on this account",
      busy: busy === "default",
      onPress: () => void makeDefault(),
    },
    toggle: {
      key: "toggle",
      icon: disabled ? "CirclePlay" : "CirclePause",
      label: disabled ? "Enable account" : "Disable for now (agents won't use it)",
      tooltip: disabled ? "Enable: agents can use this account again" : "Disable for now: agents stop using it and move to your other accounts",
      busy: busy === "toggle",
      onPress: () => void toggle(),
    },
    usage: {
      key: "usage",
      icon: "RefreshCw",
      label: "Refresh usage",
      tooltip: account.proxy ? `Refresh usage: read this account's now, through ${account.proxy}` : "Refresh usage: read this account's now",
      busy: busy === "usage",
      onPress: () => void refreshUsage(),
    },
    api: {
      key: "api",
      icon: "KeyRound",
      label: "API settings",
      tooltip: account.family === "pi" ? "API settings: key and base URL" : "API settings: key, base URL and traffic switches",
      onPress: () => setEditingApi(true),
    },
    azure: {
      key: "azure",
      icon: "KeyRound",
      label: "Azure settings",
      tooltip: "Azure settings: endpoint, key and prices",
      onPress: () => setEditingAzure(true),
    },
    bedrock: {
      key: "bedrock",
      icon: "KeyRound",
      label: "Bedrock settings",
      tooltip: "Bedrock settings: region, credentials, models and prices",
      onPress: () => setEditingBedrock(true),
    },
    proxy: { key: "proxy", icon: "Globe", label: "Proxy", tooltip: "Proxy: the network this account uses", onPress: () => setEditingProxy(true) },
    sessions: {
      key: "sessions",
      icon: account.sessionsShared ? "Unlink" : "Link",
      label: account.sessionsShared ? "Use its own sessions folder" : "Use the default sessions folder",
      tooltip: account.sessionsShared
        ? "Uses the default sessions folder (~/.claude/sessions). Asks before giving this account a folder of its own again"
        : "Uses a sessions folder of its own. Asks before switching it to the default one (~/.claude/sessions)",
      busy: busy === "sessions",
      onPress: () => setConfirmSessions(true),
    },
    rename: { key: "rename", icon: "Pencil", label: "Rename", tooltip: "Rename this account", onPress: () => setRenaming(true) },
    remove: {
      key: "remove",
      icon: "Trash2",
      label: "Remove",
      tooltip: account.externalHome ? "Remove from ZeroSub only: its sign-in, files and launcher stay" : api
          ? "Remove: delete its saved key"
          : "Remove: sign it out and delete its saved login",
      tone: "danger",
      busy: busy === "remove",
      onPress: () => setConfirmRemove(true),
    },
  };
  const keys = cardActions(account);
  const split = splitCardActions(keys);
  const iconButton = (action: CardAction, align: TooltipAlign) => (
    <IconButton
      key={action.key}
      theme={theme}
      icon={action.icon}
      label={action.label}
      tooltip={action.tooltip}
      tooltipAlign={align}
      tone={action.tone}
      busy={action.busy}
      onPress={action.onPress}
    />
  );
  // On a phone the buttons go on a row under the name, which leaves the name its room: up to nine 30 pt
  // buttons beside it would leave a 375 pt phone's card none. That row is 261 pt wide there (eight take
  // 254, a ninth wraps) and starts 75 pt from the screen's left, so a 240 pt tip opens rightwards from
  // the first two, centred over the next three and leftwards from the rest, and stays on screen; a
  // wrapped one counts from its row's start.
  const rowAlign = (index: number): TooltipAlign => (index % 8 < 2 ? "start" : index % 8 < 5 ? "center" : "end");
  const actionRow = compact ? (
    <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2, marginLeft: -6 }}>
      {keys.map((key, index) => iconButton(offered[key], rowAlign(index)))}
    </View>
  ) : (
    // Beside the name on a wider screen only a few, and "…" for the rest (see `splitCardActions`).
    <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginTop: -4, marginRight: -6 }}>
      {split.inline.map((key) => iconButton(offered[key], "end"))}
      {split.more.length > 0
        ? iconButton(
            {
              key: "more",
              icon: "Ellipsis",
              label: moreActions ? "Fewer actions" : "More actions",
              tooltip: moreActions ? "Hide the other actions" : "More actions for this account",
              onPress: () => setMoreActions((open) => !open),
            },
            "end",
          )
        : null}
    </View>
  );
  // Under the name and the card's full width, so the name stays readable; it starts at the card's left.
  const moreRow =
    !compact && moreActions && split.more.length > 0 ? (
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2, marginLeft: -6, marginTop: -6 }}>
        {split.more.map((key, index) => iconButton(offered[key], rowAlign(index)))}
      </View>
    ) : null;

  return (
    <Card theme={theme} fill>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <View style={faded}>
          <Avatar theme={theme} label={account.label} />
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          <View style={[{ gap: 3 }, faded]}>
            <Text style={text.strong} numberOfLines={1}>
              {account.label}
            </Text>
            {subtitle ? (
              <Text style={text.small} numberOfLines={1}>
                {subtitle}
              </Text>
            ) : null}
          </View>
          {compact ? actionRow : null}
        </View>
        {compact ? null : actionRow}
      </View>
      {moreRow}

      <View style={[{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }, faded]}>
        {account.isDefault ? <Badge theme={theme} label="Default" tone="accent" /> : null}
        {disabled ? <Badge theme={theme} label="Disabled" /> : null}
        {plan ? <Badge theme={theme} label={plan} /> : null}
        {azure ? (
          <Badge theme={theme} label="Azure · API" />
        ) : bedrock ? (
          <Badge theme={theme} label="Bedrock · API" />
        ) : api ? (
          <Badge theme={theme} label="API" />
        ) : null}
        {account.kind === "main" ? <Badge theme={theme} label="CLI login" /> : null}
        {account.status === "limited" ? <Badge theme={theme} label="Limit reached" tone="danger" /> : null}
        {account.status === "signed_out" ? <Badge theme={theme} label="Signed out" tone="warning" /> : null}
        {account.pace?.gated ? <Badge theme={theme} label="Held back" tone="warning" /> : null}
        {resets && !signedOut ? <Badge theme={theme} label={resetBadge(resets)} tone="accent" /> : null}
      </View>

      {details ? (
        <Text selectable style={[text.small, faded]} numberOfLines={3}>
          {details}
        </Text>
      ) : null}
      {account.moving ? (
        <Text style={[account.moving.error ? text.danger : text.small, faded]}>
          {account.moving.error
            ? `Couldn't move its folder to ${account.moving.to}: ${account.moving.error}`
            : `Moving its folder to ${account.moving.to}${account.moving.waiting ? `: ${account.moving.waiting}` : "…"}`}
        </Text>
      ) : null}

      <View style={[{ gap: 10 }, faded]}>
        {signedOut ? (
          <Text style={text.small}>
            {bedrock
              ? `AWS refused it${account.apiError ? `: ${account.apiError}` : "."} Fix its credentials, region or models to use this account.`
              : azure && account.apiError
                ? `Azure refused the key: ${account.apiError} Enter a working one to use this account.`
                : api
                  ? "The key was refused. Enter a working one to use this account."
                  : "Sign in again to use this account."}
          </Text>
        ) : azure ? (
          <AzureUsage theme={theme} account={account} paidFallback={paidFallback} />
        ) : bedrock ? (
          <BedrockUsage theme={theme} account={account} paidFallback={paidFallback} />
        ) : api ? (
          <Text style={text.small}>
            {[
              "Billed per use · used only as the default or when picked for an agent",
              account.api?.disableNonessentialTraffic
                ? "nonessential traffic off"
                : [account.api?.disableTelemetry ? "telemetry off" : null, account.api?.disableErrorReporting ? "error reporting off" : null].filter(Boolean).join(", ") || null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        ) : windows.length > 0 ? (
          windows.map((limit) => <UsageBar key={limit.id} theme={theme} limit={limit} />)
        ) : (
          <Text style={text.small}>{account.usage?.error ?? summary ?? "Checking usage…"}</Text>
        )}
        {account.pace ? (
          <View style={{ borderTopWidth: 1, borderTopColor: theme.colors.border, paddingTop: 10 }}>
            <PaceSection theme={theme} pace={account.pace} />
          </View>
        ) : null}
        {!signedOut && credits ? <Text style={text.small}>{formatCredits(credits)}</Text> : null}
        {!signedOut && extraUsage ? <Text style={text.small}>{extraUsage}</Text> : null}
        {!signedOut && windows.length > 0 && account.usage?.error ? <Text style={text.small}>{account.usage.error}</Text> : null}
        {!signedOut && resets?.blockedReason ? <Text style={text.small}>{resets.blockedReason}</Text> : null}
      </View>

      {/* Pinned to the bottom, so cards side by side line up however much each one shows. */}
      <View
        style={{
          marginTop: "auto",
          minHeight: 38,
          paddingTop: 10,
          borderTopWidth: 1,
          borderTopColor: theme.colors.border,
          flexDirection: "row",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          columnGap: 8,
          rowGap: 8,
        }}
      >
        <Text style={[text.small, { flexShrink: 1 }]} numberOfLines={1}>
          {disabled ? "Disabled · agents won't use it" : freshness ? `${agents} · ${freshness}` : agents}
        </Text>
        {signedOut ? (
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {disabled ? (
              <Button
                theme={theme}
                size="small"
                icon="CirclePlay"
                label="Enable"
                tooltip="Use this account again once it's signed in"
                tooltipAlign="end"
                busy={busy === "toggle"}
                onPress={() => void toggle()}
              />
            ) : null}
            <Button
              theme={theme}
              size="small"
              tone="primary"
              icon={api ? "KeyRound" : "LogIn"}
              label={bedrock ? "Fix settings" : api ? "Fix key" : "Sign in"}
              tooltip={bedrock ? "Fix this account's AWS credentials, region or models" : api ? "Enter a working key for this account" : "Sign this account in again"}
              tooltipAlign="end"
              onPress={azure ? () => setEditingAzure(true) : bedrock ? () => setEditingBedrock(true) : api ? () => setEditingApi(true) : onSignIn}
            />
          </View>
        ) : disabled ? (
          <Button
            theme={theme}
            size="small"
            tone="primary"
            icon="CirclePlay"
            label="Enable"
            tooltip="Use this account again; its agents move back to it"
            tooltipAlign="end"
            busy={busy === "toggle"}
            onPress={() => void toggle()}
          />
        ) : resets ? (
          <Button
            theme={theme}
            size="small"
            tone={account.status === "limited" ? "primary" : "secondary"}
            icon="TimerReset"
            label="Use reset"
            accessibilityLabel="Use a banked reset"
            tooltip="Spend a banked reset to refill this account's limits now"
            tooltipAlign="end"
            disabled={!resets.usableNow}
            onPress={() => setConfirmReset(true)}
          />
        ) : null}
      </View>
      <Modal title="Use a banked reset?" open={confirmReset} onOpenChange={setConfirmReset}>
        <Modal.Content>
          <ResetConfirm
            theme={theme}
            store={store}
            account={account}
            onCancel={() => setConfirmReset(false)}
            onFinished={(result) => {
              setConfirmReset(false);
              const { message, variant } = redeemToast(account.label, result);
              if (variant === "error") toast.error(message);
              else toast.show(message, { variant, durationMs: 5_000 });
            }}
          />
        </Modal.Content>
      </Modal>

      {renaming ? (
        <RenameModal theme={theme} account={account} store={store} onClose={() => setRenaming(false)} />
      ) : null}
      {editingApi ? (
        account.family === "claude" ? (
          <ApiAccountModal theme={theme} store={store} account={account} onClose={() => setEditingApi(false)} />
        ) : (
          <ApiKeyModal theme={theme} store={store} account={account} onClose={() => setEditingApi(false)} />
        )
      ) : null}
      {editingAzure ? (
        <AzureAccountModal theme={theme} store={store} account={account} paidFallback={paidFallback} onClose={() => setEditingAzure(false)} />
      ) : null}
      {editingBedrock ? (
        <BedrockAccountModal theme={theme} store={store} account={account} paidFallback={paidFallback} onClose={() => setEditingBedrock(false)} />
      ) : null}
      {editingProxy ? <ProxyModal theme={theme} store={store} account={account} onClose={() => setEditingProxy(false)} /> : null}
      <Modal
        title={account.sessionsShared ? `Give ${account.label} its own sessions folder?` : `Use the default sessions folder for ${account.label}?`}
        open={confirmSessions}
        onOpenChange={setConfirmSessions}
      >
        <Modal.Content>
          <Text style={text.body}>
            {account.sessionsShared
              ? `${account.label} gets an empty sessions folder of its own, and its sessions and the ones in ~/.claude/sessions stop seeing each other. What it registered in ~/.claude/sessions stays there.`
              : `${account.label}'s sessions folder becomes Claude Code's default, ~/.claude/sessions, so its running sessions and those of the CLI and every account using that folder see each other. What its own folder holds is copied there first, without overwriting anything, and the folder is kept beside it as sessions.bak-<time>.`}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" tooltip="Leave the sessions folder as it is" tooltipAlign="end" onPress={() => setConfirmSessions(false)} />
            <Button
              theme={theme}
              tone="primary"
              icon={account.sessionsShared ? "Unlink" : "Link"}
              label={account.sessionsShared ? "Use its own folder" : "Use the default folder"}
              tooltip={account.sessionsShared ? "Give this account an empty sessions folder of its own" : "Switch this account to ~/.claude/sessions"}
              tooltipAlign="end"
              busy={busy === "sessions"}
              onPress={() => void shareSessions()}
            />
          </View>
        </Modal.Content>
      </Modal>
      <Modal title={`Remove ${account.label}?`} open={confirmRemove} onOpenChange={setConfirmRemove}>
        <Modal.Content>
          <Text style={text.body}>
            {removeText(account).body}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" tooltip="Keep this account" tooltipAlign="end" onPress={() => setConfirmRemove(false)} />
            <Button
              theme={theme}
              tone="danger"
              icon="Trash2"
              label="Remove"
              tooltip={removeText(account).tooltip}
              tooltipAlign="end"
              busy={busy === "remove"}
              onPress={() => void remove()}
            />
          </View>
        </Modal.Content>
      </Modal>
    </Card>
  );
}

function RenameModal({
  theme,
  account,
  store,
  onClose,
}: {
  theme: Theme;
  account: AccountView;
  store: ZeroSubStore;
  onClose(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [label, setLabel] = useState(account.label);
  const [saving, setSaving] = useState(false);
  const save = useCallback(async () => {
    const next = label.trim();
    if (!next) return;
    setSaving(true);
    try {
      await store.rpc(renameAccount, { accountId: account.id, label: next });
      await store.refresh();
      onClose();
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setSaving(false);
    }
  }, [label, account.id, store, onClose, toast]);
  const inputStyle = useMemo(
    () => ({
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
    }),
    [theme],
  );
  return (
    <Modal title="Rename account" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={text.muted}>A short name you'll recognise in the composer, like "Work" or "Personal".</Text>
        <TextInput
          value={label}
          onChangeText={setLabel}
          autoFocus
          maxLength={40}
          placeholder="Account name"
          placeholderTextColor={theme.colors.foregroundMuted}
          onSubmitEditing={() => void save()}
          style={inputStyle}
          accessibilityLabel="Account name"
        />
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Cancel" tooltip="Keep the current name" tooltipAlign="end" onPress={onClose} />
          <Button
            theme={theme}
            tone="primary"
            label="Save"
            tooltip="Save the new name"
            tooltipAlign="end"
            busy={saving}
            disabled={!label.trim()}
            onPress={() => void save()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

function Avatar({ theme, label }: { theme: Theme; label: string }) {
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: 18,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
      }}
    >
      <Text style={{ color: theme.colors.foreground, fontSize: 15, fontWeight: "700" }}>{initial}</Text>
    </View>
  );
}

function AutomationSettings({ theme, compact }: { theme: Theme; compact: boolean }) {
  const settings = useSettings(preferences);
  const text = useText(theme);
  if (settings.status === "loading") return null;
  if (settings.status !== "ready") {
    return <Text style={text.danger}>Preferences unavailable: {settings.error}</Text>;
  }
  const save = (patch: Partial<typeof settings.values>) =>
    void settings.save({ ...settings.values, ...patch }, settings.revision);
  return (
    // Same gap as the page's other sections, so the OpenCode card reads as its own section.
    <View style={{ gap: compact ? 20 : 28 }}>
      <View style={{ gap: 10 }}>
        <Text style={text.heading} accessibilityRole="header">
          Automatic switching
        </Text>
        <SettingsCard>
          <SettingsSwitch
            label="Switch accounts when one hits its limit"
            hint="Agents move to the account with the most room left."
            value={settings.values.autoSwitch}
            disabled={settings.saving}
            onValueChange={(autoSwitch) => save({ autoSwitch })}
          />
          <SettingsSwitch
            label="Keep going after a switch"
            hint="Sends a short follow-up so the interrupted task continues, also after you use a banked reset. Off, a ChatGPT task that hits its limit stays where it stopped."
            value={settings.values.autoContinue}
            disabled={settings.saving}
            onValueChange={(autoContinue) => save({ autoContinue })}
          />
          <SettingsSwitch
            label="Spread new agents across accounts"
            hint="New ChatGPT agents prefer a weekly reset within one day when both limits have at least 20% left. Otherwise, new agents use the account with the most room."
            value={settings.values.balanceNewAgents}
            disabled={settings.saving}
            onValueChange={(balanceNewAgents) => save({ balanceNewAgents })}
          />
          <SettingsSwitch
            label="Move open agents when the default changes"
            hint="Off: open agents stay on the account they're using, even after they reopen. New agents, and agents that aren't open at the time, use the new default."
            value={settings.values.moveAgentsOnDefaultChange}
            disabled={settings.saving}
            onValueChange={(moveAgentsOnDefaultChange) => save({ moveAgentsOnDefaultChange })}
          />
          <SettingsSwitch
            label="Use banked resets when every account is out"
            hint="Spends one of the account's banked resets instead of stopping. Resets are scarce, so this is off unless you turn it on."
            value={settings.values.autoRedeem}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(autoRedeem) => save({ autoRedeem })}
          />
          <SettingsSwitch
            label="Use ChatGPT credits when a limit is reached"
            hint="A ChatGPT account at its limit stays in use while it has credits, so new agents may spend paid credits even while another account still has room."
            value={settings.values.useCredits}
            disabled={settings.saving}
            onValueChange={(useCredits) => save({ useCredits })}
          />
          <SettingsSwitch
            label="Use paid API accounts when every subscription is out"
            hint="Off unless you turn it on. When every subscription account of a provider is at its limit, signed out or disabled, agents may move to an Azure OpenAI account (ChatGPT), or an AWS Bedrock account or a Claude API key or token on Anthropic's own API (Claude), billed per use (after a banked reset, if those are used automatically), and Claude agents move back once a subscription has room. Off, those are used only as the default or when you pick one for an agent. Pi accounts never stand in."
            value={settings.values.paidApiFallback}
            disabled={settings.saving}
            onValueChange={(paidApiFallback) => save({ paidApiFallback })}
          />
          <SettingsSwitch
            label="When every account is out, fork the chat to the other provider"
            hint="A stopped Claude chat carries on in a new ChatGPT or OpenCode agent (pick the destination below) with the conversation so far. ChatGPT gets a mode no looser than this agent's. OpenCode gets Plan or Build under the host's own permission policy, which can allow more than Claude does. The original stays as it was."
            value={settings.values.forkOtherProvider}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(forkOtherProvider) => save({ forkOtherProvider })}
          />
          <ForkDestinationRows values={settings.values} saving={settings.saving} onSave={save} />
          <SettingsSwitch
            label="Keep a Codex chat in the same conversation"
            hint="Off unless you turn it on. Two ChatGPT accounts in one workspace reload this agent on the other account instead of opening a new tab. A different workspace, an email-only account, or a workspace that is out of credits still opens a new tab. If the first turn cannot resume the thread, this agent goes back and the new tab opens."
            value={settings.values.codexSameConversation}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(codexSameConversation) => save({ codexSameConversation })}
          />
        </SettingsCard>
      </View>
      <View style={{ gap: 10 }}>
        <Text style={text.heading} accessibilityRole="header">
          Continue on OpenCode
        </Text>
        <SettingsCard>
          <OpenCodeForkRows values={settings.values} saving={settings.saving} onSave={save} />
        </SettingsCard>
      </View>
      {settings.saveError ? <Text style={text.danger}>{settings.saveError}</Text> : null}
    </View>
  );
}

/** Paseo stopped waiting for a change that moves agents; the daemon carries on with it. */
function stillMoving(label: string): string {
  return `Still moving agents for ${label}. Their timelines say when each has switched.`;
}

function chunk<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}

