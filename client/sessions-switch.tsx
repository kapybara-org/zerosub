import { SettingsCard, SettingsSwitch } from "@getpaseo/plugin/client/ui";

/**
 * Whether a new Claude account starts on the default sessions folder (`~/.claude/sessions`).
 * Off, it keeps its own, as upstream's do; either way the card's link button changes it later.
 */
export function SessionsSwitch({ value, onValueChange }: { value: boolean; onValueChange(value: boolean): void }) {
  return (
    <SettingsCard>
      <SettingsSwitch
        label="Use the default sessions folder"
        hint="Claude Code's default, ~/.claude/sessions, where running sessions register, so this account's sessions and those of every account using that folder see each other. Off, it keeps a folder of its own. You can change it later from the account's card."
        value={value}
        onValueChange={onValueChange}
      />
    </SettingsCard>
  );
}
