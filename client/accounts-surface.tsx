import { useHosts, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { accountSubtitle, describeReopen, formatAge, formatCredits, formatPlan, isDisabled, staleNotice, usageSummary } from "../shared/format";
import { FAMILIES, FAMILY_LABEL, HIDDEN, type AccountView, type Family, type StateView } from "../shared/model";
import { preferences } from "../shared/preferences";
import {
  clearAccountLimit,
  removeAccount,
  renameAccount,
  setAccountEnabled,
  setAccountProxy,
  setClaudeHomesDir,
  setDefaultAccount,
  setNextAgentAccount,
} from "../shared/rpc";
import { AddAccountModal } from "./add-account";
import { ApiAccountModal } from "./api-account";
import { ResetConfirm, redeemToast, resetBadge } from "./reset-confirm";
import { describe, stoppedWaiting, useStore, VISIBLE_POLL_MS, type ZeroSubStore } from "./store";
import { Badge, Button, Card, IconButton, UsageBar, useText, type TooltipAlign } from "./ui";
import { cardActions, type CardActionKey } from "./card-actions";
import { AddPiAccountModal, ApiKeyModal as PiApiKeyModal, PiSectionNotes, ProxyModal as PiProxyModal, piCardDetails } from "./pi-accounts";

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

  // Pi shows once its CLI login is registered (Pi is installed where the daemon runs) or an account of it was added.
  const families = FAMILIES.filter((family) => family !== "pi" || state?.accounts.some((account) => account.family === "pi"));
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
            Keep several Claude and ChatGPT accounts signed in, and Pi on several Anthropic API keys. Each agent uses one;{" "}
            {state?.autoSwitch
              ? state.autoContinue
                ? "when an account hits its limit, agents move to another and keep going."
                : "when an account hits its limit, agents move to another and wait for you there."
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
                launchers={family === "claude" ? state.launchers : null}
                homes={family === "claude" ? state.claudeHomes : null}
                theme={theme}
                compact={layout.compact}
                store={store}
                onAdd={() => setAdding({ family })}
                onSignIn={(account) => setAdding({ family, accountId: account.id })}
              />
            ))
          : null}

        <AutomationSettings theme={theme} />
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

const SECTION_TITLE: Record<Family, string> = { claude: "Claude", codex: "ChatGPT (Codex)", pi: "Pi" };

function FamilySection({
  family,
  accounts,
  launchers,
  homes,
  theme,
  compact,
  store,
  state,
  onAdd,
  onSignIn,
}: {
  family: Family;
  state: StateView;
  accounts: AccountView[];
  /** Directory with each added Claude account's command, if any account has one. */
  launchers: string | null;
  /** Where added accounts' folders are kept; null for Codex, and from older servers. */
  homes: StateView["claudeHomes"];
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
          tooltip={family === "pi" ? "Add a Pi account with an Anthropic API key and its own proxy" : `Sign in another ${FAMILY_LABEL[family]} account`}
          tooltipAlign="end"
          onPress={onAdd}
        />
      </View>
      {accounts.length === 0 ? (
        <Text style={text.muted}>No {FAMILY_LABEL[family]} accounts yet.</Text>
      ) : null}
      {family === "pi" ? <PiSectionNotes theme={theme} state={state} accounts={accounts} store={store} /> : null}
      {chunk(accounts, compact ? 1 : 2).map((row) => (
        <View key={row.map((account) => account.id).join()} style={{ flexDirection: "row", gap: 10 }}>
          {row.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              theme={theme}
              store={store}
              compact={compact}
              onSignIn={() => onSignIn(account)}
            />
          ))}
          {!compact && row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
      {launchers ? <ShellHint theme={theme} directory={launchers} accounts={accounts} /> : null}
      {homes ? <HomesHint theme={theme} homes={homes} store={store} /> : null}
    </View>
  );
}

/** Where added Claude accounts' folders are kept, and the way to keep them somewhere else. */
function HomesHint({ theme, homes, store }: { theme: Theme; homes: NonNullable<StateView["claudeHomes"]>; store: ZeroSubStore }) {
  const text = useText(theme);
  const [editing, setEditing] = useState(false);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 2 }}>
      <Icon name="FolderOpen" size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={text.small}>Each added account keeps its sign-in and settings in a folder of its own in</Text>
        <Text selectable style={[text.small, { color: theme.colors.foreground }]}>
          {homes.dir}
        </Text>
      </View>
      <IconButton
        theme={theme}
        icon="FolderPen"
        label="Change where accounts are kept"
        tooltip="Keep the accounts' folders somewhere else; they move there"
        tooltipAlign="end"
        onPress={() => setEditing(true)}
      />
      {editing ? <HomesModal theme={theme} homes={homes} store={store} onClose={() => setEditing(false)} /> : null}
    </View>
  );
}

function HomesModal({
  theme,
  homes,
  store,
  onClose,
}: {
  theme: Theme;
  homes: NonNullable<StateView["claudeHomes"]>;
  store: ZeroSubStore;
  onClose(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [dir, setDir] = useState(homes.isDefault ? "" : homes.dir);
  const typed = dir.trim();
  const changed = typed === "" ? !homes.isDefault : typed !== homes.dir;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await store.rpc(setClaudeHomesDir, { dir: typed });
      const moving = result.moving > 0 ? ` · ${result.moving} account${result.moving === 1 ? "" : "s"} move there once nothing runs on ${result.moving === 1 ? "it" : "them"}` : "";
      toast.show(`Accounts are kept in ${result.dir} now${moving}`, { variant: "success", durationMs: 5_000 });
      await store.refresh();
      onClose();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setSaving(false);
    }
  }, [typed, store, toast, onClose]);
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
    <Modal title="Where Claude accounts are kept" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={text.muted}>
          {`Now: ${homes.dir}${homes.isDefault ? ", beside the terminal scripts" : ""}. Each added account has a folder of its own there, named after it like its terminal script, with its sign-in and settings; new ones are signed in inside ZeroSub's own folder, then moved there.`}
        </Text>
        <Text style={text.muted}>
          {"Saving another folder moves every account kept here, and any still in ZeroSub's own folder, to it. Each moves once nothing runs on it: an agent or a terminal using it holds it back until it stops. Its Keychain entry moves with it. Removing an account later only takes it out of ZeroSub; its folder stays."}
        </Text>
        <TextInput
          value={dir}
          onChangeText={setDir}
          autoFocus
          maxLength={1024}
          placeholder={homes.isDefault ? homes.dir : "Default, beside the terminal scripts"}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => (changed ? void save() : undefined)}
          style={inputStyle}
          accessibilityLabel="Folder for Claude accounts"
        />
        <Text style={text.small}>A full path on this host; ~ is your home folder. Leave it empty for the default.</Text>
        {error ? <Text style={text.danger}>{error}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Cancel" tooltip="Keep the accounts where they are" tooltipAlign="end" onPress={onClose} />
          <Button
            theme={theme}
            tone="primary"
            label="Save"
            tooltip="Keep the accounts in this folder; they move there"
            tooltipAlign="end"
            busy={saving}
            disabled={!changed}
            onPress={() => void save()}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/** How to start the CLI on an added account from a terminal. */
function ShellHint({ theme, directory, accounts }: { theme: Theme; directory: string; accounts: AccountView[] }) {
  const text = useText(theme);
  const toast = useToast();
  // Readable when the path needs no quoting, which is nearly always.
  const line = /^[\w./~+@%-]+$/.test(directory)
    ? `export PATH="${directory}:$PATH"`
    : `export PATH='${directory.replace(/'/g, "'\\''")}':"$PATH"`;
  const commands = accounts.flatMap((account) => (account.launcher ? [account.launcher] : []));
  const copy = useCallback(async () => {
    try {
      await copyText(line);
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Couldn't copy. Select the text and copy it yourself.");
    }
  }, [line, toast]);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 2 }}>
      <Icon name="SquareTerminal" size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={text.small}>
          From a terminal on this host: add this line to your shell profile once, then run{" "}
          {commands.length > 0 ? commands.join(", ") : "claude-<account>"}. Accounts added later work without changing it.
        </Text>
        <Text selectable style={[text.small, { color: theme.colors.foreground }]}>
          {line}
        </Text>
      </View>
      <IconButton theme={theme} icon="Copy" label="Copy" tooltip="Copy the line for your shell profile" onPress={() => void copy()} />
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
  compact,
  onSignIn,
}: {
  account: AccountView;
  theme: Theme;
  store: ZeroSubStore;
  /** A phone-sized screen: the header's buttons get a row of their own, so the name keeps its room. */
  compact: boolean;
  onSignIn(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [busy, setBusy] = useState<"default" | "remove" | "clear" | "toggle" | "usage" | "next" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [editingProxy, setEditingProxy] = useState(false);
  const [editingApi, setEditingApi] = useState(false);
  // Pi's CLI login shows the Anthropic key it keeps, too.
  const api = account.auth === "api" || account.apiEditable ? account.api : null;
  // An API account "signs in again" by getting a working key, not through the sign-in page.
  const signIn = account.auth === "api" ? () => setEditingApi(true) : onSignIn;
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const resets = account.usage?.resets ?? null;
  const credits = account.usage?.credits ?? null;
  const plan = formatPlan(account.plan);
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
          ? ` · ${result.stayed} ChatGPT conversation${result.stayed === 1 ? " stays" : "s stay"} on it (they can't change accounts)`
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

  // For when the user knows better, e.g. after upgrading the plan or buying credits.
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
    proxy: { key: "proxy", icon: "Globe", label: "Proxy", tooltip: "Proxy: the network this account uses", onPress: () => setEditingProxy(true) },
    rename: { key: "rename", icon: "Pencil", label: "Rename", tooltip: "Rename this account", onPress: () => setRenaming(true) },
    remove: {
      key: "remove",
      icon: "Trash2",
      label: "Remove",
      tooltip: account.externalHome ? "Remove from ZeroSub only: its sign-in, files and launcher stay" : account.family === "pi"
          ? "Remove: delete its saved key"
          : "Remove: sign it out and delete its saved login",
      tone: "danger",
      busy: busy === "remove",
      onPress: () => setConfirmRemove(true),
    },
  };
  const actions = cardActions(account).map((key) => offered[key]);
  const details =
    piCardDetails(account) ??
    ([
      api ? `${api.keyKind === "api_key" ? "Key" : "Token"}${api.keyHint ? ` …${api.keyHint}` : ""} · ${api.baseUrl ?? "Anthropic API"}` : null,
      account.proxy ? `Via ${account.proxy}` : null,
      account.launcher ? `Terminal: ${account.launcher}` : null,
    ]
      .filter(Boolean)
      .join(" · ") ||
      null);
  // Beside the name, up to eight 30 pt buttons leave a 375 pt phone's card no room for it. There they go
  // on a row under the name instead (261 pt wide there; eight take 254). That row starts 75 pt from the
  // screen's left, so a 240 pt tip opens rightwards from the first two, centred over the next three and
  // leftwards from the rest, and stays on screen.
  const actionRow = (
    <View
      style={[
        { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 2 },
        compact ? { marginLeft: -6 } : { marginTop: -4, marginRight: -6 },
      ]}
    >
      {actions.map((action, index) => {
        const align: TooltipAlign = !compact ? "end" : index < 2 ? "start" : index < 5 ? "center" : "end";
        return (
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
      })}
    </View>
  );

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

      <View style={[{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }, faded]}>
        {account.isDefault ? <Badge theme={theme} label="Default" tone="accent" /> : null}
        {disabled ? <Badge theme={theme} label="Disabled" /> : null}
        {plan ? <Badge theme={theme} label={plan} /> : null}
        {account.auth === "api" ? <Badge theme={theme} label="API" /> : null}
        {account.kind === "main" ? <Badge theme={theme} label="CLI login" /> : null}
        {account.status === "limited" ? <Badge theme={theme} label="Limit reached" tone="danger" /> : null}
        {account.status === "signed_out" ? <Badge theme={theme} label="Signed out" tone="warning" /> : null}
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
          <Text style={text.small}>{account.auth === "api" ? "The key was refused. Enter a working one to use this account." : "Sign in again to use this account."}</Text>
        ) : account.auth === "api" ? (
          <Text style={text.small}>
            {[
              "Billed per use · used only as the default or when picked for an agent",
              api?.disableNonessentialTraffic
                ? "nonessential traffic off"
                : [api?.disableTelemetry ? "telemetry off" : null, api?.disableErrorReporting ? "error reporting off" : null].filter(Boolean).join(", ") || null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
        ) : windows.length > 0 ? (
          windows.map((limit) => <UsageBar key={limit.id} theme={theme} limit={limit} />)
        ) : (
          <Text style={text.small}>{account.usage?.error ?? summary ?? "Checking usage…"}</Text>
        )}
        {!signedOut && credits ? <Text style={text.small}>{formatCredits(credits)}</Text> : null}
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
              icon={account.auth === "api" ? "KeyRound" : "LogIn"}
              label={account.auth === "api" ? "Fix key" : "Sign in"}
              tooltip={account.auth === "api" ? "Enter a working key for this account" : "Sign this account in again"}
              tooltipAlign="end"
              onPress={signIn}
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
        account.family === "pi" ? (
          <PiApiKeyModal theme={theme} store={store} account={account} onClose={() => setEditingApi(false)} />
        ) : (
          <ApiAccountModal theme={theme} store={store} account={account} onClose={() => setEditingApi(false)} />
        )
      ) : null}
      {editingProxy ? (
        account.family === "pi" ? (
          <PiProxyModal theme={theme} account={account} store={store} onClose={() => setEditingProxy(false)} />
        ) : (
          <ProxyModal theme={theme} account={account} store={store} onClose={() => setEditingProxy(false)} />
        )
      ) : null}
      <Modal title={`Remove ${account.label}?`} open={confirmRemove} onOpenChange={setConfirmRemove}>
        <Modal.Content>
          <Text style={text.body}>
            {[
              account.externalHome
                ? `This only removes the account from ZeroSub. Its folder${account.home ? ` (${account.home})` : ""} is outside ZeroSub's own, so its sign-in${
                    account.launcher ? `, its files and its terminal script ${account.launcher}` : " and its files"
                  } stay as they are, and you can add it back by hand.`
                : account.family === "pi"
                  ? "This deletes the account's folder and saved key on this machine."
                  : "This signs the account out on this machine and deletes its saved login.",
              account.family !== "codex"
                ? "Agents using it move to the default account; their conversations are kept."
                : "New agents use the default account. Existing ChatGPT conversations on it can't move, so start new agents for them.",
            ].join(" ")}
          </Text>
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" tooltip="Keep this account" tooltipAlign="end" onPress={() => setConfirmRemove(false)} />
            <Button
              theme={theme}
              tone="danger"
              icon="Trash2"
              label="Remove"
              tooltip={
                account.externalHome
                  ? "Remove it from ZeroSub only; its agents move to the default"
                  : account.family === "pi"
                    ? "Delete its saved key; its agents move to the default"
                    : "Sign it out and delete its saved login; its agents move to the default"
              }
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

function ProxyModal({
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
  // The box starts with the current proxy, its password hidden: a change is only saved with the
  // password typed in full.
  const current = account.proxy ?? "";
  const [proxy, setProxy] = useState(current);
  const typed = proxy.trim();
  const hidden = typed.includes(HIDDEN);
  // Main's settings can outrank a proxy set here for the CLI login: it's set there instead.
  const blocked = account.proxyBlocked;
  const changed = typed !== "" && typed !== current && !hidden && !blocked;
  const inherited = account.inheritedProxy;
  // Kept in the user's file (the CLI login's in ~/.claude/settings.json): saving changes it there,
  // for whatever else reads it too.
  const file = account.proxyFile;
  const followers = account.proxyFollowers.length > 0 ? `, and so do ${account.proxyFollowers.join(", ")}, which have no proxy of their own` : "";
  const afterRemoval = inherited ? `they then go through ${inherited.proxy}, set in ${inherited.from}` : "they then use the network the CLI already has";
  const [saving, setSaving] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(
    async (value: string) => {
      setSaving(value ? "save" : "clear");
      setError(null);
      try {
        const result = await store.rpc(setAccountProxy, { accountId: account.id, proxy: value });
        toast.show(result.proxy ? `${account.label} now uses ${result.proxy}` : `${account.label} no longer uses a proxy`, {
          variant: "success",
        });
        await store.refresh();
        onClose();
      } catch (failure) {
        setError(describe(failure));
      } finally {
        setSaving(null);
      }
    },
    [account, store, toast, onClose],
  );
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
    <Modal title={`Proxy for ${account.label}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={text.muted}>
          {account.proxy
            ? `Now: ${account.proxy}${file ? `, set in ${file}` : ""}.`
            : inherited
              ? `Now: no proxy of its own; it goes through ${inherited.proxy}, set in ${inherited.from}.`
              : "Now: no proxy of its own; it uses the network the CLI already has."}
          {blocked
            ? null
            : file
              ? ` Saving changes it there, so plain claude in a terminal uses it too${followers}. Removing it takes it out of there, and ${afterRemoval}. Agents started afterwards use the new setting; running ones keep theirs until they reopen.`
              : account.kind === "main"
              ? " Agents started after saving use the new setting; running ones keep theirs until they reopen. Plain claude in a terminal doesn't: it goes the way ~/.claude/settings.json and your shell say."
              : " Agents and terminal sessions started after saving use the new setting; running ones keep theirs until they reopen."}
        </Text>
        {blocked ? <Text style={text.danger}>{blocked}</Text> : null}
        {blocked ? null : (
          <>
            <TextInput
              value={proxy}
              onChangeText={setProxy}
              autoFocus
              maxLength={2048}
              // Empty keeps the proxy it goes through without one of its own, so that's what it shows.
              placeholder={inherited?.proxy ?? "http://host:port"}
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={() => (changed ? void save(typed) : undefined)}
              style={inputStyle}
              accessibilityLabel="Proxy URL"
            />
            <Text style={text.small}>
              {hidden
                ? `${HIDDEN} hides the proxy's password: type it in full to save a change.`
                : "http:// or https://, with user:password@ if the proxy needs it."}
            </Text>
          </>
        )}
        {error ? <Text style={text.danger}>{error}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <Button
            theme={theme}
            label={blocked ? "Close" : "Cancel"}
            tooltip={blocked ? "Close" : "Keep the current proxy"}
            tooltipAlign="end"
            onPress={onClose}
          />
          {account.proxy ? (
            <Button
              theme={theme}
              label="Remove proxy"
              tooltip={file ? `Take the proxy out of ${file}` : "Stop using a proxy of its own"}
              tooltipAlign="end"
              busy={saving === "clear"}
              onPress={() => void save("")}
            />
          ) : null}
          {blocked ? null : (
            <Button
              theme={theme}
              tone="primary"
              label="Save"
              tooltip="Use this proxy for the account"
              tooltipAlign="end"
              busy={saving === "save"}
              disabled={!changed}
              onPress={() => void save(typed)}
            />
          )}
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

function AutomationSettings({ theme }: { theme: Theme }) {
  const settings = useSettings(preferences);
  const text = useText(theme);
  if (settings.status === "loading") return null;
  if (settings.status !== "ready") {
    return <Text style={text.danger}>Preferences unavailable: {settings.error}</Text>;
  }
  const save = (patch: Partial<typeof settings.values>) =>
    void settings.save({ ...settings.values, ...patch }, settings.revision);
  return (
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
          label="When every account is out, fork the chat to the other provider"
          hint="A stopped Claude chat carries on in a new ChatGPT agent, or the other way round, with the conversation so far. The new agent gets no more permissions than the original; the original stays as it was."
          value={settings.values.forkOtherProvider}
          disabled={settings.saving || !settings.values.autoSwitch}
          onValueChange={(forkOtherProvider) => save({ forkOtherProvider })}
        />
      </SettingsCard>
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

