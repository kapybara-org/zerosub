import { useHosts, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { accountSubtitle, describeReopen, formatAge, formatCredits, formatExtraUsage, formatPlan, staleNotice, usageSummary } from "../shared/format";
import { FAMILIES, FAMILY_LABEL, type AccountView, type Family, type StateView } from "../shared/model";
import { preferences } from "../shared/preferences";
import {
  clearAccountLimit,
  removeAccount,
  renameAccount,
  setAccountEnabled,
  setDefaultAccount,
  setNextAgentAccount,
} from "../shared/rpc";
import { AddAccountModal } from "./add-account";
import { ForkDestinationRows, OpenCodeForkRows } from "./fork-settings";
import { AddPiAccountModal, ApiKeyModal, PiSectionNotes, ProxyModal, piCardDetails } from "./pi-accounts";
import { ResetConfirm, redeemToast, resetBadge } from "./reset-confirm";
import { describe, stoppedWaiting, useStore, VISIBLE_POLL_MS, type ZeroSubStore } from "./store";
import { Badge, Button, Card, IconButton, UsageBar, useText } from "./ui";

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
            Keep several Claude and ChatGPT accounts signed in, and run Pi on several Anthropic API keys. Each
            agent uses one; when an account hits its limit, agents move to another and keep going.
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
              onSignIn={() => onSignIn(account)}
            />
          ))}
          {!compact && row.length === 1 ? <View style={{ flex: 1 }} /> : null}
        </View>
      ))}
    </View>
  );
}

function AccountCard({
  account,
  theme,
  store,
  onSignIn,
}: {
  account: AccountView;
  theme: Theme;
  store: ZeroSubStore;
  onSignIn(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [busy, setBusy] = useState<"default" | "remove" | "clear" | "toggle" | "next" | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [editingApi, setEditingApi] = useState(false);
  const [editingProxy, setEditingProxy] = useState(false);
  const api = account.auth === "api";
  const details = piCardDetails(account);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const resets = account.usage?.resets ?? null;
  const credits = account.usage?.credits ?? null;
  const extraUsage = account.usage?.extraUsage ? formatExtraUsage(account.usage.extraUsage) : null;
  const plan = formatPlan(account.plan);
  const summary = usageSummary(account);
  const subtitle = accountSubtitle(account);
  const signedOut = account.status === "signed_out";
  const disabled = account.status === "disabled";
  const faded = disabled ? { opacity: 0.55 } : null;
  const windows = account.usage?.windows ?? [];
  const agents = account.agentCount === 0 ? "No agents" : `${account.agentCount} agent${account.agentCount === 1 ? "" : "s"}`;
  const freshness = !signedOut && account.usage && windows.length > 0 ? `updated ${formatAge(account.usage.fetchedAt)}` : null;

  // Sets the account aside for a while, or brings it back; its agents move off it and back.
  const toggle = useCallback(async () => {
    const enabling = account.status === "disabled";
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
      const removed = `Removed ${account.label}`;
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

  return (
    <Card theme={theme} fill>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <View style={faded}>
          <Avatar theme={theme} label={account.label} />
        </View>
        <View style={[{ flex: 1, minWidth: 0, gap: 3 }, faded]}>
          <Text style={text.strong} numberOfLines={1}>
            {account.label}
          </Text>
          {subtitle ? (
            <Text style={text.small} numberOfLines={1}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginTop: -4, marginRight: -6 }}>
          {account.status === "limited" ? (
            <IconButton
              theme={theme}
              icon="CircleCheck"
              label="Mark as available again (it has room)"
              tooltip="Mark as available: use it again before its limit resets, e.g. after upgrading"
              busy={busy === "clear"}
              onPress={() => void markAvailable()}
            />
          ) : null}
          {/* A pick waiting here can always be canceled, whatever has become of the account since. */}
          {account.nextAgentUntil || (!signedOut && !disabled) ? (
            <IconButton
              theme={theme}
              icon={account.nextAgentUntil ? "CircleX" : "SquarePlus"}
              label={account.nextAgentUntil ? "Cancel: next new agent goes back to the default" : "Use for the next new agent"}
              tooltip={
                account.nextAgentUntil
                  ? "Your next new agent starts here. Click to cancel"
                  : "Next new agent: the next agent you start (new workspace or tab) uses this account, once"
              }
              busy={busy === "next"}
              onPress={() => void nextAgent()}
            />
          ) : null}
          {!account.isDefault && !signedOut && !disabled ? (
            <IconButton
              theme={theme}
              icon="Star"
              label="Make default"
              tooltip="Make default: new agents start on this account"
              busy={busy === "default"}
              onPress={() => void makeDefault()}
            />
          ) : null}
          {/* No Pi account stands in for another, so one can't be disabled (see setAccountEnabled). */}
          {account.family === "pi" && !disabled ? null : (
            <IconButton
              theme={theme}
              icon={disabled ? "CirclePlay" : "CirclePause"}
              label={disabled ? "Enable account" : "Disable for now (agents won't use it)"}
              tooltip={
                disabled
                  ? "Enable: agents can use this account again"
                  : "Disable for now: agents stop using it and move to your other accounts"
              }
              busy={busy === "toggle"}
              onPress={() => void toggle()}
            />
          )}
          {account.apiEditable ? (
            <IconButton theme={theme} icon="KeyRound" label="API settings" tooltip="API settings: key and base URL" onPress={() => setEditingApi(true)} />
          ) : null}
          {account.proxyEditable ? (
            <IconButton theme={theme} icon="Globe" label="Proxy" tooltip="Proxy: the network this account uses" onPress={() => setEditingProxy(true)} />
          ) : null}
          <IconButton theme={theme} icon="Pencil" label="Rename" tooltip="Rename this account" onPress={() => setRenaming(true)} />
          {account.kind !== "main" ? (
            <IconButton
              theme={theme}
              icon="Trash2"
              label="Remove"
              tooltip={
                account.externalHome
                  ? "Remove from ZeroSub only: its folder, key and script stay"
                  : api
                    ? "Remove: delete its saved key"
                    : "Remove: sign it out and delete its saved login"
              }
              tone="danger"
              busy={busy === "remove"}
              onPress={() => setConfirmRemove(true)}
            />
          ) : null}
        </View>
      </View>

      <View style={[{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 6 }, faded]}>
        {account.isDefault ? <Badge theme={theme} label="Default" tone="accent" /> : null}
        {disabled ? <Badge theme={theme} label="Disabled" /> : null}
        {plan ? <Badge theme={theme} label={plan} /> : null}
        {api ? <Badge theme={theme} label="API" /> : null}
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
          <Text style={text.small}>{api ? "The key was refused. Enter a working one to use this account." : "Sign in again to use this account."}</Text>
        ) : api ? (
          <Text style={text.small}>Billed per use · used only as the default or when picked for an agent</Text>
        ) : windows.length > 0 ? (
          windows.map((limit) => <UsageBar key={limit.id} theme={theme} limit={limit} />)
        ) : (
          <Text style={text.small}>{account.usage?.error ?? summary ?? "Checking usage…"}</Text>
        )}
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
          <Button
            theme={theme}
            size="small"
            tone="primary"
            icon={api ? "KeyRound" : "LogIn"}
            label={api ? "Fix key" : "Sign in"}
            tooltip={api ? "Enter a working key for this account" : "Sign this account in again"}
            tooltipAlign="end"
            onPress={api ? () => setEditingApi(true) : onSignIn}
          />
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
      {editingApi ? <ApiKeyModal theme={theme} store={store} account={account} onClose={() => setEditingApi(false)} /> : null}
      {editingProxy ? <ProxyModal theme={theme} store={store} account={account} onClose={() => setEditingProxy(false)} /> : null}
      <Modal title={`Remove ${account.label}?`} open={confirmRemove} onOpenChange={setConfirmRemove}>
        <Modal.Content>
          <Text style={text.body}>
            {account.externalHome
              ? `This only removes the account from ZeroSub. Its folder${account.home ? ` (${account.home})` : ""}, its key${account.launcher ? ` and its terminal script ${account.launcher}` : ""} stay as they are, and you can add it back from Add account. Agents using it move to the default account; their conversations are kept.`
              : account.family === "pi"
                ? "This deletes the account's folder and saved key on this machine. Agents using it move to the default account; their conversations are kept."
                : account.family === "claude"
                  ? "This signs the account out on this machine and deletes its saved login. Agents using it move to the default account; their conversations are kept."
                  : "This signs the account out on this machine and deletes its saved login. New agents use the default account. Existing ChatGPT conversations on it can't move, so start new agents for them."}
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
                  : api
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
          hint="Sends a short follow-up so the interrupted task continues."
          value={settings.values.autoContinue}
          disabled={settings.saving || !settings.values.autoSwitch}
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
          hint="A stopped Claude chat carries on in a new ChatGPT or OpenCode agent (pick the destination below) with the conversation so far. ChatGPT gets a mode no looser than this agent's. OpenCode gets Plan or Build under the host's own permission policy, which can allow more than Claude does. The original stays as it was."
          value={settings.values.forkOtherProvider}
          disabled={settings.saving || !settings.values.autoSwitch}
          onValueChange={(forkOtherProvider) => save({ forkOtherProvider })}
        />
        <ForkDestinationRows values={settings.values} saving={settings.saving} onSave={save} />
      </SettingsCard>
      <Text style={text.heading} accessibilityRole="header">
        Continue on OpenCode
      </Text>
      <SettingsCard>
        <OpenCodeForkRows values={settings.values} saving={settings.saving} onSave={save} />
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

