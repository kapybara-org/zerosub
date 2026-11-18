import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { SettingsCard, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import type { AccountView, ApiKeyKind, TrafficSwitches } from "../shared/model";
import { addApiAccount, updateApiAccount } from "../shared/rpc";
import { describe, type ZeroSubStore } from "./store";
import { Button, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

const KEY_KINDS: readonly { label: string; value: ApiKeyKind }[] = [
  { label: "API key (x-api-key)", value: "api_key" },
  { label: "Auth token (Authorization: Bearer)", value: "auth_token" },
];

/**
 * The fields of an API account. Adding asks for a name, key and optional proxy too; editing keeps
 * the key unless a new one is typed, and the proxy has its own button on the card. A Pi account
 * takes an Anthropic API key and base URL only: Claude Code's traffic switches don't apply to Pi.
 */
export function ApiAccountForm({
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
  onDone(accountId: string): void;
  onCancel(): void;
}) {
  const text = useText(theme);
  const editing = Boolean(account);
  const current = account?.api ?? null;
  const [label, setLabel] = useState("");
  const [keyKind, setKeyKind] = useState<ApiKeyKind>(current?.keyKind ?? "api_key");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const [proxy, setProxy] = useState("");
  const [switches, setSwitches] = useState<TrafficSwitches>({
    disableTelemetry: current?.disableTelemetry ?? false,
    disableErrorReporting: current?.disableErrorReporting ?? false,
    disableNonessentialTraffic: current?.disableNonessentialTraffic ?? false,
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (field: keyof TrafficSwitches) => (value: boolean) => setSwitches((previous) => ({ ...previous, [field]: value }));

  const ready = editing ? true : Boolean(label.trim() && key.trim());
  const submit = useCallback(async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      const fields = { keyKind, baseUrl: baseUrl.trim(), ...switches };
      if (account) {
        await store.rpc(updateApiAccount, { accountId: account.id, ...fields, key: key.trim() || undefined });
        await store.refresh();
        onDone(account.id);
      } else {
        const result = await store.rpc(addApiAccount, {
          ...fields,
          family: "claude",
          label: label.trim(),
          key: key.trim(),
          proxy: proxy.trim() || undefined,
        });
        await store.refresh();
        onDone(result.accountId);
      }
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setSaving(false);
    }
  }, [ready, keyKind, baseUrl, switches, account, store, key, label, proxy, onDone]);

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
  const input = (props: {
    value: string;
    onChangeText(value: string): void;
    placeholder: string;
    label: string;
    /** As long as the RPC takes, so a longer value can't be typed in only to be refused. */
    maxLength: number;
    secure?: boolean;
    autoFocus?: boolean;
  }) => (
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
          {input({ value: label, onChangeText: setLabel, placeholder: "e.g. API or Gateway", label: "Account name", maxLength: 40, autoFocus: true })}
        </Field>
      )}
      <SettingsCard>
        <SettingsSelect<ApiKeyKind> label="Key type" value={keyKind} options={KEY_KINDS} onValueChange={(value) => setKeyKind(value)} />
      </SettingsCard>
      <Field theme={theme} title={keyKind === "api_key" ? "API key" : "Auth token"}>
        {input({
          value: key,
          onChangeText: setKey,
          placeholder: current
            ? `Leave empty to keep the current one${current.keyHint ? ` (…${current.keyHint})` : ""}; needed again for a new base URL`
            : "sk-ant-…",
          label: keyKind === "api_key" ? "API key" : "Auth token",
          maxLength: 4096,
          secure: true,
        })}
      </Field>
      <Field theme={theme} title="Base URL (optional)">
        {input({
          value: baseUrl,
          onChangeText: setBaseUrl,
          placeholder: "Empty: Anthropic's API · e.g. https://gateway.example.com",
          label: "Base URL",
          maxLength: 2048,
        })}
        {/^http:\/\//i.test(baseUrl.trim()) && !/^http:\/\/(localhost|127\.[\d.]+|\[::1\])(?=[:/]|$)/i.test(baseUrl.trim()) ? (
          <Text style={text.small}>
            Over http:// the key travels unencrypted. Use https:// unless the gateway is on a network you trust.
          </Text>
        ) : null}
      </Field>
      {editing ? null : (
        <Field theme={theme} title="Proxy (optional)">
          {input({ value: proxy, onChangeText: setProxy, placeholder: "http://127.0.0.1:7890", label: "Proxy URL", maxLength: 2048 })}
        </Field>
      )}
      <View style={{ gap: 6 }}>
        <Text style={text.strong}>Traffic to Anthropic</Text>
        <Text style={text.small}>
          Each is off unless you turn it on. With a base URL, model requests go there either way; these decide what else
          Claude Code sends to Anthropic directly.
        </Text>
        <SettingsCard>
          <SettingsSwitch
            label="Turn off telemetry"
            hint="DISABLE_TELEMETRY: no usage analytics or feature-flag fetches."
            value={switches.disableTelemetry}
            onValueChange={toggle("disableTelemetry")}
          />
          <SettingsSwitch
            label="Turn off error reporting"
            hint="DISABLE_ERROR_REPORTING: no crash reports."
            value={switches.disableErrorReporting}
            onValueChange={toggle("disableErrorReporting")}
          />
          <SettingsSwitch
            label="Turn off all nonessential traffic"
            hint="CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: only model requests go out. Also stops telemetry, error reports, auto-updates, plugin downloads and similar extras."
            value={switches.disableNonessentialTraffic}
            onValueChange={toggle("disableNonessentialTraffic")}
          />
        </SettingsCard>
      </View>
      <Text style={text.small}>
        Billed per use, so ZeroSub never moves agents onto it by itself: it's used only as the default or when you pick it
        for an agent. The key stays on this host.
      </Text>
      {error ? <Text style={text.danger}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Button theme={theme} label="Cancel" tooltip={editing ? "Keep the current settings" : "Close without adding an account"} tooltipAlign="end" onPress={onCancel} />
        <Button
          theme={theme}
          tone="primary"
          label={editing ? "Save" : "Add account"}
          tooltip={editing ? "Save these settings" : "Add this API account"}
          tooltipAlign="end"
          busy={saving}
          disabled={!ready}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

/** Edits an API account from its card. */
export function ApiAccountModal({
  theme,
  store,
  account,
  onClose,
}: {
  theme: Theme;
  store: ZeroSubStore;
  account: AccountView;
  onClose(): void;
}) {
  const toast = useToast();
  return (
    <Modal title={`API settings for ${account.label}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <ApiAccountForm
          theme={theme}
          store={store}
          account={account}
          onCancel={onClose}
          onDone={() => {
            toast.show(`${account.label} updated. Agents and terminal sessions started from now on use it.`, { variant: "success" });
            onClose();
          }}
        />
      </Modal.Content>
    </Modal>
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
