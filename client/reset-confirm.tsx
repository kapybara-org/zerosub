import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useState, type ComponentType } from "react";
import { Text, View } from "react-native";
import type { AccountView, ResetOffer } from "../shared/model";
import { redeemReset, type RedeemResult } from "../shared/rpc";
import { describe, type ZeroSubStore } from "./store";
import { Button, useText } from "./ui";

type Theme = PluginHostProps["theme"];

function formatDay(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  return Number.isNaN(at.getTime()) ? null : at.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function list(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** "2 left · use by Sep 30". */
export function resetDetail(resets: ResetOffer): string {
  const until = formatDay(resets.expiresAt);
  return `${resets.available} left${until ? ` · use by ${until}` : ""}`;
}

/** "1 reset · use by Oct 23". */
export function resetBadge(resets: ResetOffer): string {
  const until = formatDay(resets.expiresAt);
  return `${resets.available} reset${resets.available === 1 ? "" : "s"}${until ? ` · use by ${until}` : " banked"}`;
}

/**
 * Confirmation for spending a banked reset. A reset is scarce and can't be undone, so the user
 * always confirms it here, whether they came from the account card or an agent's account button.
 */
export function ResetConfirm({
  theme,
  store,
  account,
  agentId,
  onFinished,
  onCancel,
}: {
  theme: Theme;
  store: ZeroSubStore;
  account: AccountView;
  /** The agent stopped by this account's limit; it carries on after the reset. */
  agentId?: string;
  onFinished(result: RedeemResult): void;
  onCancel(): void;
}) {
  const text = useText(theme);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resets = account.usage?.resets ?? null;

  const confirm = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      onFinished(await store.rpc(redeemReset, { accountId: account.id, agentId }));
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setBusy(false);
    }
  }, [store, account.id, agentId, onFinished]);

  if (!resets) {
    return (
      <View style={{ gap: 12 }}>
        <Text style={text.body}>{account.label} has no banked resets right now.</Text>
        <Button theme={theme} label="Close" tooltip="Close this window" tooltipAlign="end" onPress={onCancel} />
      </View>
    );
  }
  const refills = resets.refills.length > 0 ? `your ${list(resets.refills)} limits` : "your usage limits";
  return (
    <View style={{ gap: 12 }}>
      <Text style={text.body}>
        Refills {refills} on {account.label} now{agentId ? ", then this agent carries on" : ""}. A reset can't be undone.
      </Text>
      <Text style={text.muted}>{resetDetail(resets)}</Text>
      {resets.blockedReason ? <Text style={text.warning}>{resets.blockedReason}</Text> : null}
      {error ? <Text style={text.danger}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Button theme={theme} label="No, keep it" tooltip="Keep the reset for later" tooltipAlign="end" onPress={onCancel} disabled={busy} />
        <Button
          theme={theme}
          tone="primary"
          icon="TimerReset"
          label="Yes, use my reset"
          tooltip="Spend one banked reset now; it can't be undone"
          tooltipAlign="end"
          busy={busy}
          disabled={!resets.usableNow}
          onPress={() => void confirm()}
        />
      </View>
    </View>
  );
}

/** The confirmation as popover content for an agent's account button. */
export function resetPopover(store: ZeroSubStore, account: AccountView, agentId: string): ComponentType<PluginButtonContentProps> {
  return function ResetPopover({ theme, close }: PluginButtonContentProps) {
    const toast = useToast();
    const text = useText(theme);
    return (
      <View style={{ gap: 12, maxWidth: 360 }}>
        <Text style={text.heading}>Use a banked reset?</Text>
        <ResetConfirm
          theme={theme}
          store={store}
          account={account}
          agentId={agentId}
          onCancel={close}
          onFinished={(result) => {
            close();
            const { message, variant } = redeemToast(account.label, result);
            if (variant === "error") toast.error(message);
            else toast.show(message, { variant, durationMs: 5_000 });
          }}
        />
      </View>
    );
  };
}

/** Toast wording and tone for a redeem result. */
export function redeemToast(label: string, result: RedeemResult): { message: string; variant: "success" | "warning" | "error" } {
  if (result.outcome === "reset") {
    return { message: `${label}: ${result.message}${result.continued ? " The agent is carrying on." : ""}`, variant: "success" };
  }
  if (result.outcome === "error") return { message: result.message, variant: "error" };
  return { message: result.message, variant: "warning" };
}
