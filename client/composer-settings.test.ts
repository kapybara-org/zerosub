import { describe, expect, it, vi } from "vitest";
import { preferences, type Preferences } from "../shared/preferences";

vi.mock("@getpaseo/plugin/client/ui", () => ({ SettingsSwitch: "SettingsSwitch" }));

const { ComposerPillRows } = await import("./composer-settings");

interface Row {
  props: { label: string; value: boolean; disabled: boolean; onValueChange(value: boolean): void };
}

const render = (overrides: Partial<Preferences> = {}, saving = false) => {
  const saved: Array<Partial<Preferences>> = [];
  const element = ComposerPillRows({ values: { ...preferences.schema.parse({}), ...overrides }, saving, onSave: (patch) => saved.push(patch) }) as {
    props: { children: Row[] };
  };
  return { rows: element.props.children, saved };
};

describe("ComposerPillRows", () => {
  it("shows both pill switches, on by default, and saves each to its own preference", () => {
    const { rows, saved } = render();
    expect(rows.map((row) => [row.props.label, row.props.value, row.props.disabled])).toEqual([
      ["Show the account pill in the composer", true, false],
      ["Show the account pill where the Account control doesn't fit", true, false],
    ]);
    rows[0]!.props.onValueChange(false);
    rows[1]!.props.onValueChange(false);
    expect(saved).toEqual([{ showComposerPill: false }, { keepComposerPill: false }]);
  });

  it("greys out the second switch while the pill is off, and both while saving", () => {
    expect(render({ showComposerPill: false }).rows.map((row) => row.props.disabled)).toEqual([false, true]);
    expect(render({}, true).rows.map((row) => row.props.disabled)).toEqual([true, true]);
  });
});
