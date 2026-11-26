import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useState } from "react";
import { Text, View } from "react-native";
import { CodexFastUntilSchema, codexFastExpiresAt } from "../shared/codex-fast-date";
import type { AccountView } from "../shared/model";
import { setCodexFastUntil } from "../shared/rpc";
import { useInputStyle } from "./pi-accounts";
import { describe, type ZeroSubStore } from "./store";
import { Button, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/** Sets or clears a ChatGPT subscription account's Fast mode end date. */
export function CodexFastModal({ theme, account, store, onClose }: { theme: Theme; account: AccountView; store: ZeroSubStore; onClose(): void }) {
  const text = useText(theme);
  const toast = useToast();
  const inputStyle = useInputStyle(theme);
  const current = account.codexFastUntil ?? "";
  const [date, setDate] = useState(current);
  const typed = date.trim();
  const valid = CodexFastUntilSchema.safeParse(typed).success;
  const changed = valid && typed !== "" && typed !== current;
  const [saving, setSaving] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(
    async (value: string) => {
      setSaving(value ? "save" : "clear");
      setError(null);
      try {
        await store.rpc(setCodexFastUntil, { accountId: account.id, until: value });
        toast.show(value ? `Fast mode date saved for ${account.label}` : `Fast mode date cleared for ${account.label}`, { variant: "success" });
        onClose();
      } catch (failure) {
        setError(describe(failure));
      } finally {
        setSaving(null);
      }
    },
    [account.id, account.label, store, toast, onClose],
  );
  return (
    <Modal title={`Fast mode for ${account.label}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={text.muted}>Eligible agents on this account use Fast through the end of that day in UTC when usage allows. Fast typically uses more of the account’s included usage.</Text>
        {current && Date.now() >= codexFastExpiresAt(current) ? <Text style={text.muted}>The saved date has passed.</Text> : null}
        <TextInput
          value={date}
          onChangeText={setDate}
          autoFocus
          maxLength={10}
          placeholder="YYYY-MM-DD"
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!saving}
          onSubmitEditing={() => (changed && !saving ? void save(typed) : undefined)}
          style={inputStyle}
          accessibilityLabel="Fast mode until"
        />
        {typed !== "" && !valid ? <Text style={text.danger}>Use a real date as YYYY-MM-DD, e.g. 2026-12-31.</Text> : null}
        {error ? <Text style={text.danger}>{error}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Cancel" tooltip="Keep the current Fast mode date" tooltipAlign="end" onPress={onClose} />
          {current ? (
            <Button
              theme={theme}
              label="Clear"
              tooltip="Turn Fast mode off for this account"
              tooltipAlign="end"
              busy={saving === "clear"}
              disabled={saving !== null}
              onPress={() => void save("")}
            />
          ) : null}
          <Button
            theme={theme}
            tone="primary"
            label="Save"
            tooltip="Run this account's agents in Fast mode through this date"
            tooltipAlign="end"
            busy={saving === "save"}
            disabled={!changed || saving !== null}
            onPress={() => void save(typed)}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
}
