import { openExternalUrl, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSelect } from "@getpaseo/plugin/client/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { formatAge } from "../shared/format";
import type { OmpAccountView, OmpSettings, OmpView } from "../shared/model";
import {
  cancelOmpLogin,
  preferOmpAccount,
  redeemOmpReset,
  removeOmpAccount,
  setOmpReserve,
  setOmpSettings,
  startOmpLogin,
  submitOmpLoginCode,
} from "../shared/rpc";
import { Row, Step, Waiting } from "./add-account";
import { resetBadge, resetDetail } from "./reset-confirm";
import { describe, useStore, type ZeroSubStore } from "./store";
import { Badge, Button, Card, IconButton, UsageBar, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

const RESERVE_CHOICES = [0, 5, 10, 20, 30, 50];

/** OMP's own accounts. OMP balances its agents across them and moves off one at its limit by itself. */
export function OmpSection({
  omp,
  theme,
  compact,
  store,
  hostLabel,
}: {
  omp: OmpView;
  theme: Theme;
  compact: boolean;
  store: ZeroSubStore;
  /** Set when the app knows several hosts, so the sign-in says which one gets the account. */
  hostLabel: string | null;
}) {
  const text = useText(theme);
  const [adding, setAdding] = useState(false);
  const groups = omp.providers
    .map((provider) => ({ provider, accounts: omp.accounts.filter((account) => account.provider === provider.id) }))
    .filter((group) => group.accounts.length > 0);
  const perRow = compact ? 1 : 2;
  const defaultReserve = typeof omp.defaults["retry.usageReservePct"] === "number" ? omp.defaults["retry.usageReservePct"] : 10;

  return (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <Text style={text.heading} accessibilityRole="header">
          Oh My Pi (OMP)
        </Text>
        <Button
          theme={theme}
          icon="Plus"
          label={compact ? "Add" : "Add account"}
          accessibilityLabel="Add OMP account"
          tooltip="Sign another account in to OMP"
          tooltipAlign="end"
          onPress={() => setAdding(true)}
        />
      </View>
      <Text style={text.muted}>
        OMP keeps its own sign-ins and spreads its agents across them, moving off an account that runs out by itself.
      </Text>
      <Text style={text.small}>
        Prefer and reserve apply to OMP agents Paseo starts on this host, from their next start. OMP can still pick
        another account, for example when it can't read the preferred one's usage.
      </Text>
      {omp.policiesLocked ? (
        <Text style={text.warning}>
          Your OMP config sets its own account policies (auth.accountPolicies), so ZeroSub leaves preferences and reserves
          to it.
        </Text>
      ) : null}
      {omp.error ? <Text style={text.warning}>{omp.error}</Text> : null}
      {omp.fetchedAt === null && !omp.error ? <Text style={text.muted}>Loading OMP accounts…</Text> : null}
      {omp.fetchedAt !== null && groups.length === 0 ? <Text style={text.muted}>No OMP accounts yet.</Text> : null}
      {groups.map(({ provider, accounts }) => {
        const rows: OmpAccountView[][] = [];
        for (let index = 0; index < accounts.length; index += perRow) rows.push(accounts.slice(index, index + perRow));
        return (
          <View key={provider.id} style={{ gap: 10 }}>
            <Text style={text.strong}>{provider.name}</Text>
            {omp.preview
              .filter((entry) => entry.provider === provider.id)
              .map((entry) => (
                <Text key={entry.model} style={text.small}>
                  {`New agents on ${entry.model} go to ${entry.accounts.map((account) => `${account.label} ${account.percent}%`).join(", ") || "no account"}`}
                </Text>
              ))}
            {rows.map((row) => (
              <View key={row.map((account) => account.credentialId).join()} style={{ flexDirection: "row", gap: 10 }}>
                {row.map((account) => (
                  <OmpAccountCard
                    key={account.credentialId}
                    account={account}
                    theme={theme}
                    store={store}
                    controls={account.controllable && !omp.policiesLocked ? { defaultReserve } : null}
                  />
                ))}
                {row.length < perRow ? <View style={{ flex: 1 }} /> : null}
              </View>
            ))}
          </View>
        );
      })}
      {omp.fetchedAt !== null ? <OmpSettingsCard omp={omp} theme={theme} store={store} /> : null}
      {adding ? (
        <OmpSignIn
          theme={theme}
          store={store}
          providers={omp.providers}
          hostLabel={hostLabel}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </View>
  );
}

function OmpAccountCard({
  account,
  theme,
  store,
  controls,
}: {
  account: OmpAccountView;
  theme: Theme;
  store: ZeroSubStore;
  /** Null when ZeroSub can't set this account's preferences. */
  controls: { defaultReserve: number } | null;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [busy, setBusy] = useState<"remove" | "reset" | "prefer" | null>(null);
  const [confirm, setConfirm] = useState<"remove" | "reset" | null>(null);
  const ref = { provider: account.provider, credentialId: account.credentialId };

  const prefer = async () => {
    setBusy("prefer");
    try {
      await store.rpc(preferOmpAccount, { ...ref, preferred: !account.preferred });
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setBusy(null);
    }
  };

  const setReserve = (value: string) => {
    store
      .rpc(setOmpReserve, { ...ref, reservePct: value === "default" ? null : Number(value) })
      .catch((error: unknown) => toast.error(describe(error)));
  };

  const remove = async () => {
    setBusy("remove");
    try {
      await store.rpc(removeOmpAccount, ref);
      toast.show(`Signed ${account.label} out of OMP`, { variant: "success" });
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  const redeem = async () => {
    setBusy("reset");
    try {
      const result = await store.rpc(redeemOmpReset, ref);
      if (result.ok) toast.show(result.message, { variant: "success", durationMs: 5_000 });
      else toast.error(result.message);
    } catch (error) {
      toast.error(describe(error));
    } finally {
      setBusy(null);
      setConfirm(null);
    }
  };

  return (
    <Card theme={theme} fill>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 12 }}>
        <Text style={[text.strong, { flex: 1, minWidth: 0 }]} numberOfLines={1}>
          {account.label}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 2, marginTop: -4, marginRight: -6 }}>
          {controls ? (
            <IconButton
              theme={theme}
              icon="Star"
              label={account.preferred ? "Stop preferring" : "Prefer for new OMP agents"}
              tooltip={
                account.preferred
                  ? "Stop preferring: OMP spreads new agents by itself again"
                  : "Prefer: new OMP agents start on this account while it has room"
              }
              busy={busy === "prefer"}
              onPress={() => void prefer()}
            />
          ) : null}
          <IconButton
            theme={theme}
            icon="Trash2"
            label="Remove"
            tooltip="Remove: sign it out of OMP on this machine"
            tone="danger"
            busy={busy === "remove"}
            onPress={() => setConfirm("remove")}
          />
        </View>
      </View>
      {account.preferred || account.resets ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {account.preferred ? <Badge theme={theme} label="Preferred" tone="accent" /> : null}
          {account.resets ? <Badge theme={theme} label={resetBadge(account.resets)} tone="accent" /> : null}
        </View>
      ) : null}
      <View style={{ gap: 10 }}>
        {account.windows.length > 0 ? (
          account.windows.map((limit) => <UsageBar key={limit.id} theme={theme} limit={limit} />)
        ) : (
          <Text style={text.small}>OMP has no usage reading for this account yet.</Text>
        )}
        {account.windows.length > 0 && account.usageAt ? (
          <Text style={text.small}>{`Read by OMP ${formatAge(account.usageAt)}`}</Text>
        ) : null}
        {account.resets?.blockedReason ? <Text style={text.small}>{account.resets.blockedReason}</Text> : null}
        {controls ? (
          <SettingsSelect
            label="Keep in reserve"
            hint="OMP moves agents off this account before this much is left."
            value={account.reservePct === null ? "default" : String(account.reservePct)}
            options={[
              { label: `OMP default (${controls.defaultReserve}%)`, value: "default" },
              ...RESERVE_CHOICES.map((pct) => ({ label: `${pct}%`, value: String(pct) })),
            ]}
            onValueChange={setReserve}
          />
        ) : null}
      </View>
      {account.resets ? (
        <View style={{ marginTop: "auto", paddingTop: 10, borderTopWidth: 1, borderTopColor: theme.colors.border, alignItems: "flex-end" }}>
          <Button
            theme={theme}
            size="small"
            icon="TimerReset"
            label="Use reset"
            accessibilityLabel="Use a banked reset"
            tooltip="Spend a banked reset to refill this account's limits now"
            tooltipAlign="end"
            disabled={!account.resets.usableNow}
            onPress={() => setConfirm("reset")}
          />
        </View>
      ) : null}

      <Modal title={`Remove ${account.label}?`} open={confirm === "remove"} onOpenChange={(open) => setConfirm(open ? "remove" : null)}>
        <Modal.Content>
          <Text style={text.body}>
            This signs the account out of OMP on this machine. OMP agents carry on with its other accounts.
          </Text>
          <Row>
            <Button theme={theme} label="Cancel" tooltip="Keep this account" tooltipAlign="end" onPress={() => setConfirm(null)} />
            <Button
              theme={theme}
              tone="danger"
              icon="Trash2"
              label="Remove"
              tooltip="Sign it out of OMP"
              tooltipAlign="end"
              busy={busy === "remove"}
              onPress={() => void remove()}
            />
          </Row>
        </Modal.Content>
      </Modal>
      <Modal title="Use a banked reset?" open={confirm === "reset"} onOpenChange={(open) => setConfirm(open ? "reset" : null)}>
        <Modal.Content>
          <Text style={text.body}>
            {`Spend one banked reset on ${account.label}${account.resets?.label ? ` (${account.resets.label})` : ""}. `}
            A reset can't be undone.
          </Text>
          {account.resets ? <Text style={text.small}>{resetDetail(account.resets)}</Text> : null}
          <Row>
            <Button theme={theme} label="Cancel" tooltip="Keep the reset" tooltipAlign="end" onPress={() => setConfirm(null)} />
            <Button
              theme={theme}
              tone="primary"
              icon="TimerReset"
              label="Use reset"
              tooltip="Refill this account's limits now"
              tooltipAlign="end"
              busy={busy === "reset"}
              onPress={() => void redeem()}
            />
          </Row>
        </Modal.Content>
      </Modal>
    </Card>
  );
}

type SettingKey = keyof OmpSettings;

/** ZeroSub's choices for OMP's settings; `words` names OMP's own values for the "OMP default" option. */
const SETTING_ROWS: Array<{ key: SettingKey; label: string; hint: string; words: Record<string, string> }> = [
  {
    key: "retry.usageReservePolicy",
    label: "When every account is down to its reserve",
    hint: "What OMP does once no account has room left above its reserve.",
    words: { confirm: "Ask first", auto: "Use the reserve", "fail-closed": "Stop" },
  },
  {
    key: "retry.waitForUsageReset",
    label: "When an agent hits a limit",
    hint: "Waiting holds the agent, and its subagents, until the limit resets.",
    words: { true: "Wait for the reset", false: "Stop with an error" },
  },
  {
    key: "codexResets.autoRedeem",
    label: "Use banked ChatGPT resets automatically",
    hint: "When an agent is stuck and no other account can take over, and for resets about to expire.",
    words: { yes: "Yes", no: "No", unset: "Ask before the first one" },
  },
  {
    key: "codexResets.keepCredits",
    label: "ChatGPT resets to keep",
    hint: "Automatic use never goes below this many, except for resets about to expire.",
    words: { 0: "None", 1: "1", 2: "2", 3: "3" },
  },
  {
    key: "claudeResets.autoRedeem",
    label: "Use banked Claude resets automatically",
    hint: "Only for the limits a reset covers.",
    words: { yes: "Yes", no: "No", unset: "Ask before the first one" },
  },
  {
    key: "claudeResets.keepCredits",
    label: "Claude resets to keep",
    hint: "Automatic use never goes below this many, except for resets about to expire.",
    words: { 0: "None", 1: "1", 2: "2", 3: "3" },
  },
];

/** OMP settings for the OMP agents Paseo starts on this host; "OMP default" leaves OMP's own config in charge. */
function OmpSettingsCard({ omp, theme, store }: { omp: OmpView; theme: Theme; store: ZeroSubStore }) {
  const text = useText(theme);
  const toast = useToast();
  const save = (key: SettingKey, raw: string) => {
    const next: Record<string, unknown> = { ...omp.settings };
    if (raw === "default") delete next[key];
    else next[key] = raw === "true" ? true : raw === "false" ? false : /^\d+$/.test(raw) ? Number(raw) : raw;
    store.rpc(setOmpSettings, { settings: next as OmpSettings }).catch((error: unknown) => toast.error(describe(error)));
  };
  return (
    <View style={{ gap: 10 }}>
      <Text style={text.strong}>How OMP uses these accounts</Text>
      <SettingsCard>
        {SETTING_ROWS.map((row) => {
          const current = omp.settings[row.key];
          const fallback = omp.defaults[row.key];
          const fallbackWord = fallback === undefined ? "not set" : row.words[String(fallback)] ?? String(fallback);
          return (
            <SettingsSelect
              key={row.key}
              label={row.label}
              hint={row.hint}
              value={current === undefined ? "default" : String(current)}
              options={[
                { label: `OMP default (${fallbackWord})`, value: "default" },
                ...Object.entries(row.words)
                  .filter(([value]) => value !== "unset")
                  .map(([value, label]) => ({ label, value })),
              ]}
              onValueChange={(value) => save(row.key, value)}
            />
          );
        })}
      </SettingsCard>
    </View>
  );
}

function OmpSignIn({
  theme,
  store,
  providers,
  hostLabel,
  onClose,
}: {
  theme: Theme;
  store: ZeroSubStore;
  providers: Array<{ id: string; name: string }>;
  hostLabel: string | null;
  onClose(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const { state } = useStore(store);
  const [loginId, setLoginId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);
  const closed = useRef(false);
  const login = state?.omp?.logins.find((entry) => entry.id === loginId) ?? null;
  const finished = login ? login.step === "done" || login.step === "failed" || login.step === "canceled" : false;

  useEffect(() => store.watchClosely(), [store]);

  const begin = useCallback(
    async (provider: string) => {
      setStartError(null);
      setCode("");
      try {
        const started = await store.rpc(startOmpLogin, { provider });
        if (closed.current) void store.rpc(cancelOmpLogin, { loginId: started.id }).catch(() => undefined);
        else setLoginId(started.id);
      } catch (error) {
        if (!closed.current) setStartError(describe(error));
      }
    },
    [store],
  );

  const close = useCallback(() => {
    closed.current = true;
    if (loginId && !finished) void store.rpc(cancelOmpLogin, { loginId }).catch(() => undefined);
    onClose();
  }, [loginId, finished, store, onClose]);

  const submit = useCallback(async () => {
    const value = code.trim();
    if (!value || !loginId) return;
    setSubmitting(true);
    setCodeError(null);
    try {
      await store.rpc(submitOmpLoginCode, { loginId, code: value });
      setCode("");
    } catch (error) {
      setCodeError(describe(error));
    } finally {
      setSubmitting(false);
    }
  }, [code, loginId, store]);

  const inputStyle = useMemo(
    () => ({
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    }),
    [theme],
  );

  const providerName = providers.find((provider) => provider.id === login?.provider)?.name ?? login?.provider ?? "OMP";
  let body: ReactNode;
  if (startError) {
    body = (
      <>
        <Text style={text.danger}>{startError}</Text>
        <Row>
          <Button theme={theme} label="Close" tooltip="Close without adding an account" tooltipAlign="end" onPress={close} />
        </Row>
      </>
    );
  } else if (!loginId) {
    body = (
      <>
        <Text style={text.muted}>Which provider is the account for?</Text>
        <View style={{ gap: 8 }}>
          {providers.map((provider) => (
            <Button
              key={provider.id}
              theme={theme}
              label={provider.name}
              tooltip={`Sign in to ${provider.name} through OMP`}
              tooltipAlign="start"
              onPress={() => void begin(provider.id)}
            />
          ))}
        </View>
      </>
    );
  } else if (!login || login.step === "starting") {
    body = <Waiting theme={theme} label="Preparing sign-in…" />;
  } else if (login.step === "waiting") {
    const url = login.url;
    body = (
      <View style={{ gap: 16 }}>
        <Step theme={theme} number={1} title={`Open the ${providerName} sign-in page`}>
          <Text style={text.muted}>Sign in with the account you want to add.</Text>
          {login.instructions ? <Text style={text.small}>{login.instructions}</Text> : null}
          <Row start>
            <Button
              theme={theme}
              tone="primary"
              icon="ExternalLink"
              label="Open sign-in page"
              tooltip="Open the sign-in page in your browser"
              tooltipAlign="start"
              disabled={!url}
              onPress={() => {
                if (url) void openExternalUrl(url).catch((error: unknown) => toast.error(describe(error)));
              }}
            />
            {url ? (
              <Button
                theme={theme}
                icon="Copy"
                label="Copy link"
                tooltip="Copy the sign-in link, for example to open it on another device"
                tooltipAlign="start"
                onPress={() =>
                  void copyText(url).then(
                    () => toast.show("Link copied", { variant: "success" }),
                    () => toast.error("Couldn't copy. Select the text and copy it yourself."),
                  )
                }
              />
            ) : null}
          </Row>
        </Step>
        {login.codePrompt ? (
          <Step theme={theme} number={2} title="Not on the host's computer? Paste what the page shows">
            <Text style={text.small}>
              On the host's computer the sign-in finishes by itself. Anywhere else, paste the code, or the address of the
              page that failed to load after signing in.
            </Text>
            <TextInput
              value={code}
              onChangeText={setCode}
              placeholder={login.codePrompt}
              placeholderTextColor={theme.colors.foregroundMuted}
              autoCapitalize="none"
              autoCorrect={false}
              onSubmitEditing={() => void submit()}
              style={inputStyle}
              accessibilityLabel="Sign-in code or redirect URL"
            />
            {codeError ? <Text style={text.danger}>{codeError}</Text> : null}
            <Row start>
              <Button
                theme={theme}
                tone="primary"
                label="Continue"
                tooltip="Finish signing in with what you pasted"
                tooltipAlign="start"
                busy={submitting}
                disabled={!code.trim()}
                onPress={() => void submit()}
              />
            </Row>
          </Step>
        ) : (
          <Waiting theme={theme} label="Waiting for you to finish signing in…" />
        )}
        {login.message ? <Text style={text.small}>{login.message}</Text> : null}
      </View>
    );
  } else if (login.step === "verifying") {
    body = <Waiting theme={theme} label="Checking your account…" />;
  } else if (login.step === "done") {
    body = (
      <>
        <Text style={text.heading}>You're signed in</Text>
        <Text style={text.body}>OMP agents{hostLabel ? ` on ${hostLabel}` : ""} can use the account now.</Text>
        <Row>
          <Button theme={theme} tone="primary" label="Done" tooltip="Close this window" tooltipAlign="end" onPress={onClose} />
        </Row>
      </>
    );
  } else {
    body = (
      <>
        <Text style={login.step === "failed" ? text.danger : text.muted}>
          {login.message ?? (login.step === "canceled" ? "Sign-in was canceled." : "Sign-in failed.")}
        </Text>
        <Row>
          <Button theme={theme} label="Close" tooltip="Close without adding an account" tooltipAlign="end" onPress={close} />
          <Button
            theme={theme}
            tone="primary"
            icon="RefreshCw"
            label="Try again"
            tooltip="Start the sign-in again"
            tooltipAlign="end"
            onPress={() => void begin(login.provider)}
          />
        </Row>
      </>
    );
  }

  return (
    <Modal title="Add OMP account" open onOpenChange={(open) => (open ? undefined : close())}>
      <Modal.Content>
        {hostLabel && login?.step !== "done" ? (
          <Text style={text.small}>Adds the account to OMP on {hostLabel} only. Other hosts sign in separately.</Text>
        ) : null}
        {body}
      </Modal.Content>
    </Modal>
  );
}
