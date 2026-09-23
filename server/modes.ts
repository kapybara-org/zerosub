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
 * The other provider's mode that allows no more than the source agent's mode: the same tier if it
 * has one, otherwise the closest more careful one (first listed wins a tie). `null` when it has
 * nothing that careful, or the source mode is unknown, so a fork never gets more freedom than the
 * user gave the original.
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
