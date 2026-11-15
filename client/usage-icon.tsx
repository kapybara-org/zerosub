import type { PluginButtonIconProps, PluginHostProps, PluginIconProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import type { ComponentType } from "react";
import type { UsageTone, WindowKind } from "../shared/glance";
import { glyphSvg } from "../shared/glyph";
import { ringPercent } from "../shared/ring";

type Theme = PluginHostProps["theme"];

/**
 * Paseo's icon kit draws an SVG string given as `icon={{ svg }}`, tinting `currentColor` with
 * `color`. Its published props don't list it yet; a host without it draws `name` instead.
 */
const KitIcon = Icon as ComponentType<PluginIconProps & { icon?: { svg: string } }>;

/** A clock for the 5-hour window, a calendar for the longer ones, a sparkle for one model's own. */
export const WINDOW_GLYPHS: Record<WindowKind, string> = {
  session: "Clock5",
  weekly: "CalendarDays",
  monthly: "CalendarRange",
  model: "Sparkle",
};

/** The colour a tone paints usage in: the given quiet colour until the window nears its end. */
export function toneColor(theme: Theme, tone: UsageTone, quiet: string): string {
  if (tone === "danger") return theme.colors.statusDanger;
  if (tone === "warning") return theme.colors.statusWarning;
  return quiet;
}

/** A limit's glyph at any size, for the usage card's headline and the agent's account list. */
export function Glyph({
  theme,
  kind,
  usedPercent,
  tone,
  size,
  color,
  dashed = false,
}: {
  theme: Theme;
  kind: WindowKind;
  usedPercent: number;
  tone: UsageTone;
  size: number;
  color: string;
  dashed?: boolean;
}) {
  const fill = toneColor(theme, tone, "currentColor");
  // The line stays about one pixel at any size.
  const stroke = Math.min(1.4, Math.max(1, 16 / size));
  return <KitIcon name={WINDOW_GLYPHS[kind]} size={size} color={color} icon={{ svg: glyphSvg(kind, usedPercent, { fill, dashed, stroke }) }} />;
}

export type GlyphIcon = ComponentType<PluginButtonIconProps> & { displayName: string };

const glyphs = new Map<string, GlyphIcon>();

/**
 * A limit's glyph as a pill or menu icon: a clock for the 5-hour window, a calendar for the week or
 * the month, a sparkle for one model's own window, each filling with the share used, in the host's
 * own icon colour until the window nears its end. `dashed` stands for an account with nothing to
 * show. One component per look, cached, so a pill whose reading hasn't moved keeps its icon, and
 * `displayName` tells two looks apart.
 */
export function glyphIcon(kind: WindowKind, usedPercent: number, tone: UsageTone, { dashed = false } = {}): GlyphIcon {
  const percent = dashed ? 0 : ringPercent(usedPercent);
  const key = dashed ? "Glyph(dashed)" : `Glyph(${kind},${percent},${tone})`;
  const cached = glyphs.get(key);
  if (cached) return cached;
  function UsageGlyph({ theme, size, color }: PluginButtonIconProps) {
    const fill = toneColor(theme, tone, "currentColor");
    return <KitIcon name={WINDOW_GLYPHS[kind]} size={size} color={color} icon={{ svg: glyphSvg(kind, percent, { fill, dashed }) }} />;
  }
  const icon = Object.assign(UsageGlyph, { displayName: key });
  glyphs.set(key, icon);
  return icon;
}
