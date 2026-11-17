import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { apiUsageLines } from "../shared/format";
import type { AccountView, ApiPrice } from "../shared/model";
import { addAzureAccount, updateAzureAccount } from "../shared/rpc";
import { describe, type ZeroSubStore } from "./store";
import { Button, IconButton, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/**
 * Azure OpenAI accounts: ChatGPT (Codex) accounts that run Codex on an Azure OpenAI resource with an
 * API key. The key is typed here and never comes back from the host; the app sees only its last four
 * characters.
 */

const ENDPOINT_PLACEHOLDER = "https://<resource>.openai.azure.com/openai/v1";

/** The card's line about an Azure account: where it goes and which key it uses. */
export function azureCardDetails(account: AccountView): string | null {
  const azure = account.azure;
  if (!azure) return null;
  return `${azure.host} · Key${azure.keyHint ? ` …${azure.keyHint}` : ""}`;
}

/** This month's tokens and estimated cost, in place of the usage bars of a subscription account. */
export function AzureUsage({ theme, account, paidFallback }: { theme: Theme; account: AccountView; paidFallback: boolean }) {
  const text = useText(theme);
  if (!account.azure) return null;
  const { tokens, cost, note } = apiUsageLines(account.azure);
  return (
    <View style={{ gap: 4 }}>
      <Text style={text.small}>{tokens}</Text>
      <Text style={text.small}>{cost}</Text>
      {note ? <Text style={text.small}>{note}</Text> : null}
      <Text style={text.small}>
        {paidFallback
          ? "Billed per token · used by itself only when every ChatGPT subscription account is out, or when picked"
          : "Billed per token · used only as the default or when picked for an agent"}
      </Text>
    </View>
  );
}

interface PriceRow {
  model: string;
  input: string;
  cachedInput: string;
  output: string;
}

function toRows(prices: Readonly<Record<string, ApiPrice>>): PriceRow[] {
  const show = (value: number | null) => (value === null ? "" : String(value));
  return Object.entries(prices).map(([model, price]) => ({ model, input: show(price.input), cachedInput: show(price.cachedInput), output: show(price.output) }));
}

/** The table typed in, or the first problem with it. */
function fromRows(rows: readonly PriceRow[]): Record<string, ApiPrice> | string {
  const prices: Record<string, ApiPrice> = {};
  for (const row of rows) {
    const model = row.model.trim();
    if (!model) continue;
    const parse = (value: string): number | null | undefined => {
      if (!value.trim()) return null;
      const number = Number(value.trim());
      return Number.isFinite(number) && number >= 0 ? number : undefined;
    };
    const input = parse(row.input);
    const cachedInput = parse(row.cachedInput);
    const output = parse(row.output);
    if (input === undefined || cachedInput === undefined || output === undefined) return `Prices for ${model} must be numbers (USD per 1M tokens).`;
    // Azure OpenAI has no cache writes.
    prices[model] = { input, cachedInput, cacheWrite: null, output };
  }
  return prices;
}

/**
 * The fields of an Azure OpenAI account. Adding asks for a name, the endpoint and the key; editing
 * keeps the key unless a new one is typed (a new endpoint needs it again), and adds the price table
 * the card's cost estimate comes from.
 */
export function AzureAccountForm({
  theme,
  store,
  account,
  paidFallback,
  onDone,
  onCancel,
}: {
  theme: Theme;
  store: ZeroSubStore;
  /** The account being edited; absent when adding one. */
  account?: AccountView;
  /** Paid API accounts may take work over by themselves once every subscription is out. */
  paidFallback: boolean;
  onDone(accountId: string, warning: string | null): void;
  onCancel(): void;
}) {
  const text = useText(theme);
  const current = account?.azure ?? null;
  const editing = Boolean(account);
  const [label, setLabel] = useState("");
  const [endpoint, setEndpoint] = useState(current?.endpoint ?? "");
  const [key, setKey] = useState("");
  const [rows, setRows] = useState<PriceRow[]>(() => toRows(current?.prices ?? {}));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = editing ? Boolean(endpoint.trim()) : Boolean(label.trim() && endpoint.trim() && key.trim());

  const submit = useCallback(async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      if (account) {
        const prices = fromRows(rows);
        if (typeof prices === "string") throw new Error(prices);
        const result = await store.rpc(updateAzureAccount, { accountId: account.id, endpoint: endpoint.trim(), key: key.trim() || undefined, prices });
        await store.refresh();
        onDone(account.id, result.warning);
      } else {
        const result = await store.rpc(addAzureAccount, { label: label.trim(), endpoint: endpoint.trim(), key: key.trim() });
        await store.refresh();
        onDone(result.accountId, result.warning);
      }
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setSaving(false);
    }
  }, [ready, account, rows, store, endpoint, key, label, onDone]);

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
    flex?: number;
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
      style={props.flex ? [inputStyle, { flex: props.flex, minWidth: 0 }] : inputStyle}
      accessibilityLabel={props.label}
    />
  );
  const cell = (index: number, field: keyof PriceRow, placeholder: string, flex: number) =>
    input({
      value: rows[index]![field],
      onChangeText: (value) => setRows((all) => all.map((row, at) => (at === index ? { ...row, [field]: value } : row))),
      placeholder,
      label: field === "model" ? "Model" : `${placeholder} price of ${rows[index]!.model}`,
      maxLength: field === "model" ? 200 : 12,
      flex,
    });
  const used = Object.keys(current?.usage?.models ?? {});

  return (
    <View style={{ gap: 12 }}>
      {editing ? null : (
        <Field theme={theme} title="Name">
          {input({ value: label, onChangeText: setLabel, placeholder: "e.g. Azure", label: "Account name", maxLength: 40, autoFocus: true })}
        </Field>
      )}
      <Field theme={theme} title="Endpoint">
        {input({ value: endpoint, onChangeText: setEndpoint, placeholder: ENDPOINT_PLACEHOLDER, label: "Endpoint URL", maxLength: 2048 })}
        <Text style={text.small}>Your resource's v1 API, https:// only. A bare resource URL gets /openai/v1 added.</Text>
      </Field>
      <Field theme={theme} title="API key">
        {input({
          value: key,
          onChangeText: setKey,
          placeholder: current
            ? `Leave empty to keep the current one${current.keyHint ? ` (…${current.keyHint})` : ""}; needed again for a new endpoint`
            : "Key 1 or Key 2 of the resource",
          label: "API key",
          maxLength: 4096,
          secure: true,
        })}
      </Field>
      {editing ? (
        <Field theme={theme} title="Prices (optional, USD per 1M tokens)">
          <Text style={text.small}>
            Per model (deployment name), for the cost estimate on the card. Without prices the card shows tokens only. Cached input
            without a price counts at the input price.
          </Text>
          {rows.map((row, index) => (
            <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {cell(index, "model", "Model", 2)}
              {cell(index, "input", "Input", 1)}
              {cell(index, "cachedInput", "Cached", 1)}
              {cell(index, "output", "Output", 1)}
              <IconButton
                theme={theme}
                icon="Trash2"
                label="Remove price"
                tooltip="Remove this model's prices"
                onPress={() => setRows((all) => all.filter((_, at) => at !== index))}
              />
            </View>
          ))}
          <View style={{ flexDirection: "row" }}>
            <Button
              theme={theme}
              size="small"
              icon="Plus"
              label="Add model"
              tooltip="Add prices for another model"
              tooltipAlign="start"
              onPress={() =>
                setRows((all) => [...all, { model: used.find((model) => !all.some((row) => row.model === model)) ?? "", input: "", cachedInput: "", output: "" }])
              }
            />
          </View>
        </Field>
      ) : null}
      <Text style={text.small}>
        {paidFallback
          ? "Billed per token by Azure. With paid API accounts turned on, ZeroSub moves ChatGPT agents onto it by itself only when every ChatGPT subscription account is out; you can always pick it for an agent or make it the default."
          : "Billed per token by Azure, so ZeroSub never moves agents onto it by itself: it's used only as the default or when you pick it for an agent."}{" "}
        The key is checked against the endpoint and stays on this host, readable only by you.
      </Text>
      {error ? <Text style={text.danger}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Button theme={theme} label="Cancel" tooltip={editing ? "Keep the current settings" : "Close without adding an account"} tooltipAlign="end" onPress={onCancel} />
        <Button
          theme={theme}
          tone="primary"
          label={editing ? "Save" : "Add account"}
          tooltip={editing ? "Save these settings" : "Check the key and add this account"}
          tooltipAlign="end"
          busy={saving}
          disabled={!ready}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

/** Edits an Azure OpenAI account from its card: endpoint, key and prices. */
export function AzureAccountModal({
  theme,
  store,
  account,
  paidFallback,
  onClose,
}: {
  theme: Theme;
  store: ZeroSubStore;
  account: AccountView;
  paidFallback: boolean;
  onClose(): void;
}) {
  const toast = useToast();
  return (
    <Modal title={`Azure settings for ${account.label}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <AzureAccountForm
          theme={theme}
          store={store}
          account={account}
          paidFallback={paidFallback}
          onCancel={onClose}
          onDone={(_, warning) => {
            if (warning) toast.show(warning, { variant: "warning", durationMs: 8_000 });
            else toast.show(`${account.label} updated. Agents started from now on use it.`, { variant: "success" });
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
