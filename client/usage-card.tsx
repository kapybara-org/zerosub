import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ComponentType } from "react";
import { AccessibilityInfo, Animated, Easing, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View, type ViewStyle } from "react-native";
import { formatAge, formatCountdown, formatCredits, formatPercent, formatResetMoment } from "../shared/format";
import { agentWindows, describeUsage, describeWindow, glance, isFull, scopeOf, windowsWorthReading, type GlanceWindow } from "../shared/glance";
import type { AccountView } from "../shared/model";
import { accountOf, type TrackedAgent } from "./agent-account";
import { useStore, VISIBLE_POLL_MS, type ZeroSubStore } from "./store";
import { Glyph, toneColor } from "./usage-icon";

type Theme = PluginHostProps["theme"];

const CARD_WIDTH = 264;
const BAR_MS = 420;
const BAR_STAGGER_MS = 50;
const TICK_MS = 30_000;
/** Below Paseo's md breakpoint (600 points) the card opens in a bottom sheet, as wide as the screen. */
const COMPACT_WIDTH = 600;
const SIZE = {
  regular: { text: 13, small: 12, line: 16, glyph: 14, gap: 10, figure: 34, bar: 3, rowGap: 7, listGap: 14, hitSlop: 8 },
  compact: { text: 15, small: 13, line: 20, glyph: 16, gap: 12, figure: 40, bar: 4, rowGap: 9, listGap: 18, hitSlop: 14 },
} as const;
type Size = (typeof SIZE)[keyof typeof SIZE];
const TABULAR = ["tabular-nums" as const];
/** A line only reads on hover: the browser's arrow stays, not a pointing hand. */
const READ_ONLY = (Platform.OS === "web" ? { cursor: "default" } : {}) as unknown as ViewStyle;

/**
 * The card a usage pill opens: every window that applies to the agent, one line each, and nothing
 * else to read first.
 *
 * - Each window still worth reading (a 5-hour beside a full week is not): its glyph, its name, when it resets, how much is used, and a hairline bar. The one
 *   that holds the agent back (what the pill shows) is in full ink; the others recede in grey.
 *   With the pointer on a line, its countdown turns into the time on the clock ("3d 4h" → "Fri 08:12").
 *   Colour arrives only near a limit, and only on the figure, the glyph and the bar.
 * - The account and how fresh the reading is, with a way to the Accounts screen.
 *
 * In a bottom sheet (phones, narrow windows) the card takes the sheet's width and touch sizes, and
 * each line shows both the countdown and the clock time: a finger has no hover to reveal the time.
 *
 * One component for every agent (it reads `agentId` from its props), so pills keep it across updates.
 */
export function usageCard(
  store: ZeroSubStore,
  agentOf: (agentId: string) => TrackedAgent | undefined,
  openAccounts: () => void,
): ComponentType<PluginButtonContentProps> {
  function UsageCard(props: PluginButtonContentProps) {
    const { theme, close } = props;
    const { state } = useStore(store);
    const now = useNow(TICK_MS);
    const reduceMotion = useReducedMotion();
    const { width } = useWindowDimensions();
    const compact = width < COMPACT_WIDTH;
    const size = compact ? SIZE.compact : SIZE.regular;
    // A sheet is as wide as the screen; the popover keeps its fixed width.
    const box: ViewStyle = compact ? { alignSelf: "stretch" } : { width: CARD_WIDTH };
    // Keep the reading moving while the card is open.
    useEffect(() => store.watch(VISIBLE_POLL_MS), []);

    const agent = props.context === "agent" ? agentOf(props.agentId) : undefined;
    const account = state && agent ? accountOf(state, agent) : null;
    const windows = account?.usage && agent ? agentWindows(account.usage.windows, agent.model, now) : [];
    const binding = account?.usage && agent ? glance(account.usage.windows, agent.model, now)[0] : undefined;
    // In the reading's own order (5-hour, weekly, then a model's), like the Accounts screen; once a
    // limit is full, the ones that reset before it frees up are left out.
    const worth = account?.usage && agent ? windowsWorthReading(account.usage.windows, agent.model, now) : [];
    const rows = account?.usage ? account.usage.windows.filter((window) => windows.includes(window) && worth.includes(window)).map(describeWindow) : [];
    const credits = account?.usage?.credits && binding && isFull(binding.window) ? formatCredits(account.usage.credits) : null;

    const footer = (
      <Footer
        theme={theme}
        account={account}
        credits={credits}
        now={now}
        size={size}
        onAccounts={() => {
          close();
          openAccounts();
        }}
      />
    );
    if (!account || !binding) {
      return (
        <View style={[box, { gap: 12 }]}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.small }}>No usage reading yet.</Text>
          {footer}
        </View>
      );
    }
    return (
      <View style={[box, { gap: size.listGap }]}>
        <View style={{ gap: size.listGap }}>
          {rows.map((entry, index) => (
            <WindowRow
              key={`${index}:${entry.name}`}
              theme={theme}
              entry={entry}
              lead={entry.window === binding.window}
              now={now}
              delay={index * BAR_STAGGER_MS}
              reduceMotion={reduceMotion}
              size={size}
              touch={compact}
            />
          ))}
        </View>
        {footer}
      </View>
    );
  }
  UsageCard.displayName = "ZeroSubUsageCard";
  return UsageCard;
}

function WindowRow({
  theme,
  entry,
  lead,
  now,
  delay,
  reduceMotion,
  size,
  touch,
}: {
  theme: Theme;
  entry: GlanceWindow;
  /** The window that holds the agent back: full ink. */
  lead: boolean;
  now: number;
  delay: number;
  reduceMotion: boolean;
  size: Size;
  /** In a sheet: no hover, so the clock time shows beside the countdown. */
  touch: boolean;
}) {
  const colors = theme.colors;
  const [hovered, setHovered] = useState(false);
  const limit = entry.window;
  const full = isFull(limit);
  const wait = formatCountdown(limit.resetsAt, now);
  const moment = formatResetMoment(limit.resetsAt, now);
  const when = touch ? [wait, moment].filter(Boolean).join(" · ") : hovered && moment ? moment : wait;
  const name = entry.kind === "model" ? (scopeOf(limit) ?? limit.label) : limit.label;
  const ink = lead || hovered ? colors.foreground : colors.foregroundMuted;
  return (
    <Pressable
      accessible
      accessibilityLabel={describeUsage(entry, now)}
      tabIndex={-1}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[{ gap: size.rowGap }, READ_ONLY]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: size.gap }}>
        <Glyph theme={theme} kind={entry.kind} usedPercent={limit.usedPercent} tone={entry.tone} size={size.glyph} color={colors.foregroundMuted} />
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: ink, fontSize: size.text, lineHeight: size.line }}>
          {name}
        </Text>
        {when ? (
          <Text style={{ color: hovered ? colors.foreground : colors.foregroundMuted, fontSize: size.small, lineHeight: size.line, fontVariant: TABULAR }}>{when}</Text>
        ) : null}
        <Text
          style={{
            minWidth: size.figure,
            textAlign: "right",
            color: toneColor(theme, entry.tone, ink),
            fontSize: size.text,
            lineHeight: size.line,
            fontVariant: TABULAR,
          }}
        >
          {full ? "Full" : formatPercent(limit.usedPercent)}
        </Text>
      </View>
      <Bar
        percent={Math.min(100, Math.max(0, limit.usedPercent))}
        fill={toneColor(theme, entry.tone, lead ? colors.foreground : colors.foregroundMuted)}
        track={colors.surface2}
        delay={delay}
        reduceMotion={reduceMotion}
        inset={size.glyph + size.gap}
        height={size.bar}
      />
    </Pressable>
  );
}

/** A thin bar that fills to `percent`, easing in when the card opens and when the reading moves. */
function Bar({
  percent,
  fill,
  track,
  delay,
  reduceMotion,
  inset,
  height,
}: {
  percent: number;
  fill: string;
  track: string;
  delay: number;
  reduceMotion: boolean;
  /** Lines the bar up with the window's name. */
  inset: number;
  height: number;
}) {
  const progress = useRef(new Animated.Value(reduceMotion ? percent : 0)).current;
  useEffect(() => {
    if (reduceMotion) {
      progress.stopAnimation();
      progress.setValue(percent);
      return undefined;
    }
    const animation = Animated.timing(progress, {
      toValue: percent,
      duration: BAR_MS,
      delay,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animation.start();
    return () => animation.stop();
  }, [percent, delay, reduceMotion, progress]);
  const width = progress.interpolate({ inputRange: [0, 100], outputRange: ["0%", "100%"], extrapolate: "clamp" });
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(percent) }}
      style={{ marginLeft: inset, height, borderRadius: height / 2, backgroundColor: track, overflow: "hidden" }}
    >
      <Animated.View style={{ width, height, borderRadius: height / 2, backgroundColor: fill }} />
    </View>
  );
}

function Footer({
  theme,
  account,
  credits,
  now,
  size,
  onAccounts,
}: {
  theme: Theme;
  account: AccountView | null;
  credits: string | null;
  now: number;
  size: Size;
  onAccounts(): void;
}) {
  const colors = theme.colors;
  const source = account ? [account.label, account.usage ? formatAge(account.usage.fetchedAt, now) : null, credits].filter(Boolean).join(" · ") : null;
  return (
    <View style={{ gap: size.gap }}>
      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foregroundMuted, fontSize: size.small }}>
          {source}
        </Text>
        <Pressable accessibilityRole="link" accessibilityLabel="Open the Accounts screen" onPress={onAccounts} hitSlop={size.hitSlop}>
          {({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => {
            const tint = pressed || hovered ? colors.foreground : colors.foregroundMuted;
            return (
              <View style={{ flexDirection: "row", alignItems: "center", gap: 2 }}>
                <Text style={{ color: tint, fontSize: size.small }}>Accounts</Text>
                <Icon name="ArrowUpRight" size={size.small} color={tint} />
              </View>
            );
          }}
        </Pressable>
      </View>
    </View>
  );
}

/** The time, ticking every `intervalMs`, so countdowns move while the card stays open. */
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The system's reduce-motion setting; motion stays on where it can't be read. */
function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    const check = AccessibilityInfo.isReduceMotionEnabled as (() => Promise<boolean>) | undefined;
    if (!check) return undefined;
    check()
      .then((value) => {
        if (live) setReduce(value);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return reduce;
}
