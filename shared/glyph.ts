import { glance, isFull, accountBinding, type UsageTone, type WindowKind } from "./glance";
import type { AccountView } from "./model";
import { limitHolds } from "./plan-input";
import { ringPercent } from "./ring";

/**
 * A limit's glyph: the gauge takes the shape of what it measures. A clock for the 5-hour window (its
 * arc and hand advance with use), a calendar for the week or the month and a sparkle for one model's
 * own window (Fable), both filling from the bottom like a level. One fine line, half the host's icon
 * colour; the level is a light wash of it, and only turns amber or red near the end. An account with
 * nothing to show (signed out, set aside) is a dashed circle.
 *
 * Kept as an SVG string so Paseo draws it through its own icon kit (`Icon` with `{ svg }`), which
 * tints `currentColor` with the host's icon colour. The clip shapes never change, so one id each is
 * safe on a page that shows many glyphs.
 */
const SPARK = "M8 1.1C8.75 5.05 10.95 7.25 14.9 8C10.95 8.75 8.75 10.95 8 14.9C7.25 10.95 5.05 8.75 1.1 8C5.05 7.25 7.25 5.05 8 1.1Z";

export interface GlyphOptions {
  /** Paints the used share; `currentColor` (the default) keeps the host's own icon colour. */
  fill?: string;
  dashed?: boolean;
  /** Line width in the 16-unit box; thinner reads better large. */
  stroke?: number;
}

/** A colour for an SVG attribute: theme colours are hex or rgb(), never anything with quotes. */
function paint(color: string): string {
  return /^[#a-zA-Z0-9(),.%\s-]+$/.test(color) ? color : "currentColor";
}

const LINE = 'stroke="currentColor" stroke-opacity="0.5"';

/**
 * The used share fills the shape like a level, inset from its outline so the outline stays a clean
 * line. In the host's own colour it stays light; amber or red only once the window nears its end.
 */
function level(fill: string): string {
  return fill === "currentColor" ? 'fill="currentColor" fill-opacity="0.38"' : `fill="${fill}" fill-opacity="0.6"`;
}

export function glyphSvg(kind: WindowKind, usedPercent: number, { fill = "currentColor", dashed = false, stroke = 1.25 }: GlyphOptions = {}): string {
  const parts = ['<svg viewBox="0 0 16 16" fill="none">'];
  if (dashed) {
    parts.push(`<circle cx="8" cy="8" r="6.25" stroke="currentColor" stroke-opacity="0.5" stroke-width="${stroke}" stroke-dasharray="1.8 2.2"/>`);
    parts.push("</svg>");
    return parts.join("");
  }
  const used = ringPercent(usedPercent) / 100;
  const color = paint(fill);
  const sw = stroke.toFixed(2);
  const tinted = color !== "currentColor";
  if (kind === "session") {
    // A clock: the arc sweeps from twelve with use, and the hand follows it.
    const r = 6.25;
    const c = 2 * Math.PI * r;
    const angle = used * 2 * Math.PI - Math.PI / 2;
    const hand = 3.1;
    const ink = tinted ? `stroke="${color}"` : 'stroke="currentColor"';
    parts.push(`<circle cx="8" cy="8" r="${r}" ${LINE} stroke-width="${sw}"/>`);
    if (used >= 1) parts.push(`<circle cx="8" cy="8" r="${r}" ${ink} stroke-width="${sw}"/>`);
    else if (used > 0) {
      const length = Math.max(0.5, c * used).toFixed(2);
      parts.push(
        `<circle cx="8" cy="8" r="${r}" ${ink} stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${length} ${c.toFixed(2)}" transform="rotate(-90 8 8)"/>`,
      );
    }
    const x = (8 + Math.cos(angle) * hand).toFixed(2);
    const y = (8 + Math.sin(angle) * hand).toFixed(2);
    parts.push(`<path d="M8 8L${x} ${y}" ${used > 0 ? ink : LINE} stroke-width="${sw}" stroke-linecap="round"/>`);
  } else if (kind === "model") {
    const top = 1.1;
    const height = 13.8;
    parts.push(`<defs><clipPath id="zs-glyph-spark"><path d="${SPARK}"/></clipPath></defs>`);
    if (used > 0) {
      const rise = Math.max(0.6, height * used);
      parts.push(`<rect clip-path="url(#zs-glyph-spark)" x="0" y="${(top + height - rise).toFixed(2)}" width="16" height="${(rise + 0.5).toFixed(2)}" ${level(color)}/>`);
    }
    parts.push(`<path d="${SPARK}" ${tinted && used >= 1 ? `stroke="${color}"` : LINE} stroke-width="${sw}" stroke-linejoin="round"/>`);
  } else {
    // A calendar: the level rises inside its outline, under the header line.
    const x0 = 2.25;
    const top = 3.5;
    const width = 11.5;
    const height = 10.5;
    const inset = stroke * 0.9;
    const innerTop = top + inset;
    const innerHeight = height - 2 * inset;
    parts.push(
      `<defs><clipPath id="zs-glyph-calendar"><rect x="${(x0 + inset).toFixed(2)}" y="${innerTop.toFixed(2)}" width="${(width - 2 * inset).toFixed(2)}" height="${innerHeight.toFixed(2)}" rx="1.3"/></clipPath></defs>`,
    );
    if (used > 0) {
      const rise = Math.max(0.6, innerHeight * used);
      parts.push(
        `<rect clip-path="url(#zs-glyph-calendar)" x="0" y="${(innerTop + innerHeight - rise).toFixed(2)}" width="16" height="${(rise + 0.5).toFixed(2)}" ${level(color)}/>`,
      );
    }
    parts.push(`<rect x="${x0}" y="${top}" width="${width}" height="${height}" rx="2.2" ${tinted && used >= 1 ? `stroke="${color}"` : LINE} stroke-width="${sw}"/>`);
    parts.push(`<path d="M5.4 1.9v2.6M10.6 1.9v2.6" ${LINE} stroke-width="${sw}" stroke-linecap="round"/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

/** How an account's glyph looks for an agent running `model` (null: any model). */
export interface AccountGlyph {
  kind: WindowKind;
  usedPercent: number;
  tone: UsageTone;
  dashed: boolean;
}

/**
 * The window that holds an agent running `model` back the most on this account: its shape, how full
 * it is and how close to the end. A limit a turn ran into on that model shows as its sparkle, full.
 */
export function accountGlyph(account: AccountView, model: string | null, now: number = Date.now()): AccountGlyph {
  if (account.status === "signed_out" || account.status === "disabled") return { kind: "session", usedPercent: 0, tone: "calm", dashed: true };
  const windows = account.usage?.windows ?? [];
  if (account.status === "limited") {
    const binding = accountBinding(windows, now);
    return { kind: binding && isFull(binding.window) ? binding.kind : "session", usedPercent: 100, tone: "danger", dashed: false };
  }
  const blocked = (account.modelLimits ?? []).some((limit) => Date.parse(limit.until) > now && limitHolds(limit, model));
  if (blocked) return { kind: "model", usedPercent: 100, tone: "danger", dashed: false };
  const first = glance(windows, model, now)[0];
  return first
    ? { kind: first.kind, usedPercent: first.window.usedPercent, tone: first.tone, dashed: false }
    : { kind: "session", usedPercent: 0, tone: "calm", dashed: false };
}
