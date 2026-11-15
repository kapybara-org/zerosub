import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useState, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";
import type { AccountView, BedrockModels, BedrockSource } from "../shared/model";
import { addBedrockAccount, updateBedrockAccount } from "../shared/rpc";
import { PriceTable, fromRows, toRows, type PriceRow } from "./azure-accounts";
import { useInputStyle } from "./pi-accounts";
import { describe, type ZeroSubStore } from "./store";
import { Button, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/**
 * AWS Bedrock accounts: Claude accounts that run Claude Code on Amazon Bedrock with AWS credentials:
 * the host's own (an instance role, say), a named profile, or an access key kept on the host. A
 * secret typed here never comes back from the host.
 */

const SOURCE_LABEL: Record<BedrockSource, string> = {
  host: "Host's AWS credentials",
  profile: "AWS profile",
  keys: "Access key",
};

const MODEL_FIELDS: Array<{ field: keyof BedrockModels; title: string; placeholder: string }> = [
  { field: "model", title: "Default model (ANTHROPIC_MODEL)", placeholder: "e.g. global.anthropic.claude-sonnet-5-5" },
  { field: "opus", title: "Opus (ANTHROPIC_DEFAULT_OPUS_MODEL)", placeholder: "e.g. global.anthropic.claude-opus-5-5" },
  { field: "sonnet", title: "Sonnet (ANTHROPIC_DEFAULT_SONNET_MODEL)", placeholder: "e.g. global.anthropic.claude-sonnet-5-5" },
  { field: "haiku", title: "Haiku (ANTHROPIC_DEFAULT_HAIKU_MODEL)", placeholder: "e.g. global.anthropic.claude-haiku-5-5" },
];

function Field({ theme, title, children }: { theme: Theme; title: string; children: ReactNode }) {
  const text = useText(theme);
  return (
    <View style={{ gap: 6 }}>
      <Text style={text.strong}>{title}</Text>
      {children}
    </View>
  );
}

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

/** Adds an AWS Bedrock account (`account` absent), or changes one. */
export function BedrockAccountModal({
  theme,
  store,
  account,
  defaultRegion,
  onClose,
}: {
  theme: Theme;
  store: ZeroSubStore;
  account?: AccountView;
  /** The region the host's AWS setup names, for a new account. */
  defaultRegion?: string | null;
  onClose(): void;
}) {
  const text = useText(theme);
  const toast = useToast();
  const inputStyle = useInputStyle(theme);
  const current = account?.bedrock ?? null;
  const editing = Boolean(account);
  const [label, setLabel] = useState("");
  const [region, setRegion] = useState(current?.region ?? defaultRegion ?? "");
  const [source, setSource] = useState<BedrockSource>(current?.source ?? "host");
  const [profile, setProfile] = useState(current?.profile ?? "");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secret, setSecret] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [models, setModels] = useState<BedrockModels>(current?.models ?? { model: "", opus: "", sonnet: "", haiku: "" });
  const [rows, setRows] = useState<PriceRow[]>(() => toRows(current?.prices ?? {}));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Editing an access key: the stored ID is only shown by its hint, so a new ID needs typing in full.
  const keepsKey = editing && current?.source === "keys" && source === "keys" && !accessKeyId.trim();
  const credentialsReady =
    source === "host" || (source === "profile" ? Boolean(profile.trim()) : keepsKey || Boolean(accessKeyId.trim() && secret.trim()));
  const ready = Boolean(region.trim()) && credentialsReady && (editing || Boolean(label.trim()));

  const submit = useCallback(async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      const fields = {
        region: region.trim(),
        source,
        profile: source === "profile" ? profile.trim() : undefined,
        accessKeyId: source === "keys" && accessKeyId.trim() ? accessKeyId.trim() : undefined,
        secretAccessKey: source === "keys" && secret.trim() ? secret.trim() : undefined,
        sessionToken: source === "keys" && sessionToken.trim() ? sessionToken.trim() : undefined,
        models,
      };
      let warning: string | null;
      if (account) {
        const prices = fromRows(rows);
        if (typeof prices === "string") throw new Error(prices);
        warning = (await store.rpc(updateBedrockAccount, { accountId: account.id, ...fields, prices })).warning;
      } else {
        warning = (await store.rpc(addBedrockAccount, { label: label.trim(), ...fields })).warning;
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
  }, [ready, region, source, profile, accessKeyId, secret, sessionToken, models, account, rows, store, label, toast, editing, onClose]);

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
    <Modal title={editing ? `${account?.label ?? "Bedrock"} · AWS Bedrock` : "Add AWS Bedrock account"} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <View style={{ gap: 12 }}>
          {editing ? null : (
            <Field theme={theme} title="Name">
              {input({ value: label, onChangeText: setLabel, placeholder: "e.g. Bedrock", label: "Account name", maxLength: 40, autoFocus: true })}
            </Field>
          )}
          <Field theme={theme} title="AWS region">
            {input({ value: region, onChangeText: setRegion, placeholder: "e.g. eu-central-1", label: "AWS region", maxLength: 40 })}
          </Field>
          <Field theme={theme} title="Credentials">
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
              {(Object.keys(SOURCE_LABEL) as BedrockSource[]).map((option) => (
                <Pressable
                  key={option}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: source === option }}
                  onPress={() => setSource(option)}
                  style={{
                    paddingHorizontal: 10,
                    paddingVertical: 6,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: source === option ? theme.colors.accent : theme.colors.border,
                    backgroundColor: source === option ? theme.colors.surface2 : "transparent",
                  }}
                >
                  <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: source === option ? "600" : "400" }}>{SOURCE_LABEL[option]}</Text>
                </Pressable>
              ))}
            </View>
            {source === "host" ? (
              <Text style={text.small}>
                The AWS default chain on the host: its environment, ~/.aws, or an EC2 instance or ECS task role. Nothing is stored.
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
                {input({ value: sessionToken, onChangeText: setSessionToken, placeholder: "Session token (optional, for temporary credentials)", label: "Session token", maxLength: 4096, secure: true })}
                <Text style={text.small}>Kept only in the account's folder on this host, readable only by you; the app only ever sees the key ID's last four characters.</Text>
              </>
            )}
          </Field>
          <Field theme={theme} title="Models (optional)">
            <Text style={text.small}>
              Bedrock inference-profile IDs, like global.anthropic.claude-opus-5-5 or eu.anthropic.claude-sonnet-5-5. Empty uses Claude Code's own
              Bedrock defaults.
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
                Per model, as Claude Code names it in its session files, for the cost estimate on the card. Empty prices show tokens only. Cache reads or
                writes without a price are counted at the input price.
              </Text>
              <PriceTable theme={theme} rows={rows} onChange={setRows} cacheWrite used={Object.keys(current?.usage?.models ?? {})} />
            </Field>
          ) : null}
          <Text style={text.small}>
            Billed per token by AWS. ZeroSub moves Claude agents onto it by itself only when every Claude subscription account is at its limit, and back
            once one has room; you can always pick it for an agent, or make it the default. The credentials are checked with the host's aws command when
            it has one.
          </Text>
          {error ? <Text style={text.danger}>{error}</Text> : null}
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
            <Button theme={theme} label="Cancel" tooltip={editing ? "Keep the current settings" : "Close without adding an account"} tooltipAlign="end" onPress={onClose} />
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
      </Modal.Content>
    </Modal>
  );
}
