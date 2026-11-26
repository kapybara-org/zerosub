import { useHosts, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { DEFAULT_CONTINUE_PROMPT, preferences, type Preferences } from "../shared/preferences";
import { ComposerPillRows } from "./composer-settings";
import { ForkDestinationRows, OpenCodeForkRows } from "./fork-settings";

/** Settings → Plugins → zerosub. Accounts themselves live in the sidebar surface. */
export function PreferencesScreen({ theme, host, onOpenAccounts }: PluginSurfaceProps & { onOpenAccounts(): void }) {
  const settings = useSettings(preferences);
  const multiHost = useHosts().length > 1;
  // What's typed into the follow-up box, over which saved message. The box only takes its text when
  // it's made, so it's made again once the saved one changes (restored, say, or on another device).
  const [draft, setDraft] = useState<{ over: string; text: string } | null>(null);
  // Whether the last save was the follow-up's: its box says why that failed, the top any other.
  const [savedPrompt, setSavedPrompt] = useState(false);
  // The box goes while the settings can't be shown (a refresh failed, say), and what's typed with it.
  if (settings.status !== "ready" && draft) setDraft(null);
  const muted = { color: theme.colors.foregroundMuted };
  if (settings.status === "loading") return <Text style={muted}>Loading…</Text>;
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Preferences">
        <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>
        <SettingsAction label="Try again" actionLabel="Reload" onPress={() => void settings.reload()} />
        {settings.status === "invalid" ? (
          <>
            <SettingsAction label="Restore defaults" actionLabel="Reset" onPress={() => void settings.reset()} />
            {settings.saveError ? <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text> : null}
          </>
        ) : null}
      </SettingsSection>
    );
  }
  const save = (patch: Partial<Preferences>) => {
    setSavedPrompt("continuePrompt" in patch);
    void settings.save({ ...settings.values, ...patch }, settings.revision);
  };
  const saved = settings.values.continuePrompt;
  // Typed into a box made for an earlier saved message: it went with that box, even should the saved
  // message come back to what it was (restored after a save, say).
  if (draft && draft.over !== saved) setDraft(null);
  const typed = draft?.over === saved ? draft.text.trim() : "";
  return (
    <>
      {settings.saveError && !savedPrompt ? <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text> : null}
      {multiHost ? (
        <Text style={muted}>These apply to agents on {host.label}. Each host keeps its own accounts and preferences.</Text>
      ) : null}
      <SettingsSection title="Accounts">
        <SettingsCard>
          <SettingsAction
            label="Add, remove, and choose default accounts"
            actionLabel="Open accounts"
            onPress={onOpenAccounts}
          />
          <SettingsSwitch
            label="Move open agents when the default changes"
            hint="Off: open agents stay on the account they're using, even after they reopen. New agents, and agents that aren't open at the time, use the new default."
            value={settings.values.moveAgentsOnDefaultChange}
            disabled={settings.saving}
            onValueChange={(moveAgentsOnDefaultChange) => save({ moveAgentsOnDefaultChange })}
          />
          <SettingsSwitch
            label="Share MCP sign-ins between Claude accounts"
            hint="Off unless you turn it on. MCP servers you sign in to on one Claude account (Linear, Notion, …) work on the others too: each server's newest sign-in is copied between them every 30 seconds. Each account keeps its own Claude sign-in. Not on macOS. Turned off, nothing more is copied, and sign-ins already copied stay."
            value={settings.values.shareMcpSignIns}
            disabled={settings.saving}
            onValueChange={(shareMcpSignIns) => save({ shareMcpSignIns })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Automatic switching">
        <SettingsCard>
          <SettingsSwitch
            label="Switch accounts when one hits its limit"
            hint="The agent moves to the account with the most room left."
            value={settings.values.autoSwitch}
            disabled={settings.saving}
            onValueChange={(autoSwitch) => save({ autoSwitch })}
          />
          <SettingsSwitch
            label="Keep going after a switch"
            hint="Sends the follow-up below so the interrupted task continues, also after you use a banked reset. Off, a ChatGPT or Antigravity task that hits its limit stays where it stopped, since carrying it on means starting it in another tab."
            value={settings.values.autoContinue}
            disabled={settings.saving}
            onValueChange={(autoContinue) => save({ autoContinue })}
          />
          <SettingsInput
            key={saved}
            label="Follow-up message"
            initialValue={saved}
            onChangeText={(text) => setDraft({ over: saved, text })}
            disabled={settings.saving || !settings.values.autoContinue}
            error={savedPrompt ? settings.saveError : null}
          />
          <SettingsAction
            label="Save the follow-up message"
            actionLabel="Save"
            disabled={settings.saving || !typed || typed === saved}
            onPress={() => {
              if (typed && typed !== saved) save({ continuePrompt: typed });
            }}
          />
          <SettingsAction
            label="Restore the default follow-up"
            actionLabel="Restore"
            disabled={settings.saving || settings.values.continuePrompt === DEFAULT_CONTINUE_PROMPT}
            onPress={() => save({ continuePrompt: DEFAULT_CONTINUE_PROMPT })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="New agents and composer">
        <SettingsCard>
          <SettingsSwitch
            label="Spread new agents across accounts"
            hint="New ChatGPT agents prefer a weekly reset within one day when both limits have at least 20% left. Otherwise, new agents use the account with the most room."
            value={settings.values.balanceNewAgents}
            disabled={settings.saving}
            onValueChange={(balanceNewAgents) => save({ balanceNewAgents })}
          />
          <SettingsSwitch
            label="Use banked resets when every account is out"
            hint="Spends one of the account's banked resets instead of stopping. Off unless you turn it on: resets are scarce."
            value={settings.values.autoRedeem}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(autoRedeem) => save({ autoRedeem })}
          />
          <SettingsSwitch
            label="Use ChatGPT credits when a limit is reached"
            hint="A ChatGPT account at its limit stays in use while it has credits, so new agents may spend paid credits even while another account still has room."
            value={settings.values.useCredits}
            disabled={settings.saving}
            onValueChange={(useCredits) => save({ useCredits })}
          />
          <SettingsSwitch
            label="Use paid API accounts when every subscription is out"
            hint="Off unless you turn it on. When every subscription account of a provider is at its limit, signed out or disabled, agents may move to an Azure OpenAI account (ChatGPT), or an AWS Bedrock account or a Claude API key or token on Anthropic's own API (Claude), billed per use (after a banked reset, if those are used automatically), and Claude agents move back once a subscription has room. Off, those are used only as the default or when you pick one for an agent. Pi accounts never stand in."
            value={settings.values.paidApiFallback}
            disabled={settings.saving}
            onValueChange={(paidApiFallback) => save({ paidApiFallback })}
          />
          <SettingsSwitch
            label="When every account is out, fork the chat to the other provider"
            hint="A stopped Claude chat carries on in a new ChatGPT or OpenCode agent (pick the destination below) with the conversation so far. ChatGPT gets a mode no looser than this agent's. OpenCode gets Plan or Build under the host's own permission policy, which can allow more than Claude does. The original stays as it was."
            value={settings.values.forkOtherProvider}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(forkOtherProvider) => save({ forkOtherProvider })}
          />
          <ForkDestinationRows values={settings.values} saving={settings.saving} onSave={save} />
          <SettingsSwitch
            label="Keep a Codex chat in the same conversation"
            hint="Off unless you turn it on. Two ChatGPT accounts in one workspace reload this agent on the other account instead of opening a new tab. A different workspace, an email-only account, or a workspace that is out of credits still opens a new tab. If the first turn cannot resume the thread, this agent goes back and the new tab opens."
            value={settings.values.codexSameConversation}
            disabled={settings.saving || !settings.values.autoSwitch}
            onValueChange={(codexSameConversation) => save({ codexSameConversation })}
          />
          <ComposerPillRows values={settings.values} saving={settings.saving} onSave={save} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Continue on OpenCode">
        <SettingsCard>
          <OpenCodeForkRows values={settings.values} saving={settings.saving} onSave={save} />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
