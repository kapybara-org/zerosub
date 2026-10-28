import { openExternalUrl, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { formatAge } from "../shared/format";
import type { OmpAccountView, OmpView } from "../shared/model";
import { cancelOmpLogin, redeemOmpReset, removeOmpAccount, startOmpLogin, submitOmpLoginCode } from "../shared/rpc";
import { Row, Step, Waiting } from "./add-account";
import { resetBadge, resetDetail } from "./reset-confirm";
import { describe, useStore, type ZeroSubStore } from "./store";
import { Badge, Button, Card, IconButton, UsageBar, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

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
      {omp.error ? <Text style={text.warning}>{omp.error}</Text> : null}
      {omp.fetchedAt === null && !omp.error ? <Text style={text.muted}>Loading OMP accounts…</Text> : null}
      {omp.fetchedAt !== null && groups.length === 0 ? <Text style={text.muted}>No OMP accounts yet.</Text> : null}
      {groups.map(({ provider, accounts }) => {
        const rows: OmpAccountView[][] = [];
        for (let index = 0; index < accounts.length; index += perRow) rows.push(accounts.slice(index, index + perRow));
        return (
          <View key={provider.id} style={{ gap: 10 }}>
            <Text style={text.strong}>{provider.name}</Text>
            {rows.map((row) => (
              <View key={row.map((account) => account.credentialId).join()} style={{ flexDirection: "row", gap: 10 }}>
                {row.map((account) => (
                  <OmpAccountCard key={account.credentialId} account={account} theme={theme} store={store} />
                ))}
                {row.length < perRow ? <View style={{ flex: 1 }} /> : null}
              </View>
            ))}
          </View>
        );
      })}
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

function OmpAccountCard({ account, theme, store }: { account: OmpAccountView; theme: Theme; store: ZeroSubStore }) {
  const text = useText(theme);
  const toast = useToast();
  const [busy, setBusy] = useState<"remove" | "reset" | null>(null);
  const [confirm, setConfirm] = useState<"remove" | "reset" | null>(null);
  const ref = { provider: account.provider, credentialId: account.credentialId };

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
      {account.resets ? (
        <View style={{ flexDirection: "row" }}>
          <Badge theme={theme} label={resetBadge(account.resets)} tone="accent" />
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
