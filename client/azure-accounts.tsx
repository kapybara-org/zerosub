import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { azureUsageLines } from "../shared/format";
import type { AccountView, AzurePrice } from "../shared/model";
import { addAzureAccount, updateAzureAccount } from "../shared/rpc";
import { useInputStyle } from "./pi-accounts";
import { describe, type ZeroSubStore } from "./store";
import { Button, IconButton, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/**
 * Azure OpenAI accounts: ChatGPT (Codex) accounts that run Codex on an Azure OpenAI resource with an
 * API key. The key is typed here once and never comes back from the host; the app sees only its last
 * four characters.
 */

const ENDPOINT_PLACEHOLDER = "https://<resource>.openai.azure.com/openai/v1";

function Field({ theme, title, children }: { theme: Theme; title: string; children: ReactNode }) {
  const text = useText(theme);
  return (
    <View style={{ gap: 6 }}>
      <Text style={text.strong}>{title}</Text>
      {children}
    </View>
  );
}

/** The card's line about an Azure account: where it goes and which key it uses. */
export function azureCardDetails(account: AccountView): string | null {
  const azure = account.azure;
  if (!azure) return null;
  return `${azure.host} · Key${azure.keyHint ? ` …${azure.keyHint}` : ""}`;
}

/** This month's tokens and estimated cost, in place of the usage bars of a subscription account. */
export function AzureUsage({ theme, account }: { theme: Theme; account: AccountView }) {
  const text = useText(theme);
  if (!account.azure) return null;
  const { tokens, cost, note } = azureUsageLines(account.azure);
  return (
    <View style={{ gap: 4 }}>
      <Text style={text.small}>{tokens}</Text>
      <Text style={text.small}>{cost}</Text>
      {note ? <Text style={text.small}>{note}</Text> : null}
      <Text style={text.small}>Paid API · used by itself only when every ChatGPT account is at its limit, or when you pick it</Text>
    </View>
  );
}

interface PriceRow {
  model: string;
  input: string;
  cachedInput: string;
  output: string;
}

function toRows(prices: Readonly<Record<string, AzurePrice>>): PriceRow[] {
  const show = (value: number | null) => (value === null ? "" : String(value));
  return Object.entries(prices).map(([model, price]) => ({ model, input: show(price.input), cachedInput: show(price.cachedInput), output: show(price.output) }));
}

/** The table typed in, or the first problem with it. */
function fromRows(rows: readonly PriceRow[]): Record<string, AzurePrice> | string {
  const prices: Record<string, AzurePrice> = {};
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
    prices[model] = { input, cachedInput, output };
  }
  return prices;
}

/**
 * Adds an Azure OpenAI account (`account` absent), or changes one: its endpoint, its key (empty keeps
 * it) and the price table its cost is estimated from.
 */
export function AzureAccountModal({ theme, store, account, onClose }: { theme: Theme; store: ZeroSubStore; account?: AccountView; onClose(): void }) {
  const text = useText(theme);
  const toast = useToast();
  const inputStyle = useInputStyle(theme);
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
      let warning: string | null;
      if (account) {
        const prices = fromRows(rows);
        if (typeof prices === "string") throw new Error(prices);
        warning = (await store.rpc(updateAzureAccount, { accountId: account.id, endpoint: endpoint.trim(), key: key.trim() || undefined, prices })).warning;
      } else {
        warning = (await store.rpc(addAzureAccount, { label: label.trim(), endpoint: endpoint.trim(), key: key.trim() })).warning;
      }
      if (warning) toast.show(warning, { variant: "warning", durationMs: 8_000 });
      else toast.show(editing ? "Saved" : `Added ${label.trim()}`, { variant: "success" });
      await store.refresh();
      onClose();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setSaving(false);
    }
  }, [ready, account, rows, store, endpoint, key, label, toast, editing, onClose]);

  const input = (props: { value: string; onChangeText(value: string): void; placeholder: string; label: string; maxLength: number; secure?: boolean; autoFocus?: boolean; flex?: number }) => (
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
  const setRow = (index: number, patch: Partial<PriceRow>) => setRows((all) => all.map((row, at) => (at === index ? { ...row, ...patch } : row)));

  return (
    <Modal title={editing ? `${account?.label ?? "Azure"} · Azure OpenAI` : "Add Azure OpenAI account"} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
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
              placeholder: current ? `Leave empty to keep the current one${current.keyHint ? ` (…${current.keyHint})` : ""}; needed again for a new endpoint` : "Key 1 or Key 2 of the resource",
              label: "API key",
              maxLength: 4096,
              secure: true,
            })}
          </Field>
          {editing ? (
            <Field theme={theme} title="Prices (optional, USD per 1M tokens)">
              <Text style={text.small}>
                Per model (deployment name), for the cost estimate on the card. Empty prices show tokens only. Cached input without a price is
                counted at the input price.
              </Text>
              {rows.map((row, index) => (
                <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  {input({ value: row.model, onChangeText: (model) => setRow(index, { model }), placeholder: "Model", label: "Model", maxLength: 200, flex: 2 })}
                  {input({ value: row.input, onChangeText: (value) => setRow(index, { input: value }), placeholder: "Input", label: `Input price of ${row.model}`, maxLength: 12, flex: 1 })}
                  {input({ value: row.cachedInput, onChangeText: (value) => setRow(index, { cachedInput: value }), placeholder: "Cached", label: `Cached input price of ${row.model}`, maxLength: 12, flex: 1 })}
                  {input({ value: row.output, onChangeText: (value) => setRow(index, { output: value }), placeholder: "Output", label: `Output price of ${row.model}`, maxLength: 12, flex: 1 })}
                  <IconButton theme={theme} icon="Trash2" label="Remove price" tooltip="Remove this model's prices" onPress={() => setRows((all) => all.filter((_, at) => at !== index))} />
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
                  onPress={() => setRows((all) => [...all, { model: Object.keys(account?.azure?.usage?.models ?? {}).find((model) => !all.some((row) => row.model === model)) ?? "", input: "", cachedInput: "", output: "" }])}
                />
              </View>
            </Field>
          ) : null}
          <Text style={text.small}>
            Billed per token by Azure. ZeroSub moves ChatGPT agents onto it by itself only when every ChatGPT account is at its limit; you can always pick it
            for an agent, or make it the default. The key is checked against the endpoint and stays on this host, readable only by you.
          </Text>
          {error ? <Text style={text.danger}>{error}</Text> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" tooltip={editing ? "Keep the current settings" : "Close without adding an account"} tooltipAlign="end" onPress={onClose} />
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
      </Modal.Content>
    </Modal>
  );
}

/** Picks what kind of ChatGPT (Codex) account to add: a subscription sign-in, or an Azure OpenAI key. */
export function CodexKindStep({ theme, onSubscription, onAzure, onCancel }: { theme: Theme; onSubscription(): void; onAzure(): void; onCancel(): void }) {
  const text = useText(theme);
  return (
    <View style={{ gap: 12 }}>
      <Text style={text.muted}>What kind of account?</Text>
      <Button theme={theme} tone="primary" icon="LogIn" label="ChatGPT subscription (sign in)" tooltip="Sign in a ChatGPT Plus, Pro, Team or Business account" tooltipAlign="start" onPress={onSubscription} />
      <Button theme={theme} icon="KeyRound" label="Azure OpenAI (API key)" tooltip="Run Codex on an Azure OpenAI resource, billed per token, used last" tooltipAlign="start" onPress={onAzure} />
      <Text style={text.small}>An Azure OpenAI account is only used by itself once every ChatGPT subscription is at its limit.</Text>
      <View style={{ flexDirection: "row", justifyContent: "flex-end" }}>
        <Button theme={theme} label="Cancel" tooltip="Close without adding an account" tooltipAlign="end" onPress={onCancel} />
      </View>
    </View>
  );
}
