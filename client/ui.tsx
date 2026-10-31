import type { PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityIndicator, Modal, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { formatPercent, formatResetIn } from "../shared/format";
import type { UsageWindow } from "../shared/model";

type Theme = PluginHostProps["theme"];

export type ButtonTone = "primary" | "secondary" | "danger" | "ghost";

/** How a tooltip lines up with its control. `end` keeps a right-hand control's tip out of the next card. */
export type TooltipAlign = "start" | "center" | "end";

const TOOLTIP_HOVER_MS = 350;
const TOOLTIP_TOUCH_MS = 1_800;
const TOOLTIP_WIDTH = 240;

/** Hover (desktop, web) or long-press (touch) shows a short hint; pressing hides it. */
function useTooltip(text: string | undefined) {
  const [visible, setVisible] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  useEffect(() => clear, [clear]);
  const show = useCallback(
    (delay: number, hideAfter?: number) => {
      clear();
      timer.current = setTimeout(() => {
        setVisible(true);
        if (hideAfter) timer.current = setTimeout(() => setVisible(false), hideAfter);
      }, delay);
    },
    [clear],
  );
  const hide = useCallback(() => {
    clear();
    setVisible(false);
  }, [clear]);
  if (!text) return { visible: false, handlers: {} };
  return {
    visible,
    handlers: {
      onHoverIn: () => show(TOOLTIP_HOVER_MS),
      onHoverOut: hide,
      onPressIn: hide,
      onLongPress: () => show(0, TOOLTIP_TOUCH_MS),
    },
  };
}

function TooltipBubble({
  theme,
  text,
  placement,
  align,
}: {
  theme: Theme;
  text: string;
  placement: "top" | "bottom";
  align: TooltipAlign;
}) {
  const vertical = placement === "top" ? { bottom: "100%" as const, marginBottom: 6 } : { top: "100%" as const, marginTop: 6 };
  const horizontal =
    align === "end"
      ? { right: 0, alignItems: "flex-end" as const }
      : align === "start"
        ? { left: 0, alignItems: "flex-start" as const }
        : { left: "50%" as const, marginLeft: -TOOLTIP_WIDTH / 2, alignItems: "center" as const };
  return (
    <View pointerEvents="none" style={{ position: "absolute", width: TOOLTIP_WIDTH, zIndex: 1000, ...vertical, ...horizontal }}>
      <View style={{ paddingHorizontal: 8, paddingVertical: 5, borderRadius: 6, backgroundColor: theme.colors.foreground }}>
        <Text style={{ color: theme.colors.surface0, fontSize: 12, lineHeight: 16 }}>{text}</Text>
      </View>
    </View>
  );
}

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
  tooltip,
  tooltipAlign = "center",
  tooltipPlacement = "top",
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
  /** A short explanation shown on hover or long-press. */
  tooltip?: string;
  tooltipAlign?: TooltipAlign;
  tooltipPlacement?: "top" | "bottom";
}) {
  const small = size === "small";
  const tip = useTooltip(tooltip);
  const colors = theme.colors;
  const palette = {
    primary: { background: colors.accent, foreground: colors.accentForeground, border: colors.accent },
    secondary: { background: colors.surface2, foreground: colors.foreground, border: colors.border },
    danger: { background: colors.surface2, foreground: colors.statusDanger, border: colors.border },
    ghost: { background: "transparent", foreground: colors.foregroundMuted, border: "transparent" },
  }[tone];
  const inactive = disabled || busy;
  return (
    <View style={{ position: "relative", zIndex: tip.visible ? 1000 : undefined }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={tooltip}
        accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
        disabled={inactive}
        onPress={onPress}
        {...tip.handlers}
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
      {tip.visible && tooltip ? <TooltipBubble theme={theme} text={tooltip} placement={tooltipPlacement} align={tooltipAlign} /> : null}
    </View>
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
  tooltip,
  tooltipAlign = "end",
  tooltipPlacement = "top",
}: {
  theme: Theme;
  icon: string;
  label: string;
  tone?: "default" | "danger";
  onPress(): void;
  disabled?: boolean;
  busy?: boolean;
  /** Shown on hover or long-press; an icon alone never says enough, so it falls back to `label`. */
  tooltip?: string;
  tooltipAlign?: TooltipAlign;
  tooltipPlacement?: "top" | "bottom";
}) {
  const colors = theme.colors;
  const inactive = disabled || busy;
  const hint = tooltip ?? label;
  const tip = useTooltip(hint);
  return (
    <View style={{ position: "relative", zIndex: tip.visible ? 1000 : undefined }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={tooltip}
        accessibilityState={{ disabled: Boolean(inactive), busy: Boolean(busy) }}
        disabled={inactive}
        onPress={onPress}
        hitSlop={4}
        {...tip.handlers}
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
      {tip.visible ? <TooltipBubble theme={theme} text={hint} placement={tooltipPlacement} align={tooltipAlign} /> : null}
    </View>
  );
}

/** One entry of an ActionsMenu. */
export interface MenuAction {
  key: string;
  icon: string;
  label: string;
  /** Read out with the label; a menu row has room for the label only. */
  hint?: string;
  tone?: "default" | "danger";
  onPress(): void;
}

const MENU_WIDTH = 208;

interface Frame {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** A menu row's height, near enough to keep the list on screen without measuring it. */
const MENU_ROW_HEIGHT = 36;

/**
 * A ⋯ button that opens its actions as a labelled list under it. A card in a narrow pane has no room for a row of
 * icons. The list floats above the whole window, so later cards never cover it; an outside tap, Escape or picking an
 * action closes it.
 */
export function ActionsMenu({
  theme,
  label,
  actions,
  busy,
}: {
  theme: Theme;
  label: string;
  actions: MenuAction[];
  busy?: boolean;
}) {
  const [anchor, setAnchor] = useState<Frame | null>(null);
  const [root, setRoot] = useState<Frame | null>(null);
  const button = useRef<View>(null);
  const overlay = useRef<View>(null);
  const picked = useRef<MenuAction | null>(null);
  const colors = theme.colors;
  // Until the overlay has measured its own origin, take it to be the window's: exact on the web, where the Modal is
  // fixed to the viewport (and where that measurement may never arrive), and corrected on native once it does.
  const windowSize = useWindowDimensions();
  const frame = root ?? { x: 0, y: 0, width: windowSize.width, height: windowSize.height };
  const close = () => setAnchor(null);
  const runPicked = () => {
    const action = picked.current;
    picked.current = null;
    action?.onPress();
  };
  const openMenu = () =>
    button.current?.measureInWindow((x, y, width, height) => setAnchor({ x, y, width, height }));
  return (
    <View ref={button} collapsable={false}>
      <IconButton theme={theme} icon="Ellipsis" label={label} busy={busy} onPress={anchor ? close : openMenu} />
      {/* An iPhone shows a modal in portrait only unless it allows landscape too, turning the app round to do it. */}
      <Modal
        transparent
        animationType="none"
        supportedOrientations={["portrait", "landscape"]}
        visible={anchor !== null}
        onRequestClose={close}
        onDismiss={runPicked}
      >
        <View
          ref={overlay}
          collapsable={false}
          style={{ flex: 1 }}
          onLayout={() =>
            overlay.current?.measureInWindow((x, y, width, height) => setRoot({ x, y, width, height }))
          }
        >
          <Pressable
            accessibilityLabel={`Close ${label}`}
            onPress={close}
            style={{ position: "absolute", top: 0, right: 0, bottom: 0, left: 0 }}
          />
          {anchor ? (
            <View
              accessibilityRole="menu"
              accessibilityLabel={label}
              style={{
                position: "absolute",
                top: Math.max(
                  8,
                  Math.min(
                    anchor.y - frame.y + anchor.height + 4,
                    frame.height - 8 - (actions.length * MENU_ROW_HEIGHT + 14),
                  ),
                ),
                right: Math.max(
                  8,
                  Math.min(frame.x + frame.width - (anchor.x + anchor.width), frame.width - 8 - MENU_WIDTH),
                ),
                minWidth: MENU_WIDTH,
                padding: 6,
                gap: 2,
                borderRadius: 10,
                borderWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface2,
                shadowColor: "#000",
                shadowOpacity: 0.35,
                shadowRadius: 12,
                shadowOffset: { width: 0, height: 6 },
                elevation: 8,
              }}
            >
              {actions.map((action) => {
                const color = action.tone === "danger" ? colors.statusDanger : colors.foreground;
                return (
                  <Pressable
                    key={action.key}
                    accessibilityRole="menuitem"
                    accessibilityLabel={action.label}
                    accessibilityHint={action.hint}
                    onPress={() => {
                      picked.current = action;
                      close();
                      if (Platform.OS !== "ios") runPicked();
                    }}
                    style={(state) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 10,
                      paddingVertical: 8,
                      paddingHorizontal: 10,
                      borderRadius: 7,
                      backgroundColor:
                        state.pressed || (state as { hovered?: boolean }).hovered ? colors.surface1 : "transparent",
                    })}
                  >
                    <Icon name={action.icon} size={16} color={color} />
                    <Text style={{ color, fontSize: 13, fontWeight: "500" }}>{action.label}</Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
      </Modal>
    </View>
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
