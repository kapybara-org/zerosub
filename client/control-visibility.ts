/**
 * Which running agents' Account controls are on screen right now, so the account button
 * shows only where the control isn't (see pills.ts). Paseo keeps a control that doesn't fit the
 * toolbar mounted there but hidden, and shows it in the composer's sheet instead, and tells a plugin
 * nothing of which; so each control checks for itself (see `useControlShown` in composer-item.tsx).
 *
 * A composer can be mounted more than once for one agent (a kept tab, a split pane, the sheet), so
 * each mount reports on its own, and the agent counts as shown while any of them is.
 */
const shown = new Map<string, Set<object>>();
const listeners = new Set<() => void>();

export function setControlShown(agentId: string, mount: object, visible: boolean): void {
  const mounts = shown.get(agentId) ?? new Set<object>();
  const before = mounts.size > 0;
  if (visible) mounts.add(mount);
  else mounts.delete(mount);
  if (mounts.size > 0) shown.set(agentId, mounts);
  else shown.delete(agentId);
  if (before !== mounts.size > 0) for (const listener of [...listeners]) listener();
}

export function controlShown(agentId: string): boolean {
  return shown.has(agentId);
}

export function subscribeControlShown(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** For tests. */
export function forgetControlsShown(): void {
  shown.clear();
}

/**
 * Whether a mounted view is on screen. On the web (the desktop app included) the element can say:
 * Paseo hides a control that doesn't fit with `visibility: hidden` and no opacity. Elsewhere (the
 * phone apps) there's no telling, and it counts as not shown, so the account button stays: a phone's
 * composer never has room for the control anyway.
 */
export function onScreen(node: unknown): boolean {
  const check = (node as { checkVisibility?: (options?: Record<string, boolean>) => boolean } | null)?.checkVisibility;
  if (typeof check !== "function") return false;
  try {
    return check.call(node, { opacityProperty: true, visibilityProperty: true });
  } catch {
    return false;
  }
}

/**
 * Whether a mounted view is inside one of Paseo's dialogs: on the desktop, the composer's sheet
 * (the panel the model's name opens), where a control that doesn't fit the toolbar goes. A menu of
 * the control's own would open over a dialog that holds the keyboard's focus, so there the control
 * is Paseo's own list. Elsewhere (the phone apps) there's no telling, and it counts as not.
 */
export function inDialog(node: unknown): boolean {
  const closest = (node as { closest?: (selector: string) => unknown } | null)?.closest;
  if (typeof closest !== "function") return false;
  try {
    return closest.call(node, '[role="dialog"], [aria-modal="true"]') != null;
  } catch {
    return false;
  }
}
