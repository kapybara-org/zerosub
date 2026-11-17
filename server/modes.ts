/** Paseo's permission tiers for agent modes, most careful first. */
const TIERS = ["planning", "safe", "moderate", "dangerous"] as const;

export interface ModeInfo {
  id: string;
  label?: string;
  colorTier?: string | null;
}

function tierOf(mode: ModeInfo | undefined): number {
  return mode?.colorTier ? TIERS.indexOf(mode.colorTier as (typeof TIERS)[number]) : -1;
}

/**
 * The other provider's mode whose Paseo tier is no higher than the source agent's: the same tier if
 * it has one, otherwise the closest more careful one (first listed wins a tie). `null` when it has
 * nothing that careful, or the source mode is unknown. Tiers order modes; they don't make two
 * providers' policies equivalent.
 */
export function equivalentMode(
  sourceModes: readonly ModeInfo[],
  sourceModeId: string | null | undefined,
  targetModes: readonly ModeInfo[],
): string | null {
  const ceiling = tierOf(sourceModes.find((mode) => mode.id === sourceModeId));
  if (ceiling < 0) return null;
  let best: { id: string; tier: number } | null = null;
  for (const mode of targetModes) {
    const tier = tierOf(mode);
    if (tier < 0 || tier > ceiling) continue;
    if (!best || tier > best.tier) best = { id: mode.id, tier };
  }
  return best?.id ?? null;
}

/**
 * Whether `targetModeId`'s Paseo tier is no higher than the source mode's tier, by the same ordering
 * `equivalentMode` picks from. It compares tiers only, not what each provider's own policy allows.
 * An unknown mode on either side is never within.
 */
export function withinMode(
  sourceModes: readonly ModeInfo[],
  sourceModeId: string | null | undefined,
  targetModes: readonly ModeInfo[],
  targetModeId: string | null | undefined,
): boolean {
  const ceiling = tierOf(sourceModes.find((mode) => mode.id === sourceModeId));
  const tier = tierOf(targetModes.find((mode) => mode.id === targetModeId));
  return ceiling >= 0 && tier >= 0 && tier <= ceiling;
}
