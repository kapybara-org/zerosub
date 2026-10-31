import { useCallback, useState } from "react";
import type { OmpSettings, OmpSettingsChange } from "../shared/model";

/** A choice per select, by the select's key. */
type Choices = Readonly<Record<string, string>>;

/**
 * What an OMP settings select sends: only its own setting, so a change made just before, and not yet
 * in the last poll, stays. "default" leaves the setting to OMP's own config again.
 */
export function settingChange(key: keyof OmpSettings, choice: string): OmpSettingsChange {
  const value =
    choice === "default" ? null : choice === "true" ? true : choice === "false" ? false : /^\d+$/.test(choice) ? Number(choice) : choice;
  return { [key]: value };
}

/** `pending` without `key`'s choice if it's still `choice`; a newer choice outlives an older one's save. */
export function settleChoice(pending: Choices, key: string, choice: string): Choices {
  if (pending[key] !== choice) return pending;
  const rest = { ...pending };
  delete rest[key];
  return rest;
}

/**
 * Shows each select's new choice while the daemon saves it. Saving an OMP choice waits for OMP to
 * reload, which takes several seconds, and without this the select snaps back to the old value
 * meanwhile. The choice shows until `done` settles: saved and read back, or failed.
 */
export function usePendingChoices(): {
  shown(key: string, saved: string): string;
  choose(key: string, choice: string, done: Promise<unknown>): void;
} {
  const [pending, setPending] = useState<Choices>({});
  const choose = useCallback((key: string, choice: string, done: Promise<unknown>) => {
    setPending((current) => ({ ...current, [key]: choice }));
    const settle = () => setPending((current) => settleChoice(current, key, choice));
    done.then(settle, settle);
  }, []);
  return { shown: (key, saved) => pending[key] ?? saved, choose };
}
