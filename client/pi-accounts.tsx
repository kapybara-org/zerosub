import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { HIDDEN, type AccountView } from "../shared/model";
import { addApiAccount, setAccountProxy, updateApiAccount } from "../shared/rpc";
import { describe, type ZeroSubStore } from "./store";
import { Button, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/**
 * Pi accounts: Pi's own login (`~/.pi/agent`), and added accounts, each an Anthropic API key with an
 * optional base URL and proxy in an agent directory of its own. Everything here is only shown for Pi.
 */

function useInputStyle(theme: Theme) {
  return useMemo(
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
}

function Field({ theme, title, children }: { theme: Theme; title: string; children: ReactNode }) {
  const text = useText(theme);
  return (
    <View style={{ gap: 6 }}>
      <Text style={text.strong}>{title}</Text>
      {children}
    </View>
  );
}

/** The card's line about the account: its key and where it goes, its proxy, and its folder. */
export function piCardDetails(account: AccountView): string | null {
  if (account.family !== "pi") return null;
  const api = account.api;
  const parts = [
    api ? `Key${api.keyHint ? ` …${api.keyHint}` : ""} · ${api.baseUrl ?? "Anthropic API"}` : null,
    account.proxy ? `Via ${account.proxy}` : null,
    account.kind === "managed" && account.home ? `Folder: ${account.home}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Above the Pi accounts: what they are, and what a proxy on them reaches. */
export function PiSectionNotes({ theme }: { theme: Theme }) {
  const text = useText(theme);
  return (
    <>
      <Text style={text.small}>
        Each added Pi account is an Anthropic API key, with its own base URL and proxy if you like. Its agents use that key for Claude models and
        share Pi's settings, sessions and other API keys; subscription sign-ins (/login) stay on the CLI login, which ZeroSub leaves as it is.
      </Text>
      <PiProxyNote theme={theme} />
    </>
  );
}

/** What a proxy set on a Pi card does and doesn't reach: it goes only to the agents ZeroSub routes to that account. */
function PiProxyNote({ theme }: { theme: Theme }) {
  const text = useText(theme);
  const points = [
    "Pi agents Paseo starts or reopens on the account get it as https_proxy, HTTPS_PROXY, http_proxy and HTTP_PROXY, ahead of httpProxy in Pi's settings. Every request they make goes through it, Anthropic's and other providers' alike; only localhost, 127.0.0.1 and ::1 stay direct.",
    "Agents already running keep the network they started with until they reopen.",
    "An account without a proxy of its own uses the network the daemon has, or httpProxy in Pi's settings.",
    "An agent whose routing doesn't answer in time (ZeroSub stopped, say) opens without it, on the CLI login.",
  ];
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 2 }}>
      <Icon name="Globe" size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={text.strong}>About proxies on Pi accounts</Text>
        {points.map((point) => (
          <Text key={point} style={text.small}>
            {`• ${point}`}
          </Text>
        ))}
      </View>
    </View>
  );
}

/**
 * A Pi account's key and base URL. Adding asks for a name and optional proxy too; editing keeps the
 * key unless a new one is typed, and the proxy has its own button on the card.
 */
function KeyForm({
  theme,
  store,
  account,
  onDone,
  onCancel,
}: {
  theme: Theme;
  store: ZeroSubStore;
  /** The account being edited; absent when adding one. */
  account?: AccountView;
  onDone(): void;
  onCancel(): void;
}) {
  const text = useText(theme);
  const inputStyle = useInputStyle(theme);
  const editing = Boolean(account);
  const current = account?.api ?? null;
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const [proxy, setProxy] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = editing ? true : Boolean(label.trim() && key.trim());
  const submit = useCallback(async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      if (account) await store.rpc(updateApiAccount, { accountId: account.id, key: key.trim() || undefined, baseUrl: baseUrl.trim() });
      else await store.rpc(addApiAccount, { label: label.trim(), key: key.trim(), baseUrl: baseUrl.trim() || undefined, proxy: proxy.trim() || undefined });
      await store.refresh();
      onDone();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setSaving(false);
    }
  }, [ready, account, store, key, baseUrl, label, proxy, onDone]);
  const input = (props: { value: string; onChangeText(value: string): void; placeholder: string; label: string; maxLength: number; secure?: boolean; autoFocus?: boolean }) => (
    <TextInput
      value={props.value}
      onChangeText={props.onChangeText}
      maxLength={props.maxLength}
      placeholder={props.placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      autoCapitalize="none"
      autoCorrect={false}
      autoFocus={props.autoFocus}
      secureTextEntry={props.secure}
      style={inputStyle}
      accessibilityLabel={props.label}
    />
  );
  return (
    <View style={{ gap: 12 }}>
      {editing ? null : (
        <Field theme={theme} title="Name">
          {input({ value: label, onChangeText: setLabel, placeholder: "e.g. Work key", label: "Account name", maxLength: 40, autoFocus: true })}
        </Field>
      )}
      <Field theme={theme} title="Anthropic API key">
        {input({
          value: key,
          onChangeText: setKey,
          placeholder: current ? `Leave empty to keep the current one${current.keyHint ? ` (…${current.keyHint})` : ""}; needed again for a new base URL` : "sk-ant-…",
          label: "API key",
          maxLength: 4096,
          secure: true,
        })}
      </Field>
      <Field theme={theme} title="Base URL (optional)">
        {input({ value: baseUrl, onChangeText: setBaseUrl, placeholder: "Empty: Anthropic's API · e.g. https://gateway.example.com", label: "Base URL", maxLength: 2048 })}
        {/^http:\/\//i.test(baseUrl.trim()) && !/^http:\/\/(localhost|127\.[\d.]+|\[::1\])(?=[:/]|$)/i.test(baseUrl.trim()) ? (
          <Text style={text.small}>Over http:// the key travels unencrypted. Use https:// unless the gateway is on a network you trust.</Text>
        ) : null}
      </Field>
      {editing ? null : (
        <Field theme={theme} title="Proxy (optional)">
          {input({ value: proxy, onChangeText: setProxy, placeholder: "http://127.0.0.1:7890", label: "Proxy URL", maxLength: 2048 })}
          <Text style={text.small}>Every request its Pi agents make goes through it, Anthropic's and other providers' alike.</Text>
        </Field>
      )}
      <Text style={text.small}>
        Billed per use, so ZeroSub never moves agents onto it by itself: it's used only as the default or when you pick it for an agent. The key stays on this host.
      </Text>
      {error ? <Text style={text.danger}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Button theme={theme} label="Cancel" tooltip={editing ? "Keep the current settings" : "Close without adding an account"} tooltipAlign="end" onPress={onCancel} />
        <Button
          theme={theme}
          tone="primary"
          label={editing ? "Save" : "Add account"}
          tooltip={editing ? "Save these settings" : "Add this Pi account"}
          tooltipAlign="end"
          busy={saving}
          disabled={!ready}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

/** Adds a Pi account: an Anthropic API key. */
export function AddPiAccountModal({ theme, store, onClose }: { theme: Theme; store: ZeroSubStore; onClose(): void }) {
  const toast = useToast();
  const done = () => {
    toast.show("Pi account added. Pick it from a Pi agent's account button, or make it the default.", { variant: "success" });
    onClose();
  };
  return (
    <Modal title="Add Pi API account" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <KeyForm theme={theme} store={store} onCancel={onClose} onDone={done} />
      </Modal.Content>
    </Modal>
  );
}

/** Changes an added Pi account's key or base URL from its card. */
export function ApiKeyModal({ theme, store, account, onClose }: { theme: Theme; store: ZeroSubStore; account: AccountView; onClose(): void }) {
  const toast = useToast();
  return (
    <Modal title={`API settings for ${account.label}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <KeyForm
          theme={theme}
          store={store}
          account={account}
          onCancel={onClose}
          onDone={() => {
            toast.show(`${account.label} updated. Agents started from now on use it.`, { variant: "success" });
            onClose();
          }}
        />
      </Modal.Content>
    </Modal>
  );
}

/** Sets or clears an added Pi account's proxy. */
export function ProxyModal({ theme, account, store, onClose }: { theme: Theme; account: AccountView; store: ZeroSubStore; onClose(): void }) {
  const text = useText(theme);
  const toast = useToast();
  const inputStyle = useInputStyle(theme);
  // The box starts with the current proxy, its password hidden: a change is only saved with the password typed in full.
  const current = account.proxy ?? "";
  const [proxy, setProxy] = useState(current);
  const typed = proxy.trim();
  const hidden = typed.includes(HIDDEN);
  const changed = typed !== "" && typed !== current && !hidden;
  const inherited = account.inheritedProxy;
  const [saving, setSaving] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(
    async (value: string) => {
      setSaving(value ? "save" : "clear");
      setError(null);
      try {
        const result = await store.rpc(setAccountProxy, { accountId: account.id, proxy: value });
        toast.show(result.proxy ? `${account.label} now uses ${result.proxy}` : `${account.label} no longer uses a proxy`, { variant: "success" });
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
  return (
    <Modal title={`Proxy for ${account.label}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={text.muted}>
          {account.proxy
            ? `Now: ${account.proxy}.`
            : inherited
              ? `Now: no proxy of its own; it goes through ${inherited.proxy}, set in ${inherited.from}.`
              : "Now: no proxy of its own; it uses the network the daemon has."}
          {" Its Pi agents started after saving use the new setting, for every request they make; running ones keep theirs until they reopen."}
        </Text>
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
        <Text style={text.small}>{hidden ? `${HIDDEN} hides the proxy's password: type it in full to save a change.` : "http:// or https://, with user:password@ if the proxy needs it."}</Text>
        {error ? <Text style={text.danger}>{error}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Cancel" tooltip="Keep the current proxy" tooltipAlign="end" onPress={onClose} />
          {account.proxy ? (
            <Button theme={theme} label="Remove proxy" tooltip="Stop using a proxy of its own" tooltipAlign="end" busy={saving === "clear"} onPress={() => void save("")} />
          ) : null}
          <Button theme={theme} tone="primary" label="Save" tooltip="Use this proxy for the account" tooltipAlign="end" busy={saving === "save"} disabled={!changed} onPress={() => void save(typed)} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
