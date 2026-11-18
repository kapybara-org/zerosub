import { SettingsSwitch } from "@getpaseo/plugin/client/ui";
import type { Preferences } from "../shared/preferences";

/**
 * The account pill's two switches, on Settings → Plugins → zerosub and on the Accounts
 * screen, where the other switches people look for are.
 */
export function ComposerPillRows({
  values,
  saving,
  onSave,
}: {
  values: Preferences;
  saving: boolean;
  onSave(patch: Partial<Preferences>): void;
}) {
  return (
    <>
      <SettingsSwitch
        label="Show the account pill in the composer"
        hint="Appears on Claude and Codex agents once a provider has two or more accounts."
        value={values.showComposerPill}
        disabled={saving}
        onValueChange={(showComposerPill) => onSave({ showComposerPill })}
      />
      <SettingsSwitch
        label="Show the account pill where the Account control doesn't fit"
        hint="On Paseo 0.16 and later the message box has an Account control. With this on, a running agent's account shows as this pill, with its usage: in the message box where the control fits, and above the message box where Paseo hides the control under the model (a narrow window, or a phone, where the pill always shows). Off, the control shows only the account's name, and the pill only shows when there's a reset to use, another provider to carry on with, or Continue on OpenCode."
        value={values.keepComposerPill}
        disabled={saving || !values.showComposerPill}
        onValueChange={(keepComposerPill) => onSave({ keepComposerPill })}
      />
    </>
  );
}
