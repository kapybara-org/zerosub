import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import { apiUsageLines } from "../shared/format";
import type { AccountView, ApiPrice, BedrockModels, BedrockSource } from "../shared/model";
import { addBedrockAccount, detectBedrockRegion, updateBedrockAccount } from "../shared/rpc";
import { SessionsSwitch } from "./sessions-switch";
import { describe, type ZeroSubStore } from "./store";
import { Button, IconButton, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/**
 * AWS Bedrock accounts: Claude accounts that run Claude Code on Amazon Bedrock with AWS credentials:
 * the host's own (an instance role, say), a named profile, or an access key kept on the host. A
 * secret typed here never comes back from the host; the app sees only the key ID's last four characters.
 */

const SOURCES: ReadonlyArray<{ value: BedrockSource; label: string }> = [
  { value: "host", label: "Host's AWS credentials" },
  { value: "profile", label: "AWS profile" },
  { value: "keys", label: "Access key" },
];

const MODEL_FIELDS: ReadonlyArray<{ field: keyof BedrockModels; title: string; placeholder: string }> = [
  { field: "model", title: "Default model (ANTHROPIC_MODEL)", placeholder: "e.g. global.anthropic.claude-sonnet-4-5-20250929-v1:0" },
  { field: "opus", title: "Opus (ANTHROPIC_DEFAULT_OPUS_MODEL)", placeholder: "Opus model or inference-profile ID" },
  { field: "sonnet", title: "Sonnet (ANTHROPIC_DEFAULT_SONNET_MODEL)", placeholder: "Sonnet model or inference-profile ID" },
  { field: "haiku", title: "Haiku (ANTHROPIC_DEFAULT_HAIKU_MODEL)", placeholder: "Haiku model or inference-profile ID" },
];

const REGION_FROM: Record<"environment" | "config" | "instance", string> = {
  environment: "From the daemon's AWS_REGION.",
  config: "From the host's ~/.aws/config.",
  instance: "From the EC2 instance the host runs on.",
};

/** The card's line about a Bedrock account: its region and where its credentials come from. */
export function bedrockCardDetails(account: AccountView): string | null {
  const bedrock = account.bedrock;
  if (!bedrock) return null;
  const source =
    bedrock.source === "profile"
      ? `profile ${bedrock.profile ?? ""}`.trim()
      : bedrock.source === "keys"
        ? `access key${bedrock.keyHint ? ` …${bedrock.keyHint}` : ""}`
        : "host's AWS credentials";
  return `${bedrock.region} · ${source}`;
}

/** This month's tokens and estimated cost, in place of the usage bars of a subscription account. */
export function BedrockUsage({ theme, account, paidFallback }: { theme: Theme; account: AccountView; paidFallback: boolean }) {
  const text = useText(theme);
  if (!account.bedrock) return null;
  const { tokens, cost, note } = apiUsageLines(account.bedrock);
  return (
    <View style={{ gap: 4 }}>
      <Text style={text.small}>{tokens}</Text>
      <Text style={text.small}>{cost}</Text>
      {note ? <Text style={text.small}>{note}</Text> : null}
      <Text style={text.small}>
        {paidFallback
          ? "Billed per token · used by itself only when every Claude subscription account is out, or when picked"
          : "Billed per token · used only as the default or when picked for an agent"}
      </Text>
    </View>
  );
}

interface PriceRow {
  model: string;
  input: string;
  cachedInput: string;
  cacheWrite: string;
  output: string;
}

function toRows(prices: Readonly<Record<string, ApiPrice>>): PriceRow[] {
  const show = (value: number | null) => (value === null ? "" : String(value));
  return Object.entries(prices).map(([model, price]) => ({
    model,
    input: show(price.input),
    cachedInput: show(price.cachedInput),
    cacheWrite: show(price.cacheWrite),
    output: show(price.output),
  }));
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
    const price = { input: parse(row.input), cachedInput: parse(row.cachedInput), cacheWrite: parse(row.cacheWrite), output: parse(row.output) };
    if (Object.values(price).some((value) => value === undefined)) return `Prices for ${model} must be numbers (USD per 1M tokens).`;
    prices[model] = price as ApiPrice;
  }
  return prices;
}

/**
 * The fields of an AWS Bedrock account. Adding asks for a name, the region (filled in from the host's
 * own AWS setup when it names one, looked up as the form opens), where the credentials come from and
 * optional model overrides; editing keeps a stored secret unless a new one is typed, and adds the
 * price table the card's cost estimate comes from.
 */
export function BedrockAccountForm({
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
  const current = account?.bedrock ?? null;
  const editing = Boolean(account);
  const [label, setLabel] = useState("");
  const [shareSessions, setShareSessions] = useState(false);
  const [region, setRegion] = useState(current?.region ?? "");
  const [regionNote, setRegionNote] = useState<string | null>(null);
  const [source, setSource] = useState<BedrockSource>(current?.source ?? "host");
  const [profile, setProfile] = useState(current?.profile ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [models, setModels] = useState<BedrockModels>(current?.models ?? { model: "", opus: "", sonnet: "", haiku: "" });
  const [rows, setRows] = useState<PriceRow[]>(() => toRows(current?.prices ?? {}));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The region was typed in, so a lookup answering late leaves it alone. */
  const regionTyped = useRef(editing);

  // The host's region is only looked up here, as the form opens: it can take a moment (an EC2 host's
  // comes from its metadata service), and the field stays editable meanwhile.
  useEffect(() => {
    if (editing) return;
    let live = true;
    setRegionNote("Looking up the host's AWS region…");
    store
      .rpc(detectBedrockRegion, {})
      .then((found) => {
        if (!live) return;
        if (found.region && found.source && !regionTyped.current) {
          setRegion(found.region);
          setRegionNote(REGION_FROM[found.source]);
        } else setRegionNote(null);
      })
      .catch(() => live && setRegionNote(null));
    return () => {
      live = false;
    };
  }, [editing, store]);

  // Editing an access key: the stored ID is only shown by its hint, so a new ID needs its secret too.
  const keepsKey = editing && current?.source === "keys" && source === "keys" && !accessKeyId.trim();
  const credentialsReady =
    source === "host" || (source === "profile" ? Boolean(profile.trim()) : keepsKey || Boolean(accessKeyId.trim() && secret.trim()));
  const ready = Boolean(region.trim()) && credentialsReady && (editing || Boolean(label.trim()));

  const submit = useCallback(async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      const keys = source === "keys";
      const fields = {
        region: region.trim(),
        source,
        profile: source === "profile" ? profile.trim() : undefined,
        accessKeyId: keys && accessKeyId.trim() ? accessKeyId.trim() : undefined,
        secretAccessKey: keys && secret.trim() ? secret.trim() : undefined,
        sessionToken: keys && sessionToken.trim() ? sessionToken.trim() : undefined,
        models,
      };
      if (account) {
        const prices = fromRows(rows);
        if (typeof prices === "string") throw new Error(prices);
        const result = await store.rpc(updateBedrockAccount, { accountId: account.id, ...fields, prices });
        await store.refresh();
        onDone(account.id, result.warning);
      } else {
        const result = await store.rpc(addBedrockAccount, { label: label.trim(), ...fields, shareSessions: shareSessions || undefined });
        await store.refresh();
        onDone(result.accountId, result.warning);
      }
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setSaving(false);
    }
  }, [ready, region, source, profile, accessKeyId, secret, sessionToken, models, account, rows, store, label, shareSessions, onDone]);

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
          {input({ value: label, onChangeText: setLabel, placeholder: "e.g. Bedrock", label: "Account name", maxLength: 40, autoFocus: true })}
        </Field>
      )}
      <Field theme={theme} title="AWS region">
        {input({
          value: region,
          onChangeText: (value) => {
            regionTyped.current = true;
            setRegion(value);
          },
          placeholder: "e.g. us-east-1",
          label: "AWS region",
          maxLength: 40,
        })}
        {regionNote ? <Text style={text.small}>{regionNote}</Text> : null}
      </Field>
      <Field theme={theme} title="Credentials">
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {SOURCES.map((option) => (
            <Pressable
              key={option.value}
              accessibilityRole="radio"
              accessibilityState={{ checked: source === option.value }}
              accessibilityLabel={option.label}
              onPress={() => setSource(option.value)}
              style={{
                paddingHorizontal: 10,
                paddingVertical: 6,
                borderRadius: 8,
                borderWidth: 1,
                borderColor: source === option.value ? theme.colors.accent : theme.colors.border,
                backgroundColor: source === option.value ? theme.colors.surface2 : "transparent",
              }}
            >
              <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: source === option.value ? "600" : "400" }}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
        {source === "host" ? (
          <Text style={text.small}>
            The AWS default chain on the host: the daemon's environment, ~/.aws, or an EC2 instance or ECS task role. Nothing is stored.
          </Text>
        ) : source === "profile" ? (
          <>
            {input({ value: profile, onChangeText: setProfile, placeholder: "Profile name in the host's ~/.aws config", label: "AWS profile", maxLength: 128 })}
            <Text style={text.small}>Only the profile's name is stored; its credentials stay in ~/.aws.</Text>
          </>
        ) : (
          <>
            {input({
              value: accessKeyId,
              onChangeText: setAccessKeyId,
              placeholder: current?.keyHint ? `Leave empty to keep …${current.keyHint}` : "Access key ID (AKIA… or ASIA…)",
              label: "Access key ID",
              maxLength: 128,
            })}
            {input({
              value: secret,
              onChangeText: setSecret,
              placeholder: keepsKey ? "Leave empty to keep the current secret" : "Secret access key",
              label: "Secret access key",
              maxLength: 1024,
              secure: true,
            })}
            {input({
              value: sessionToken,
              onChangeText: setSessionToken,
              placeholder: keepsKey && current?.sessionToken ? "Leave empty to keep the current session token" : "Session token (optional, for temporary credentials)",
              label: "Session token",
              maxLength: 4096,
              secure: true,
            })}
            <Text style={text.small}>Kept only in the account's folder on this host, readable only by you.</Text>
          </>
        )}
      </Field>
      <Field theme={theme} title="Models (optional)">
        <Text style={text.small}>
          Bedrock model or inference-profile IDs, as enabled in your AWS account. Empty uses Claude Code's own Bedrock defaults.
        </Text>
        {MODEL_FIELDS.map(({ field, title, placeholder }) => (
          <View key={field} style={{ gap: 4 }}>
            <Text style={text.small}>{title}</Text>
            {input({ value: models[field], onChangeText: (value) => setModels((all) => ({ ...all, [field]: value })), placeholder, label: title, maxLength: 200 })}
          </View>
        ))}
      </Field>
      {editing ? (
        <Field theme={theme} title="Prices (optional, USD per 1M tokens)">
          <Text style={text.small}>
            Per model, as Claude Code names it in its session files, for the cost estimate on the card. Without prices the card shows tokens only.
            Cache reads or writes without a price count at the input price.
          </Text>
          {rows.map((row, index) => (
            <View key={index} style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              {cell(index, "model", "Model", 2)}
              {cell(index, "input", "Input", 1)}
              {cell(index, "cachedInput", "Cache read", 1)}
              {cell(index, "cacheWrite", "Cache write", 1)}
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
                setRows((all) => [
                  ...all,
                  { model: used.find((model) => !all.some((row) => row.model === model)) ?? "", input: "", cachedInput: "", cacheWrite: "", output: "" },
                ])
              }
            />
          </View>
        </Field>
      ) : null}
      {editing ? null : <SessionsSwitch value={shareSessions} onValueChange={setShareSessions} />}
      <Text style={text.small}>
        {paidFallback
          ? "Billed per token by AWS. With paid API accounts turned on, ZeroSub moves Claude agents onto it by itself only when every Claude subscription account is out, and back once one has room; you can always pick it for an agent or make it the default."
          : "Billed per token by AWS, so ZeroSub never moves agents onto it by itself: it's used only as the default or when you pick it for an agent."}{" "}
        The credentials are checked with the host's aws command when it has one.
      </Text>
      {error ? <Text style={text.danger}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Button theme={theme} label="Cancel" tooltip={editing ? "Keep the current settings" : "Close without adding an account"} tooltipAlign="end" onPress={onCancel} />
        <Button
          theme={theme}
          tone="primary"
          label={editing ? "Save" : "Add account"}
          tooltip={editing ? "Save these settings" : "Check the credentials and add this account"}
          tooltipAlign="end"
          busy={saving}
          disabled={!ready}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

/** Edits an AWS Bedrock account from its card: region, credentials, models and prices. */
export function BedrockAccountModal({
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
    <Modal title={`Bedrock settings for ${account.label}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <BedrockAccountForm
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
