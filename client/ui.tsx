import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useMemo, type ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { formatPercent, formatResetIn } from "../shared/format";
import type { UsageWindow } from "../shared/model";

type Theme = PluginHostProps["theme"];

export type ButtonTone = "primary" | "secondary" | "danger" | "ghost";

export function Button({
  theme,
  label,
  icon,
  tone = "secondary",
  size = "regular",
  onPress,
  disabled,
  busy,
  accessibilityLabel,
}: {
  theme: Theme;
  label: string;
  icon?: string;
  tone?: ButtonTone;
  /** `small` fits a card's footer. */
  size?: "regular" | "small";
  onPress(): void;
  disabled?: boolean;
  busy?: boolean;
  accessibilityLabel?: string;
}) {
  const small = size === "small";
  const colors = theme.colors;
  const palette = {
    primary: { background: colors.accent, foreground: colors.accentForeground, border: colors.accent },
    secondary: { background: colors.surface2, foreground: colors.foreground, border: colors.border },
    danger: { background: colors.surface2, foreground: colors.statusDanger, border: colors.border },
    ghost: { background: "transparent", foreground: colors.foregroundMuted, border: "transparent" },
  }[tone];
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: small ? 5 : 6,
        paddingHorizontal: small ? 10 : 12,
        paddingVertical: small ? 5 : 8,
        borderRadius: small ? 7 : 8,
        borderWidth: 1,
        borderColor: palette.border,
        backgroundColor: palette.background,
        opacity: inactive ? 0.55 : pressed ? 0.8 : 1,
      })}
    >
      {busy ? (
        <ActivityIndicator size="small" color={palette.foreground} />
      ) : icon ? (
        <Icon name={icon} size={small ? 13 : 15} color={palette.foreground} />
      ) : null}
      <Text style={{ color: palette.foreground, fontSize: small ? 12 : 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

export function IconButton({
  theme,
  icon,
  label,
  tone = "default",
  onPress,
  disabled,
  busy,
}: {
  theme: Theme;
  icon: string;
  label: string;
  tone?: "default" | "danger";
  onPress(): void;
  disabled?: boolean;
  busy?: boolean;
}) {
  const colors = theme.colors;
  const inactive = disabled || busy;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
      disabled={inactive}
      onPress={onPress}
      hitSlop={4}
      style={(state) => {
        const active = state.pressed || (state as { hovered?: boolean }).hovered;
        return {
          width: 30,
          height: 30,
          borderRadius: 8,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: active ? colors.surface2 : "transparent",
          opacity: inactive ? 0.45 : 1,
        };
      }}
    >
      {({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) =>
        busy ? (
          <ActivityIndicator size="small" color={colors.foregroundMuted} />
        ) : (
          <Icon
            name={icon}
            size={15}
            color={
              tone === "danger" && (pressed || hovered) ? colors.statusDanger : colors.foregroundMuted
            }
          />
        )
      }
    </Pressable>
  );
}

export function Badge({
  theme,
  label,
  tone = "muted",
}: {
  theme: Theme;
  label: string;
  tone?: "muted" | "accent" | "success" | "warning" | "danger";
}) {
  const colors = theme.colors;
  const color = {
    muted: colors.foregroundMuted,
    accent: colors.accent,
    success: colors.statusSuccess,
    warning: colors.statusWarning,
    danger: colors.statusDanger,
  }[tone];
  return (
    <View
      style={{
        paddingHorizontal: 7,
        paddingVertical: 2,
        borderRadius: 999,
        borderWidth: 1,
        borderColor: tone === "muted" ? colors.border : color,
      }}
    >
      <Text style={{ color, fontSize: 11, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}

export function UsageBar({ theme, limit }: { theme: Theme; limit: UsageWindow }) {
  const colors = theme.colors;
  const percent = Math.min(100, Math.max(0, limit.usedPercent));
  const fill =
    percent >= 90 ? colors.statusDanger : percent >= 70 ? colors.statusWarning : colors.statusSuccess;
  const reset = formatResetIn(limit.resetsAt);
  return (
    <View style={{ gap: 4 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", columnGap: 8 }}>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{limit.label}</Text>
        <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
          <Text style={{ color: colors.foreground, fontWeight: "600" }}>{formatPercent(percent)}</Text> used
          {reset ? ` · resets ${reset}` : ""}
        </Text>
      </View>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={`${limit.label} usage`}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
        style={{ height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden" }}
      >
        <View style={{ width: `${percent}%`, height: 6, borderRadius: 3, backgroundColor: fill }} />
      </View>
    </View>
  );
}

export function Card({
  theme,
  children,
  fill,
}: {
  theme: Theme;
  children: ReactNode;
  fill?: boolean;
}) {
  return (
    <View
      style={{
        ...(fill ? { flex: 1, minWidth: 0 } : null),
        padding: 16,
        gap: 12,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
      }}
    >
      {children}
    </View>
  );
}

export function useText(theme: Theme) {
  return useMemo(
    () => ({
      title: { color: theme.colors.foreground, fontSize: 22, fontWeight: "700" as const },
      heading: { color: theme.colors.foreground, fontSize: 15, fontWeight: "700" as const },
      body: { color: theme.colors.foreground, fontSize: 14 },
      strong: { color: theme.colors.foreground, fontSize: 14, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      small: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      warning: { color: theme.colors.statusWarning, fontSize: 13 },
      mono: { color: theme.colors.foreground, fontSize: 20, fontWeight: "700" as const, letterSpacing: 2 },
    }),
    [theme],
  );
}
