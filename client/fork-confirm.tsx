import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useState, type ComponentType } from "react";
import { Text, View } from "react-native";
import { canStandIn } from "../shared/format";
import { FAMILY_LABEL, type Family } from "../shared/model";
import { forkAgent } from "../shared/rpc";
import { describe, useStore, type ZeroSubStore } from "./store";
import { Button, useText } from "./ui";

/**
 * Confirmation for carrying a stopped agent's work on with the other provider. It starts a new agent
 * that goes straight to work, so it's worth a second look; refusals (say, no mode as careful as this
 * agent's) show right here. It reads the accounts from the store as it renders, so it stays current
 * while open.
 */
export function forkPopover(
  store: ZeroSubStore,
  agentId: string,
  from: Family,
  to: Family,
): ComponentType<PluginButtonContentProps> {
  return function ForkPopover({ theme, close }: PluginButtonContentProps) {
    const toast = useToast();
    const text = useText(theme);
    const { state } = useStore(store);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const accounts = state?.accounts ?? [];
    // Where the server would put the new agent: never on an API account, which it doesn't move work onto.
    const target = accounts.some((account) => account.family === to && canStandIn(account));
    const apiOnly = !target && accounts.some((account) => account.family === to && account.auth === "api" && account.status === "ready");
    const roomBack = accounts.some((account) => account.family === from && canStandIn(account));

    const start = async () => {
      setBusy(true);
      setError(null);
      try {
        const fork = await store.rpc(forkAgent, { agentId });
        close();
        toast.show(`Continuing on ${FAMILY_LABEL[to]} in “${fork.title}”`, { variant: "success", durationMs: 5_000 });
      } catch (failure) {
        setError(describe(failure));
        setBusy(false);
      }
    };

    return (
      <View style={{ gap: 12, maxWidth: 360 }}>
        <Text style={text.heading}>Continue on {FAMILY_LABEL[to]}?</Text>
        <Text style={text.body}>
          {roomBack
            ? `A ${FAMILY_LABEL[from]} account has room again; you can also move this agent to it from this menu instead.`
            : `Every ${FAMILY_LABEL[from]} account is at its limit.`}{" "}
          This starts a new {FAMILY_LABEL[to]} agent in this workspace with the conversation so far, allowed no more than
          this agent is. This agent stays as it is.
        </Text>
        {target ? null : (
          <Text style={text.warning}>
            {apiOnly
              ? `Your ${FAMILY_LABEL[to]} accounts with room use an API key, which ZeroSub never moves work onto by itself.`
              : `No ${FAMILY_LABEL[to]} account has room right now.`}
          </Text>
        )}
        {error ? <Text style={text.danger}>{error}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Not now" tooltip="Close without starting a new agent" tooltipAlign="end" onPress={close} disabled={busy} />
          <Button
            theme={theme}
            tone="primary"
            icon="GitFork"
            label={`Continue on ${FAMILY_LABEL[to]}`}
            tooltip={`Start a new ${FAMILY_LABEL[to]} agent with this conversation so far`}
            tooltipAlign="end"
            busy={busy}
            disabled={!target}
            onPress={() => void start()}
          />
        </View>
      </View>
    );
  };
}
