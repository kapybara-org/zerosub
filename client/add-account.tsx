import { openExternalUrl, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { formatPlan } from "../shared/format";
import { FAMILY_LABEL, type Family, type LoginMethod, type LoginView } from "../shared/model";
import { cancelLogin, startLogin, submitLoginCode } from "../shared/rpc";
import { describe, useStore, type ZeroSubStore } from "./store";
import { Button, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

export function AddAccountModal({
  theme,
  layout,
  host,
  multiHost,
  store,
  family,
  accountId,
  onClose,
}: {
  theme: Theme;
  layout: PluginSurfaceProps["layout"];
  host: PluginSurfaceProps["host"];
  /** The app knows several hosts, so say which one gets the account. */
  multiHost: boolean;
  store: ZeroSubStore;
  family: Family;
  accountId?: string;
  onClose(): void;
}) {
  const text = useText(theme);
  const { state } = useStore(store);
  // A browser sign-in finishes by redirecting to `localhost` on the host's computer, so it only
  // works from a browser there, and never on hosts without a desktop (servers, containers).
  // Phones start with a code; the browser stays on offer for someone at the host's computer.
  const mobile = layout.platform === "ios" || layout.platform === "android";
  const hostBrowser = state?.browserSignIn !== false;
  const [method, setMethod] = useState<LoginMethod>(hostBrowser && !mobile ? "browser" : "code");
  const [loginId, setLoginId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // Each start gets a number; only the newest one's answer counts.
  const attempt = useRef(0);
  const closed = useRef(false);

  const begin = useCallback(
    async (next: LoginMethod) => {
      const mine = ++attempt.current;
      setStartError(null);
      setLoginId(null);
      try {
        const login = await store.rpc(startLogin, { family, accountId, method: next });
        // The modal closed (or a newer start replaced this one) before the daemon answered.
        if (closed.current || mine !== attempt.current) {
          void store.rpc(cancelLogin, { loginId: login.id }).catch(() => undefined);
          return;
        }
        setLoginId(login.id);
      } catch (error) {
        if (!closed.current && mine === attempt.current) setStartError(describe(error));
      }
    },
    [store, family, accountId],
  );

  useEffect(() => {
    if (attempt.current === 0) void begin(method);
  }, [begin, method]);

  useEffect(() => store.watchClosely(), [store]);

  const login = state?.logins.find((entry) => entry.id === loginId) ?? null;
  const account = login?.accountId ? state?.accounts.find((entry) => entry.id === login.accountId) : undefined;
  const finished = login ? login.step === "done" || login.step === "failed" || login.step === "canceled" : false;

  const close = useCallback(() => {
    closed.current = true;
    if (loginId && !finished) void store.rpc(cancelLogin, { loginId }).catch(() => undefined);
    onClose();
  }, [loginId, finished, store, onClose]);

  // Claude's flow serves both links at once; ChatGPT needs a fresh flow to switch.
  const switchMethod = useCallback(
    (next: LoginMethod) => {
      setMethod(next);
      if (family === "codex") void begin(next);
    },
    [family, begin],
  );

  const title = accountId ? "Sign in again" : `Add ${FAMILY_LABEL[family]} account`;
  let body: ReactNode;
  if (startError) {
    body = (
      <>
        <Text style={text.danger}>{startError}</Text>
        <Row>
          <Button theme={theme} label="Close" tooltip="Close without adding an account" tooltipAlign="end" onPress={close} />
          <Button
            theme={theme}
            tone="primary"
            icon="RefreshCw"
            label="Try again"
            tooltip="Start the sign-in again"
            tooltipAlign="end"
            onPress={() => void begin(method)}
          />
        </Row>
      </>
    );
  } else if (!login || login.step === "starting") {
    body = <Waiting theme={theme} label="Preparing sign-in…" />;
  } else if (login.step === "waiting") {
    body = (
      <SignInSteps
        theme={theme}
        store={store}
        login={login}
        family={family}
        method={method}
        browserUsable={hostBrowser}
        onSwitch={switchMethod}
      />
    );
  } else if (login.step === "verifying") {
    body = <Waiting theme={theme} label="Checking your account…" />;
  } else if (login.step === "done") {
    const who = account
      ? `${account.label}${account.email && account.email !== account.label ? ` (${account.email})` : ""}${
          account.plan ? ` · ${formatPlan(account.plan)}` : ""
        }`
      : "The account";
    body = (
      <>
        <Text style={text.heading}>You're signed in</Text>
        <Text style={text.body}>
          {who} is ready. New {FAMILY_LABEL[family]} agents{multiHost ? ` on ${host.label}` : ""} can use it, and you can
          move an agent to it from the account button in the message box.
        </Text>
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
            onPress={() => void begin(method)}
          />
        </Row>
      </>
    );
  }

  return (
    <Modal title={title} open onOpenChange={(open) => (open ? undefined : close())}>
      <Modal.Content>
        {multiHost && !accountId && login?.step !== "done" ? (
          <Text style={text.small}>Adds the account on {host.label} only. Other hosts sign in separately.</Text>
        ) : null}
        {body}
      </Modal.Content>
    </Modal>
  );
}

function SignInSteps({
  theme,
  store,
  login,
  family,
  method,
  browserUsable,
  onSwitch,
}: {
  theme: Theme;
  store: ZeroSubStore;
  login: LoginView;
  family: Family;
  method: LoginMethod;
  /** A browser on the host's computer can finish the sign-in, so offer that route too. */
  browserUsable: boolean;
  onSwitch(method: LoginMethod): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [codeError, setCodeError] = useState<string | null>(null);

  // Claude: the browser link completes by itself; the code link works from any device.
  const pasteFlow = family === "claude" && (method === "code" || !login.url) && Boolean(login.codeUrl);
  const link = pasteFlow ? login.codeUrl : login.url ?? login.codeUrl;

  const open = useCallback(() => {
    if (link) void openExternalUrl(link).catch((error: unknown) => toast.error(describe(error)));
  }, [link, toast]);
  const copy = useCallback(
    async (value: string, what: string) => {
      try {
        await copyText(value);
        toast.show(`${what} copied`, { variant: "success" });
      } catch {
        toast.error("Couldn't copy. Select the text and copy it yourself.");
      }
    },
    [toast],
  );
  const submit = useCallback(async () => {
    const value = code.trim();
    if (!value) return;
    setSubmitting(true);
    setCodeError(null);
    try {
      await store.rpc(submitLoginCode, { loginId: login.id, code: value });
    } catch (error) {
      setCodeError(describe(error));
    } finally {
      setSubmitting(false);
    }
  }, [code, login.id, store]);

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

  const service = family === "claude" ? "Claude" : "ChatGPT";
  const canSwitch = browserUsable && (family === "codex" || (Boolean(login.url) && Boolean(login.codeUrl)));
  return (
    <View style={{ gap: 16 }}>
      <Step theme={theme} number={1} title={`Open the ${service} sign-in page`}>
        <Text style={text.muted}>
          {pasteFlow || login.userCode
            ? "Sign in with the account you want to add. This works on any device, including your phone."
            : "Sign in with the account you want to add, using a browser on the host's own computer. It finishes by itself."}
        </Text>
        <Row start>
          <Button
            theme={theme}
            tone="primary"
            icon="ExternalLink"
            label="Open sign-in page"
            tooltip={`Open the ${service} sign-in page in your browser`}
            tooltipAlign="start"
            disabled={!link}
            onPress={open}
          />
          {link ? (
            <Button
              theme={theme}
              icon="Copy"
              label="Copy link"
              tooltip="Copy the sign-in link, for example to open it on another device"
              tooltipAlign="start"
              onPress={() => void copy(link, "Link")}
            />
          ) : null}
        </Row>
      </Step>

      {login.userCode ? (
        <Step theme={theme} number={2} title="Enter this code on that page">
          <Text selectable style={text.mono}>
            {login.userCode}
          </Text>
          <Row start>
            <Button
              theme={theme}
              icon="Copy"
              label="Copy code"
              tooltip="Copy the code to enter on the sign-in page"
              tooltipAlign="start"
              onPress={() => void copy(login.userCode ?? "", "Code")}
            />
          </Row>
          <Text style={text.small}>
            If the page says code sign-in is off, turn on device code sign-in in ChatGPT → Settings → Security (or ask
            your workspace admin), then try again.
          </Text>
        </Step>
      ) : null}

      {pasteFlow ? (
        <Step theme={theme} number={2} title="Paste the code shown after you sign in">
          <TextInput
            value={code}
            onChangeText={setCode}
            placeholder="Paste code"
            placeholderTextColor={theme.colors.foregroundMuted}
            autoCapitalize="none"
            autoCorrect={false}
            onSubmitEditing={() => void submit()}
            style={inputStyle}
            accessibilityLabel="Sign-in code"
          />
          {codeError ? <Text style={text.danger}>{codeError}</Text> : null}
          <Row start>
            <Button
              theme={theme}
              tone="primary"
              label="Continue"
              tooltip="Finish signing in with the pasted code"
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

      {canSwitch ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => onSwitch(method === "code" ? "browser" : "code")}
          style={{ alignSelf: "flex-start", paddingVertical: 4 }}
        >
          <Text style={{ color: theme.colors.accent, fontSize: 13, fontWeight: "600" }}>
            {method === "code" ? "At the host's computer? Use its browser instead" : "On a different device? Use a code instead"}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function Step({ theme, number, title, children }: { theme: Theme; number: number; title: string; children: ReactNode }) {
  const text = useText(theme);
  return (
    <View style={{ flexDirection: "row", gap: 12 }}>
      <View
        style={{
          width: 24,
          height: 24,
          borderRadius: 12,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: theme.colors.surface2,
        }}
      >
        <Text style={{ color: theme.colors.foreground, fontSize: 12, fontWeight: "700" }}>{number}</Text>
      </View>
      <View style={{ flex: 1, gap: 8 }}>
        <Text style={text.strong}>{title}</Text>
        {children}
      </View>
    </View>
  );
}

function Waiting({ theme, label }: { theme: Theme; label: string }) {
  const text = useText(theme);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 }}>
      <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      <Text style={text.muted}>{label}</Text>
    </View>
  );
}

function Row({ children, start }: { children: ReactNode; start?: boolean }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: start ? "flex-start" : "flex-end" }}>
      {children}
    </View>
  );
}
