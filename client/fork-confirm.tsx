import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import { useState, type ComponentType } from "react";
import { Text, View } from "react-native";
import { FAMILY_LABEL, type Family } from "../shared/model";
import { forkAgent } from "../shared/rpc";
import { describe, type ZeroSubStore } from "./store";
import { Button, useText } from "./ui";

/**
 * Confirmation for carrying a stopped agent's work on with the other provider. It starts a new agent
 * that goes straight to work, so it's worth a second look; refusals (say, no mode as careful as this
 * agent's) show right here.
 */
export function forkPopover(store: ZeroSubStore, agentId: string, from: Family, to: Family): ComponentType<PluginButtonContentProps> {
  return function ForkPopover({ theme, close }: PluginButtonContentProps) {
    const toast = useToast();
    const text = useText(theme);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

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
          Every {FAMILY_LABEL[from]} account is at its limit. This starts a new {FAMILY_LABEL[to]} agent in this workspace
          with the conversation so far, allowed no more than this agent is. This agent stays as it is.
        </Text>
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
            onPress={() => void start()}
          />
        </View>
      </View>
    );
  };
}

/**
 * Confirmation for carrying a stopped Claude chat on in a new agent on this host's OpenCode, offered
 * on every Claude agent's account button whether or not automatic forking is on. The model and
 * thinking option come from ZeroSub's settings; refusals (say, a saved model that has left the
 * host's catalog) show right here.
 */
export function openCodeForkPopover(store: ZeroSubStore, agentId: string): ComponentType<PluginButtonContentProps> {
  return function OpenCodeForkPopover({ theme, close }: PluginButtonContentProps) {
    const toast = useToast();
    const text = useText(theme);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const start = async () => {
      setBusy(true);
      setError(null);
      try {
        const fork = await store.rpc(forkAgent, { agentId, destination: "opencode" });
        close();
        if (fork.delivery === "up-to-date") {
          toast.show("No update was sent: the OpenCode continuation already has everything from this agent.", {
            variant: "default",
            durationMs: 5_000,
          });
        } else if (fork.delivery === "found") {
          toast.show(`Found the existing OpenCode continuation “${fork.title}”. Nothing was sent; open that chat to inspect it.`, {
            variant: "default",
            durationMs: 5_000,
          });
        } else if (fork.delivery === "uncertain") {
          toast.show(`The last handoff to “${fork.title}” couldn't be confirmed. Nothing more was sent; open that chat before retrying.`, {
            variant: "default",
            durationMs: 5_000,
          });
        } else {
          toast.show(`Continuing on OpenCode in “${fork.title}”`, { variant: "success", durationMs: 5_000 });
        }
      } catch (failure) {
        setError(describe(failure));
        setBusy(false);
      }
    };

    return (
      <View style={{ gap: 12, maxWidth: 360 }}>
        <Text style={text.heading}>Continue on OpenCode?</Text>
        <Text style={text.body}>
          This starts a new OpenCode agent in this workspace with the conversation so far, using the OpenCode model and
          thinking option picked in ZeroSub's settings. It gets Plan or Build under this host's OpenCode permission
          policy. Build edits files and runs shell without asking, so it can allow more than Claude does. Claude's Auto classifier and
          sandbox rules aren't copied. This agent stays as it is.
        </Text>
        {error ? <Text style={text.danger}>{error}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Not now" tooltip="Close without starting a new agent" tooltipAlign="end" onPress={close} disabled={busy} />
          <Button
            theme={theme}
            tone="primary"
            icon="GitFork"
            label="Continue on OpenCode"
            tooltip="Start a new OpenCode agent with this conversation so far"
            tooltipAlign="end"
            busy={busy}
            onPress={() => void start()}
          />
        </View>
      </View>
    );
  };
}
