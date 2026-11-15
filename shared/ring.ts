/**
 * A usage ring: a faint full circle with an arc over it for the share used, drawn from twelve
 * o'clock. It stands where a radio circle would, so a picked account reads as a ring with a dot.
 *
 * Kept as an SVG string so Paseo draws it through its own icon kit (`Icon` with `{ svg }`), which
 * tints `currentColor` with the host's icon colour.
 */
const SIZE = 16;
const CENTER = SIZE / 2;
const RADIUS = 6;
const STROKE = 1.75;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** The share of a window used, as a whole percent from 0 to 100. */
export function ringPercent(usedPercent: number): number {
  return Math.round(Math.min(100, Math.max(0, usedPercent)));
}

/** A colour for an SVG attribute: theme colours are hex or rgb(), never anything with quotes. */
function paint(color: string): string {
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(color) ? color : "currentColor";
}

export interface RingOptions {
  /** Colours the used share; `currentColor` (the default) keeps the host's own icon colour. */
  arc?: string;
  /** Adds a centre dot, as a picked radio would. */
  selected?: boolean;
  /** Draws the track dashed and no arc: an account with no reading to show (signed out, set aside). */
  dashed?: boolean;
}

/** The ring for `usedPercent`. The track is the icon colour, faint. */
export function ringSvg(usedPercent: number, { arc = "currentColor", selected = false, dashed = false }: RingOptions = {}): string {
  const percent = ringPercent(usedPercent);
  const circle = `cx="${CENTER}" cy="${CENTER}" r="${RADIUS}" stroke-width="${STROKE}"`;
  const parts = [`<svg viewBox="0 0 ${SIZE} ${SIZE}" fill="none">`];
  if (dashed) {
    parts.push(`<circle ${circle} stroke="currentColor" stroke-opacity="0.6" stroke-dasharray="2 2.4"/>`);
  } else {
    parts.push(`<circle ${circle} stroke="currentColor" stroke-opacity="0.28"/>`);
    if (percent >= 100) {
      parts.push(`<circle ${circle} stroke="${paint(arc)}"/>`);
    } else if (percent > 0) {
      // At least a dot's worth of arc, so 1% still shows.
      const length = Math.max(0.6, (CIRCUMFERENCE * percent) / 100).toFixed(2);
      parts.push(
        `<circle ${circle} stroke="${paint(arc)}" stroke-linecap="round" stroke-dasharray="${length} ${CIRCUMFERENCE.toFixed(2)}" transform="rotate(-90 ${CENTER} ${CENTER})"/>`,
      );
    }
  }
  if (selected) parts.push(`<circle cx="${CENTER}" cy="${CENTER}" r="2.25" fill="currentColor"/>`);
  parts.push("</svg>");
  return parts.join("");
}
