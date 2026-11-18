import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";

/**
 * Paseo 0.16's composer pill, as drawn in the app (`composerPillStyles` and the plugin
 * button's popover), for the Account control in a composer wide enough to hold it. The control
 * then looks and opens as the account button does: the icon, the usage and a chevron, and above it
 * the button's own menu. Paseo lends composer items no pill or popover of its own, so both are
 * drawn here with its sizes; colours come from the plugin theme, which is all of Paseo's a plugin sees.
 */
const PILL = { minHeight: 32, paddingHorizontal: 12, paddingVertical: 4, gap: 8, radius: 16, fontSize: 12, maxWidth: 160 };
const POPOVER = { offset: 12, margin: 8, minWidth: 280, maxWidth: 420, maxHeight: 440, radius: 12, padding: 12, gap: 8 };
/** Paseo's tooltips: above, centred, 6 from the button, at most 280 wide. */
const TOOLTIP = { offset: 6, maxWidth: 280, paddingVertical: 4, paddingHorizontal: 8, radius: 12, fontSize: 12, delayMs: 300 };
/**
 * The toolbar the control sits in clips what overflows it, so the tooltip and the menu are placed
 * against the window (`position: fixed`, which React Native for the web passes on; the native apps
 * never draw this control, see `contributeComposerItem`). Not in a React Native Modal: that holds the keyboard's focus inside
 * itself, and under a dialog of Paseo's, which does the same, the two pass focus back and forth
 * for ever and the app hangs.
 */
const FIXED = "fixed" as unknown as "absolute";

export interface AccountPillButtonProps {
  host: PluginHostProps;
  agentId: string;
  /** The account button's tooltip, shown on hover and read out for the control. */
  title: string;
  icon: string;
  label: string;
  Menu: ComponentType<PluginButtonContentProps>;
}

interface Anchor {
  x: number;
  y: number;
  width: number;
}

export function AccountPillButton({ host, agentId, title, icon, label, Menu }: AccountPillButtonProps) {
  const trigger = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [tip, setTip] = useState<Anchor | null>(null);
  const hovering = useRef<ReturnType<typeof setTimeout> | null>(null);
  const screen = useWindowDimensions();
  const { colors } = host.theme;
  const measure = (then: (anchor: Anchor) => void) => {
    const node = trigger.current;
    if (!node) return;
    node.measureInWindow((x, y, width) => then({ x, y, width }));
  };
  const stopHover = () => {
    if (hovering.current) clearTimeout(hovering.current);
    hovering.current = null;
    setTip(null);
  };
  const open = () => {
    stopHover();
    measure(setAnchor);
  };
  const close = () => setAnchor(null);
  const hoverIn = () => {
    if (hovering.current) clearTimeout(hovering.current);
    hovering.current = setTimeout(() => {
      hovering.current = null;
      measure(setTip);
    }, TOOLTIP.delayMs);
  };
  useEffect(() => () => {
    if (hovering.current) clearTimeout(hovering.current);
  }, []);

  const left = anchor ? Math.max(POPOVER.margin, Math.min(anchor.x, screen.width - POPOVER.minWidth - POPOVER.margin)) : 0;
  const bottom = anchor ? screen.height - anchor.y + POPOVER.offset : 0;
  const maxHeight = anchor ? Math.max(120, Math.min(POPOVER.maxHeight, anchor.y - POPOVER.offset - POPOVER.margin)) : 0;
  const maxWidth = Math.max(POPOVER.minWidth, Math.min(POPOVER.maxWidth, screen.width - left - POPOVER.margin));
  // Centred over the button, kept inside the window: a box as wide as the widest tooltip, the tooltip in its middle.
  const tipCentre = tip ? Math.max(TOOLTIP.maxWidth / 2 + POPOVER.margin, Math.min(tip.x + tip.width / 2, screen.width - TOOLTIP.maxWidth / 2 - POPOVER.margin)) : 0;

  return (
    <View ref={trigger} collapsable={false}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: anchor !== null }}
        onPress={open}
        onHoverIn={hoverIn}
        onHoverOut={stopHover}
        style={(state) => {
          const { pressed, hovered } = state as { pressed: boolean; hovered?: boolean };
          return {
            flexDirection: "row",
            alignItems: "center",
            gap: PILL.gap,
            minHeight: PILL.minHeight,
            paddingHorizontal: PILL.paddingHorizontal,
            paddingVertical: PILL.paddingVertical,
            borderRadius: PILL.radius,
            borderWidth: 1,
            borderColor: colors.border,
            backgroundColor: pressed || hovered || anchor ? colors.surface2 : colors.surface1,
            flexShrink: 1,
            minWidth: 0,
            maxWidth: PILL.maxWidth,
          };
        }}
      >
        <View style={{ width: 16, height: 16, alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
          <Icon name={icon} size={14} color={colors.foregroundMuted} />
        </View>
        <Text numberOfLines={1} style={{ fontSize: PILL.fontSize, color: anchor ? colors.foreground : colors.foregroundMuted, flexShrink: 1 }}>
          {label}
        </Text>
        <Icon name="ChevronUp" size={12} color={colors.foregroundMuted} />
      </Pressable>
      {tip && !anchor && title ? (
        <View
          pointerEvents="none"
          style={{
            position: FIXED,
            left: tipCentre - TOOLTIP.maxWidth / 2,
            bottom: screen.height - tip.y + TOOLTIP.offset,
            width: TOOLTIP.maxWidth,
            alignItems: "center",
            zIndex: 1000,
          }}
        >
          <View
            style={{
              maxWidth: TOOLTIP.maxWidth,
              paddingVertical: TOOLTIP.paddingVertical,
              paddingHorizontal: TOOLTIP.paddingHorizontal,
              borderRadius: TOOLTIP.radius,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: popoverColor(colors),
              shadowColor: "#000000",
              shadowOpacity: 0.12,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
            }}
          >
            <Text style={{ fontSize: TOOLTIP.fontSize, color: colors.foreground }}>{title}</Text>
          </View>
        </View>
      ) : null}
      {anchor ? (
        <>
          <Pressable accessibilityLabel="Close" onPress={close} style={{ position: FIXED, top: 0, right: 0, bottom: 0, left: 0, zIndex: 999 }} />
          <View
            style={{
              position: FIXED,
              left,
              bottom,
              zIndex: 1000,
              minWidth: POPOVER.minWidth,
              maxWidth,
              maxHeight,
              borderRadius: POPOVER.radius,
              borderWidth: 1,
              borderColor: colors.border,
              backgroundColor: popoverColor(colors),
              overflow: "hidden",
              shadowColor: "#000000",
              shadowOpacity: 0.12,
              shadowRadius: 12,
              shadowOffset: { width: 0, height: 4 },
            }}
          >
            <ScrollView style={{ maxHeight }} contentContainerStyle={{ padding: POPOVER.padding, gap: POPOVER.gap }}>
              <Menu {...host} context="agent" workspaceId="" agentId={agentId} close={close} />
            </ScrollView>
          </View>
        </>
      ) : null}
    </View>
  );
}

/** Paseo's popovers: the page's own colour in a light theme, a step up from it in a dark one. */
export function popoverColor(colors: { surface0: string; surface2: string }): string {
  return isLight(colors.surface0) ? colors.surface0 : colors.surface2;
}

function isLight(color: string): boolean {
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (!hex) return true;
  const value = Number.parseInt(hex, 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;
  return 0.299 * red + 0.587 * green + 0.114 * blue > 128;
}
