import type { PluginButtonContentProps, PluginHostProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  AccessibilityInfo,
  Animated,
  Easing,
  type GestureResponderEvent,
  PanResponder,
  type PanResponderGestureState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { describeReopen, formatPercent } from "../shared/format";
import { FAMILY_LABEL, OTHER_FAMILY, type AccountView, type Family } from "../shared/model";
import { setAgentAccount, setAgentAccounts, useOthersOnce } from "../shared/rpc";
import {
  agentPlan,
  canUse,
  describeUse,
  draftOf,
  moved,
  smartOrder,
  detailReason,
  spokenDetails,
  statusLine,
  toggled,
  type AccountWindowLine,
  type AgentAccountRow,
  type AgentDraft,
  type AgentPlan,
  type NextTurn,
} from "./agent-plan";
import type { TrackedAgent } from "./agent-account";
import { forkPopover } from "./fork-confirm";
import { resetPopover } from "./reset-confirm";
import { stoppedWaiting, useStore, VISIBLE_POLL_MS, type ZeroSubStore } from "./store";
import { Glyph, toneColor } from "./usage-icon";

type Theme = PluginHostProps["theme"];

/** Below this width Paseo shows the panel as a bottom sheet: larger rows, a long press to lift. */
const COMPACT_WIDTH = 600;
const PANEL_WIDTH = 296;

/** Two scales, one rhythm: the mouse gets a dense list, a finger gets 44-point rows. */
export const SIZE = {
  regular: { row: 32, divider: 13, text: 13, small: 12, glyph: 14, check: 14, gap: 10, pad: 6, grip: 0, choice: 22 },
  compact: { row: 44, divider: 17, text: 15, small: 13, glyph: 16, check: 18, gap: 12, pad: 8, grip: 36, choice: 30 },
} as const;
export type Size = (typeof SIZE)[keyof typeof SIZE];

/** How long a finger rests on a handle before the row lifts, so the sheet still scrolls under it. */
const LONG_PRESS_MS = 420;
const LIFT_SCALE = 1.02;
/** The browser clicks the row it releases a drag on; a press this soon after a drop is that click. */
const DROP_CLICK_MS = 350;
/** Saved this long after the last change, so a few quick edits make one request. */
const SAVE_DELAY_MS = 450;
const UNDO_MS = 5_000;
const HINT_MS = 2_400;
const TICK_MS = 30_000;
const TABULAR = ["tabular-nums" as const];
/** The pointer rests this long on a row before its details show; once they have, the next row's show at once. */
export const PEEK_DWELL_MS = 380;
export const PEEK_WARM_MS = 500;
const PEEK_FADE_MS = 140;
/** Between a row and its details, and inside the details' card. */
const PEEK_GAP = 4;
const PEEK_PAD = 8;

/**
 * Critically damped (damping = 2·√(stiffness·mass)): it settles in about a third of a second
 * without overshoot, and picks up from wherever a row is, mid-flight included.
 */
const SPRING = { stiffness: 320, damping: 2 * Math.sqrt(320), mass: 1 } as const;
const NATIVE = Platform.OS !== "web";
/** Hover and press fade on the web instead of snapping; native has no hover. */
export const FADE = Platform.OS === "web" ? ({ transitionProperty: "background-color, opacity", transitionDuration: "120ms" } as object) : {};

export function spring(value: Animated.Value, toValue: number, velocity = 0): Animated.CompositeAnimation {
  return Animated.spring(value, { toValue, velocity, ...SPRING, useNativeDriver: NATIVE });
}

/** For layout values (a width), which the native driver can't animate. */
function springLayout(value: Animated.Value, toValue: number): Animated.CompositeAnimation {
  return Animated.spring(value, { toValue, ...SPRING, useNativeDriver: false });
}

/** A theme colour as six hex digits; null when it isn't #rgb or #rrggbb. */
function hexOf(color: string): string | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)?.[1];
  if (!hex) return null;
  return hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
}

/** A theme colour at `opacity`; anything but #rgb or #rrggbb stays as it is. */
export function withAlpha(color: string, opacity: number): string {
  const full = hexOf(color);
  if (!full) return color;
  return `#${full}${Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0")}`;
}

/** Whether the theme is a dark one, read from its base surface (the theme has no flag for it). */
export function isDark(theme: Theme): boolean {
  const full = hexOf(theme.colors.surface0);
  if (!full) return false;
  const [r, g, b] = [0, 2, 4].map((at) => parseInt(full.slice(at, at + 2), 16) / 255) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/**
 * The panel an agent's account pill opens: which accounts this conversation may use, in which
 * order, and where its next turn runs.
 *
 * - One line per account: a check, the glyph of the limit that holds it back, its name, and one
 *   figure (the share used, or once full the wait). A dot marks where the agent runs. Unchecked
 *   accounts sit below a hairline, dimmed: never used for this agent (unless it may overflow).
 * - "Smart": the planner orders them, keeping each model's own room in mind. "My order": the order
 *   the user drags (the row itself with a mouse, a handle with a finger), full accounts skipped.
 * - A line about the next turn only when there is something to say: it moves, or everything checked
 *   is full (then "Use others once").
 *
 * Changes save on their own a moment later. One component for every agent, so pills keep it.
 */
export function agentAccounts(
  store: ZeroSubStore,
  agentOf: (agentId: string) => TrackedAgent | undefined,
  openAccounts: () => void,
): ComponentType<PluginButtonContentProps> {
  function AgentAccounts(props: PluginButtonContentProps) {
    const { theme, close } = props;
    const { state } = useStore(store);
    const now = useNow(TICK_MS);
    const reduceMotion = useReducedMotion();
    const { width } = useWindowDimensions();
    const compact = width < COMPACT_WIDTH;
    const size = compact ? SIZE.compact : SIZE.regular;
    const toast = useToast();
    useEffect(() => store.watch(VISIBLE_POLL_MS), []);

    const agentId = props.context === "agent" ? props.agentId : null;
    const agent = agentId ? agentOf(agentId) : undefined;
    const family = state && agent ? state.providers[agent.provider] : undefined;
    const route = state && agentId ? state.agents.find((entry) => entry.agentId === agentId) : undefined;
    const model = route?.model ?? agent?.model ?? null;

    // The edit in progress; until the first one, the saved choice (or every account) shows.
    const [local, setLocal] = useState<AgentDraft | null>(null);
    // A way out (a banked reset, the other provider) opens in place of the list.
    const [Sheet, setSheet] = useState<ComponentType<PluginButtonContentProps> | null>(null);
    const [undo, setUndo] = useState<AgentDraft | null>(null);
    const [hint, setHint] = useState<string | null>(null);
    const [shakeId, setShakeId] = useState<{ id: string; at: number } | null>(null);
    // What a hovered choice does, said in place of its line's label.
    const [modeHint, setModeHint] = useState<string | null>(null);
    const [overflowHint, setOverflowHint] = useState<string | null>(null);
    // The panel's height, so a row's details open on the side with room.
    const [panelHeight, setPanelHeight] = useState(0);
    const pending = useRef<AgentDraft | null>(null);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

    function flush(): void {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const next = pending.current;
      pending.current = null;
      if (!next || !agentId) return;
      store
        .rpc(setAgentAccounts, { agentId, accounts: next })
        .then((summary) => {
          if (summary.reopened.length + summary.deferred.length + summary.failed.length > 0 || summary.continuedIn) {
            toast.show(describeReopen("Saved", summary), { variant: "success", durationMs: 3_000 });
          }
          return undefined;
        })
        .catch((error: unknown) => {
          setLocal(null);
          toast.error(error instanceof Error ? error.message : "Could not save this agent's accounts.");
        });
    }

    useEffect(
      () => () => {
        // Closing the panel saves what was changed right away.
        flush();
        for (const pendingTimer of [undoTimer.current, hintTimer.current]) if (pendingTimer) clearTimeout(pendingTimer);
      },
      [],
    );

    const accounts = useMemo(() => (state && family ? state.accounts.filter((account) => account.family === family) : []), [state, family]);
    const smart = useMemo(() => (state && family ? smartOrder(state, route, family, model, now) : []), [state, route, family, model, now]);
    const saved = route?.accounts ?? null;
    const draft = local ?? draftOf(saved, accounts, smart);
    const plan = state && family ? agentPlan(state, route, family, model, draft, local !== null || saved !== null, now) : null;

    if (!state || !agentId || !family || !plan) {
      return (
        <View style={{ width: compact ? undefined : PANEL_WIDTH }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: size.small }}>Loading…</Text>
        </View>
      );
    }

    if (Sheet) return <Sheet {...props} />;

    function change(next: AgentDraft, options: { undoable?: AgentDraft } = {}): void {
      setLocal(next);
      pending.current = next;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SAVE_DELAY_MS);
      if (options.undoable) {
        setUndo(options.undoable);
        if (undoTimer.current) clearTimeout(undoTimer.current);
        undoTimer.current = setTimeout(() => setUndo(null), UNDO_MS);
      }
    }

    function say(message: string): void {
      setHint(message);
      AccessibilityInfo.announceForAccessibility?.(message);
      if (hintTimer.current) clearTimeout(hintTimer.current);
      hintTimer.current = setTimeout(() => setHint(null), HINT_MS);
    }

    const shown = plan.checked.map((row) => row.id);
    const onToggle = (id: string) => {
      const next = toggled(draft, id);
      if (!next) {
        setShakeId({ id, at: Date.now() });
        say("Keep at least one account");
        return;
      }
      change(next);
    };
    const onMove = (id: string, index: number) => {
      const next = moved(draft, shown, id, index);
      if (draft.mode === "smart") {
        change(next, { undoable: draft });
        AccessibilityInfo.announceForAccessibility?.("Switched to My order");
      } else change(next);
    };
    const onMode = (mode: AgentDraft["mode"]) => {
      if (mode === draft.mode) return;
      setUndo(null);
      // My order starts from the order on screen.
      change(mode === "manual" ? { ...draft, mode, order: [...shown, ...draft.order.filter((id) => !shown.includes(id))] } : { ...draft, mode });
    };
    const onOverflow = (overflow: AgentDraft["overflow"]) => {
      if (overflow !== draft.overflow) change({ ...draft, overflow });
    };
    const onOnce = () => {
      flush();
      store
        .rpc(useOthersOnce, { agentId })
        .then((summary) => toast.show(describeReopen("Carrying on with an unchecked account", summary), { variant: "success", durationMs: 4_000 }))
        .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "No other account can take it."));
    };
    const onFollow = () => {
      store
        .rpc(setAgentAccount, { agentId, accountId: null })
        // The move goes on without Paseo waiting for it, and the pill shows it under way.
        .catch((error: unknown) => (stoppedWaiting(error) ? undefined : toast.error(error instanceof Error ? error.message : String(error))));
    };
    // Moves the agent there now, whatever the order says; an account not checked yet gets checked,
    // and an edit not sent yet goes in the same request.
    const onUse = (id: string) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
      const unsent = pending.current !== null;
      pending.current = null;
      const next = draft.pool.includes(id) ? draft : (toggled(draft, id) ?? draft);
      if (next !== draft) setLocal(next);
      const label = labelOf(accounts, id);
      store
        .rpc(setAgentAccount, { agentId, accountId: id, accounts: unsent || next !== draft ? next : undefined })
        .then((summary) => toast.show(describeUse(label, summary), { variant: "success", durationMs: 3_000 }))
        .catch((error: unknown) => toast.error(error instanceof Error ? error.message : `Could not move this agent to ${label}.`));
    };
    const onUndo = () => {
      if (!undo) return;
      change(undo);
      setUndo(null);
    };

    const nowOn = plan.nowOn;
    const resets = nowOn.usage?.resets ?? null;
    const offerReset = resets !== null && (nowOn.status === "limited" || resets.usableNow);
    // Pi has no other provider to carry on with.
    const other = OTHER_FAMILY[family];
    const offerFork =
      other !== null &&
      nowOn.status === "limited" &&
      accounts.every((account) => account.status !== "ready") &&
      state.accounts.some((account) => account.family === other && account.status === "ready");
    const quiet = plan.next.kind === "stay" && plan.next.quiet === true;
    const title = hint ?? (undo ? "Switched to My order" : (modeHint ?? plan.model ?? "Model not known yet"));
    const titleLit = hint !== null || undo !== null || modeHint !== null;

    return (
      <View
        onLayout={(event) => {
          const height = Math.round(event.nativeEvent.layout.height);
          setPanelHeight((previous) => (previous === height ? previous : height));
        }}
        style={{ width: compact ? undefined : PANEL_WIDTH, alignSelf: compact ? "stretch" : undefined, gap: 8 }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.choice }}>
          <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 }}>
            <Text
              numberOfLines={1}
              accessibilityLiveRegion="polite"
              aria-live="polite"
              style={{ flexShrink: 1, color: titleLit ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: size.small, ...FADE }}
            >
              {title}
            </Text>
            {undo && !hint ? <TextButton theme={theme} size={size} label="Undo" onPress={onUndo} /> : null}
          </View>
          <InlineChoice
            theme={theme}
            size={size}
            reduceMotion={reduceMotion}
            value={draft.mode}
            options={[
              { value: "smart", label: "Smart", spoken: `Smart for ${plan.modelShort}`, hint: `By room left for ${plan.modelShort}` },
              { value: "manual", label: "My order", hint: "Your order, full ones skipped" },
            ]}
            onChange={onMode}
            onHint={setModeHint}
            label="How this agent's accounts are ordered"
          />
        </View>
        <AccountList
          theme={theme}
          plan={plan}
          size={size}
          compact={compact}
          reduceMotion={reduceMotion}
          shake={shakeId}
          panelHeight={panelHeight}
          onToggle={onToggle}
          onMove={onMove}
          onUse={onUse}
        />
        {quiet ? null : (
          <Status
            theme={theme}
            size={size}
            next={plan.next}
            byHand={state.autoSwitch === false}
            label={(id) => labelOf(accounts, id)}
            onOnce={onOnce}
            onUse={onUse}
          />
        )}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.choice + 4 }}>
          <Text
            numberOfLines={1}
            style={{ flex: 1, minWidth: 0, color: overflowHint ? theme.colors.foreground : theme.colors.foregroundMuted, fontSize: size.small, ...FADE }}
          >
            {overflowHint ?? "If all are full"}
          </Text>
          <InlineChoice
            theme={theme}
            size={size}
            reduceMotion={reduceMotion}
            value={draft.overflow}
            options={[
              { value: "wait", label: "Wait", spoken: "Wait, and get notified", hint: "Pause, notify me at the reset" },
              { value: "others", label: "Use others", spoken: "Use an unchecked account until one of yours resets", hint: "Borrow an unchecked account" },
            ]}
            onChange={onOverflow}
            onHint={setOverflowHint}
            label="When every checked account is full"
          />
        </View>
        <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border }} />
        <View>
          {offerReset && resets ? (
            <ActionRow
              theme={theme}
              size={size}
              icon="TimerReset"
              label={`Use a banked reset on ${nowOn.label}…`}
              detail={`${resets.available} left`}
              onPress={() => setSheet(() => resetPopover(store, nowOn, agentId))}
            />
          ) : null}
          {offerFork ? (
            <ActionRow theme={theme} size={size} icon="GitFork" label={`Continue on ${FAMILY_LABEL[other]}…`} onPress={() => setSheet(() => forkPopover(store, agentId, family, other))} />
          ) : null}
          {route?.pinned ? (
            <ActionRow
              theme={theme}
              size={size}
              icon="Undo2"
              label="Follow order"
              detail={plan.next.kind === "go" ? `moves to ${labelOf(accounts, plan.next.to)}` : undefined}
              hover="Unpin, let the order pick"
              onPress={onFollow}
            />
          ) : null}
          <ActionRow
            theme={theme}
            size={size}
            trailing="ArrowUpRight"
            label="Manage accounts"
            hover="Sign in, rename, turn off"
            onPress={() => {
              close();
              openAccounts();
            }}
          />
        </View>
      </View>
    );
  }
  AgentAccounts.displayName = "ZeroSubAgentAccounts";
  return AgentAccounts;
}

function labelOf(accounts: readonly AccountView[], id: string): string {
  return accounts.find((account) => account.id === id)?.label ?? id;
}

/**
 * A choice between a few words, set in a line of text: the picked word sits on a soft chip that
 * glides to the next one. No track, no border; the words carry it.
 */
function InlineChoice<T extends string>({
  theme,
  size,
  reduceMotion,
  value,
  options,
  onChange,
  onHint,
  label,
}: {
  theme: Theme;
  size: Size;
  reduceMotion: boolean;
  value: T;
  /** `hint`: what the option does, shown in its line's label while the pointer is on it. */
  options: ReadonlyArray<{ value: T; label: string; spoken?: string; hint?: string }>;
  onChange(value: T): void;
  onHint?(hint: string | null): void;
  label: string;
}) {
  const colors = theme.colors;
  const [frames, setFrames] = useState<Partial<Record<T, { x: number; width: number }>>>({});
  const x = useRef(new Animated.Value(0)).current;
  const width = useRef(new Animated.Value(0)).current;
  const placed = useRef(false);
  const frame = frames[value];
  useEffect(() => {
    if (!frame) return undefined;
    if (!placed.current || reduceMotion) {
      placed.current = true;
      x.setValue(frame.x);
      width.setValue(frame.width);
      return undefined;
    }
    const animation = Animated.parallel([springLayout(x, frame.x), springLayout(width, frame.width)]);
    animation.start();
    return () => animation.stop();
  }, [frame?.x, frame?.width, reduceMotion, x, width]);
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={{ flexDirection: "row", alignItems: "center", marginRight: -(size.pad + 1) }}>
      {frame ? (
        <Animated.View
          pointerEvents="none"
          style={{ position: "absolute", left: 0, top: 0, height: size.choice, width, borderRadius: 6, backgroundColor: colors.surface2, transform: [{ translateX: x }] }}
        />
      ) : null}
      {options.map((option) => {
        const picked = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityState={{ checked: picked }}
            aria-checked={picked}
            accessibilityLabel={option.spoken ?? option.label}
            hitSlop={4}
            onHoverIn={() => onHint?.(option.hint ?? null)}
            onHoverOut={() => onHint?.(null)}
            onPress={() => onChange(option.value)}
            onLayout={(event) => {
              const { x: left, width: wide } = event.nativeEvent.layout;
              setFrames((previous) => (previous[option.value]?.x === left && previous[option.value]?.width === wide ? previous : { ...previous, [option.value]: { x: left, width: wide } }));
            }}
          >
            {({ hovered }: { pressed: boolean; hovered?: boolean }) => (
              <View style={{ height: size.choice, paddingHorizontal: size.pad + 1, justifyContent: "center" }}>
                <Text numberOfLines={1} style={{ color: picked || hovered ? colors.foreground : colors.foregroundMuted, fontSize: size.small, ...FADE }}>
                  {option.label}
                </Text>
              </View>
            )}
          </Pressable>
        );
      })}
    </View>
  );
}

interface Motion {
  y: Animated.Value;
  scale: Animated.Value;
  target: number;
}

/**
 * The agent's accounts: its checked ones in the order its turns try them, then the others below a
 * hairline. Every row sits at a slot it springs to, so a change of order or a box checked moves
 * rows rather than redrawing them (FLIP). A checked row can be dragged, or moved with the screen
 * reader's actions or the arrow keys.
 *
 * Resting the pointer on a row (or holding a finger on it, or tabbing to it) opens its details just
 * below it, or above when the panel has no room below: every limit that applies to this agent and
 * when it resets, and why the row sits where it does.
 */
function AccountList({
  theme,
  plan,
  size,
  compact,
  reduceMotion,
  shake,
  panelHeight,
  onToggle,
  onMove,
  onUse,
}: {
  theme: Theme;
  plan: AgentPlan;
  size: Size;
  compact: boolean;
  reduceMotion: boolean;
  shake: { id: string; at: number } | null;
  /** The whole panel's height, to tell which side of a row has room for its details. */
  panelHeight: number;
  onToggle(id: string): void;
  onMove(id: string, index: number): void;
  /** Moves the agent to this account now. */
  onUse(id: string): void;
}) {
  const rowH = size.row;
  const motions = useRef(new Map<string, Motion>()).current;
  const dividerShown = plan.others.length > 0;
  const [drag, setDrag] = useState<{ id: string; over: number } | null>(null);
  // The row whose details show; `instant` when they move over from another row.
  const [peek, setPeek] = useState<{ id: string; instant: boolean } | null>(null);
  const [listTop, setListTop] = useState(0);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peekShown = useRef<string | null>(null);
  const peekLeftAt = useRef(0);
  const hovering = useRef<string | null>(null);
  peekShown.current = peek?.id ?? null;
  useEffect(
    () => () => {
      if (peekTimer.current) clearTimeout(peekTimer.current);
    },
    [],
  );

  const peeks = (id: string): Peek => {
    const wait = () => {
      if (peekTimer.current) clearTimeout(peekTimer.current);
      peekTimer.current = null;
    };
    return {
      enter() {
        hovering.current = id;
        wait();
        // Details that just closed on a neighbour open here at once: the pointer is reading down the list.
        if (Date.now() - peekLeftAt.current < PEEK_WARM_MS) setPeek({ id, instant: true });
        else peekTimer.current = setTimeout(() => setPeek({ id, instant: false }), PEEK_DWELL_MS);
      },
      leave() {
        if (hovering.current === id) hovering.current = null;
        wait();
        if (peekShown.current !== id) return;
        peekLeftAt.current = Date.now();
        setPeek(null);
      },
      focus() {
        // A click focuses the row too: only a keyboard's focus (no pointer on the list) opens them.
        if (compact || hovering.current !== null) return;
        wait();
        setPeek({ id, instant: peekShown.current !== null });
      },
      show() {
        wait();
        setPeek({ id, instant: false });
      },
      hide() {
        wait();
        // Pressing means acting, not reading: the next row waits again.
        peekLeftAt.current = 0;
        if (peekShown.current !== null) setPeek(null);
      },
    };
  };

  // While a row is dragged, the others make room for it at the slot it hovers.
  const checkedIds = plan.checked.map((row) => row.id);
  const order = drag ? withMoved(checkedIds, drag.id, drag.over) : checkedIds;
  const slots = new Map<string, number>();
  order.forEach((id, index) => slots.set(id, index * rowH));
  const dividerY = order.length * rowH;
  plan.others.forEach((row, index) => slots.set(row.id, dividerY + size.divider + index * rowH));
  const total = dividerY + (dividerShown ? size.divider + plan.others.length * rowH : 0);
  const divider = useRef(new Animated.Value(dividerY)).current;
  const dividerAt = useRef(dividerY);

  const motionOf = (id: string): Motion => {
    let motion = motions.get(id);
    if (!motion) {
      const target = slots.get(id) ?? 0;
      motion = { y: new Animated.Value(target), scale: new Animated.Value(1), target };
      motions.set(id, motion);
    }
    return motion;
  };

  useEffect(() => {
    for (const [id, top] of slots) {
      const motion = motionOf(id);
      if (drag?.id === id || motion.target === top) continue;
      motion.target = top;
      if (reduceMotion) motion.y.setValue(top);
      else spring(motion.y, top).start();
    }
    if (dividerAt.current !== dividerY) {
      dividerAt.current = dividerY;
      if (reduceMotion) divider.setValue(dividerY);
      else spring(divider, dividerY).start();
    }
  });

  const all: Array<{ row: AgentAccountRow; index: number }> = [
    ...plan.checked.map((row, index) => ({ row, index })),
    ...plan.others.map((row) => ({ row, index: -1 })),
  ];

  const peekRow = peek && !drag ? all.find((entry) => entry.row.id === peek.id)?.row : undefined;
  const peekTop = peekRow ? listTop + (slots.get(peekRow.id) ?? 0) : 0;

  return (
    <View
      onLayout={(event) => {
        const top = Math.round(event.nativeEvent.layout.y);
        setListTop((previous) => (previous === top ? previous : top));
      }}
      // Above the lines that follow, so a row's details can open over them.
      style={{ height: total, marginHorizontal: -size.pad, zIndex: 1 }}
    >
      {dividerShown ? (
        <Animated.View
          pointerEvents="none"
          style={{ position: "absolute", left: size.pad, right: size.pad, height: size.divider, justifyContent: "center", transform: [{ translateY: divider }] }}
        >
          <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: theme.colors.border }} />
        </Animated.View>
      ) : null}
      {all.map(({ row, index }) => (
        <AccountRowView
          key={row.id}
          theme={theme}
          row={row}
          index={index}
          count={plan.checked.length}
          size={size}
          compact={compact}
          reduceMotion={reduceMotion}
          motion={motionOf(row.id)}
          lifted={drag?.id === row.id}
          shakeAt={shake?.id === row.id ? shake.at : 0}
          peek={peeks(row.id)}
          onToggle={() => onToggle(row.id)}
          onUse={canUse(row) ? () => onUse(row.id) : undefined}
          onDrag={(over) => {
            if (over !== null && drag === null) peeks(row.id).hide();
            setDrag(over === null ? null : { id: row.id, over });
          }}
          onDrop={(over) => {
            setDrag(null);
            if (over !== index) onMove(row.id, over);
          }}
          onStep={(delta) => {
            const next = index + delta;
            if (next >= 0 && next < plan.checked.length) onMove(row.id, next);
          }}
        />
      ))}
      {peekRow ? (
        <PeekCard
          key={peekRow.id}
          theme={theme}
          size={size}
          row={peekRow}
          y={motionOf(peekRow.id).y}
          above={peekTop}
          below={panelHeight - peekTop - rowH}
          instant={peek?.instant === true}
          reduceMotion={reduceMotion}
        />
      ) : null}
    </View>
  );
}

/** What a row tells the list about the pointer, a finger or the focus resting on it. */
interface Peek {
  enter(): void;
  leave(): void;
  focus(): void;
  show(): void;
  hide(): void;
}

/**
 * A row's details, floating just under it (over it when there is no room below) and following it
 * when it moves: each limit that applies to the agent, when it resets and how much is used, then
 * why the row sits where it does. It reads, it is never pressed: the pointer goes through it.
 */
export function PeekCard({
  theme,
  size,
  row,
  y,
  above,
  below,
  instant,
  reduceMotion,
}: {
  theme: Theme;
  size: Size;
  row: Pick<AgentAccountRow, "now" | "lines" | "note" | "why">;
  /** The row's own position, which the card follows. */
  y: Animated.Value;
  /** Room in the panel above the row's top, and below its bottom. */
  above: number;
  below: number;
  instant: boolean;
  reduceMotion: boolean;
}) {
  const colors = theme.colors;
  const dark = isDark(theme);
  const [height, setHeight] = useState<number | null>(null);
  const fade = useRef(new Animated.Value(0)).current;
  const measured = height !== null;
  const need = (height ?? 0) + PEEK_GAP;
  const up = measured && below < need && above > below;
  const offset = up ? -need : size.row + PEEK_GAP;
  const translateY = useMemo(() => y.interpolate({ inputRange: [0, 1], outputRange: [offset, offset + 1] }), [y, offset]);
  const drift = useMemo(() => fade.interpolate({ inputRange: [0, 1], outputRange: [up ? 3 : -3, 0] }), [fade, up]);

  // Shown once measured, so it never flashes on the wrong side.
  useEffect(() => {
    if (!measured) return undefined;
    if (instant || reduceMotion) {
      fade.setValue(1);
      return undefined;
    }
    const animation = Animated.timing(fade, { toValue: 1, duration: PEEK_FADE_MS, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE });
    animation.start();
    return () => animation.stop();
  }, [measured]);

  const text = { fontSize: size.small, lineHeight: size.small + 5 };
  const reason = row.note ?? detailReason(row.why);
  return (
    <Animated.View
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.height);
        setHeight((previous) => (previous === next ? previous : next));
      }}
      style={{
        position: "absolute",
        top: 0,
        // The card's lines sit under the row's: glyphs under its glyph, names under its name.
        left: size.pad + size.check + size.gap - PEEK_PAD,
        right: 0,
        zIndex: 3,
        opacity: fade,
        transform: [{ translateY }, { translateY: drift }],
      }}
    >
      <View
        style={{
          gap: 6,
          paddingVertical: PEEK_PAD - 1,
          paddingHorizontal: PEEK_PAD,
          borderRadius: 9,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: dark ? withAlpha(colors.foreground, 0.1) : colors.border,
          backgroundColor: dark ? colors.surface1 : colors.surface0,
          ...({
            boxShadow: dark ? "0px 10px 28px rgba(0, 0, 0, 0.45)" : "0px 10px 28px rgba(0, 0, 0, 0.10), 0px 1px 3px rgba(0, 0, 0, 0.05)",
          } as object),
        }}
      >
        {row.now ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: size.gap }}>
            <View style={{ width: size.glyph, alignItems: "center" }}>
              <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.accent }} />
            </View>
            <Text numberOfLines={1} style={{ flex: 1, color: colors.foreground, ...text }}>
              Runs this agent now
            </Text>
          </View>
        ) : null}
        {row.lines.length > 0 ? (
          <View>
            {row.lines.map((line, index) => (
              <LimitLine key={`${index}:${line.name}`} theme={theme} size={size} line={line} />
            ))}
          </View>
        ) : null}
        {reason ? (
          <Text numberOfLines={3} style={{ color: colors.foregroundMuted, ...text, paddingLeft: size.glyph + size.gap }}>
            {reason}
          </Text>
        ) : null}
      </View>
    </Animated.View>
  );
}

/**
 * One limit in a row's details: its glyph and name, when it resets, how much is used. Another
 * model's limit (Fable's, for an Opus agent) shows in grey with "only": it weighs in the plan but
 * doesn't stop this agent.
 */
function LimitLine({ theme, size, line }: { theme: Theme; size: Size; line: AccountWindowLine }) {
  const colors = theme.colors;
  const text = { fontSize: size.small, lineHeight: size.small + 7 };
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: size.gap }}>
      <View style={{ width: size.glyph, alignItems: "center", opacity: line.applies ? 1 : 0.6 }}>
        <Glyph
          theme={theme}
          kind={line.kind}
          usedPercent={line.usedPercent}
          tone={line.applies ? line.tone : "calm"}
          size={size.glyph - 2}
          color={colors.foregroundMuted}
        />
      </View>
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foregroundMuted, ...text }}>
        {line.applies ? line.name : `${line.name} only`}
      </Text>
      {line.resets ? <Text style={{ color: colors.foregroundMuted, fontVariant: TABULAR, ...text }}>{line.resets}</Text> : null}
      <Text
        style={{
          minWidth: 32,
          textAlign: "right",
          color: line.applies ? toneColor(theme, line.tone, colors.foreground) : colors.foregroundMuted,
          fontVariant: TABULAR,
          ...text,
        }}
      >
        {line.full ? "Full" : formatPercent(line.usedPercent)}
      </Text>
    </View>
  );
}

function withMoved(ids: readonly string[], id: string, index: number): string[] {
  const rest = ids.filter((candidate) => candidate !== id);
  rest.splice(Math.max(0, Math.min(rest.length, index)), 0, id);
  return rest;
}

/** What a drag reads when it moves: refreshed on every render, read by a responder made once. */
interface Live {
  index: number;
  count: number;
  rowH: number;
  compact: boolean;
  reduceMotion: boolean;
  onDrag(over: number | null): void;
  onDrop(over: number): void;
  /** A drag just ended: the click the browser sends after the release must not toggle the row. */
  onSettled(): void;
}

/**
 * Lifts a checked row and carries it. "row": the whole row, once a press moves a few points up or
 * down (a still click toggles it). "handle": a handle that takes the touch at once and lifts after
 * a long press, so the sheet still scrolls under a finger that only passes.
 */
function dragResponder(motion: Motion, live: { current: Live }, mode: "row" | "handle") {
  let start = 0;
  let grab = 0;
  let over = 0;
  let liftedNow = false;
  let wait: ReturnType<typeof setTimeout> | null = null;
  const vertical = (gesture: PanResponderGestureState) => Math.abs(gesture.dy) > 4 && Math.abs(gesture.dy) > Math.abs(gesture.dx);
  const lift = (dy: number) => {
    const { index: at, rowH: height, reduceMotion: still } = live.current;
    if (at < 0) return;
    liftedNow = true;
    start = at * height;
    grab = dy;
    over = at;
    motion.y.stopAnimation();
    motion.y.setValue(start);
    if (!still) spring(motion.scale, LIFT_SCALE).start();
    live.current.onDrag(at);
  };
  const settle = (velocity: number) => {
    if (wait) clearTimeout(wait);
    wait = null;
    if (!liftedNow) return;
    liftedNow = false;
    live.current.onSettled();
    const { rowH: height, reduceMotion: still } = live.current;
    motion.target = over * height;
    if (still) {
      motion.y.setValue(motion.target);
      motion.scale.setValue(1);
    } else {
      spring(motion.y, motion.target, velocity).start();
      spring(motion.scale, 1).start();
    }
    live.current.onDrop(over);
  };
  return PanResponder.create({
    onStartShouldSetPanResponder: () => mode === "handle" && live.current.index >= 0,
    onMoveShouldSetPanResponderCapture: (_event: GestureResponderEvent, gesture: PanResponderGestureState) =>
      mode === "row" && live.current.index >= 0 && vertical(gesture),
    onMoveShouldSetPanResponder: (_event: GestureResponderEvent, gesture: PanResponderGestureState) =>
      live.current.index >= 0 && (mode === "handle" || vertical(gesture)),
    onPanResponderGrant: (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      if (mode === "handle" && live.current.compact) wait = setTimeout(() => lift(0), LONG_PRESS_MS);
      else lift(gesture.dy);
    },
    onPanResponderMove: (_event: GestureResponderEvent, gesture: PanResponderGestureState) => {
      if (!liftedNow) {
        // A finger that moves before the row lifts was scrolling the sheet: let it.
        if (Math.abs(gesture.dy) > 8 && wait) {
          clearTimeout(wait);
          wait = null;
        }
        return;
      }
      const { count: n, rowH: height } = live.current;
      const y = Math.max(-height * 0.35, Math.min((n - 1) * height + height * 0.35, start + gesture.dy - grab));
      motion.y.setValue(y);
      const next = Math.max(0, Math.min(n - 1, Math.round(y / height)));
      if (next !== over) {
        over = next;
        live.current.onDrag(next);
      }
    },
    onPanResponderTerminationRequest: () => !liftedNow,
    onPanResponderRelease: (_event: GestureResponderEvent, gesture: PanResponderGestureState) => settle(Math.max(-1500, Math.min(1500, gesture.vy * 1000))),
    onPanResponderTerminate: () => settle(0),
    onShouldBlockNativeResponder: () => true,
  });
}

function AccountRowView({
  theme,
  row,
  index,
  count,
  size,
  compact,
  reduceMotion,
  motion,
  lifted,
  shakeAt,
  peek,
  onToggle,
  onUse,
  onDrag,
  onDrop,
  onStep,
}: {
  theme: Theme;
  row: AgentAccountRow;
  /** Its place among the checked accounts; -1 when unchecked. */
  index: number;
  count: number;
  size: Size;
  compact: boolean;
  reduceMotion: boolean;
  motion: Motion;
  lifted: boolean;
  shakeAt: number;
  peek: Peek;
  onToggle(): void;
  /** Moves the agent here now; absent where it can't go (it runs here, or the account is full or off). */
  onUse?: () => void;
  onDrag(over: number | null): void;
  onDrop(over: number): void;
  onStep(delta: -1 | 1): void;
}) {
  const colors = theme.colors;
  const checked = row.checked;
  const rowH = size.row;
  const movable = index >= 0;
  const shakeX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!shakeAt || reduceMotion) return undefined;
    const sequence = Animated.sequence(
      [4, -4, 2.5, -2.5, 1, 0].map((toValue) => Animated.timing(shakeX, { toValue, duration: 45, useNativeDriver: NATIVE })),
    );
    sequence.start();
    return () => sequence.stop();
  }, [shakeAt, reduceMotion, shakeX]);

  const droppedAt = useRef(0);
  const onSettled = () => {
    droppedAt.current = Date.now();
  };
  const live = useRef<Live>({ index, count, rowH, compact, reduceMotion, onDrag, onDrop, onSettled });
  live.current = { index, count, rowH, compact, reduceMotion, onDrag, onDrop, onSettled };
  // A mouse carries the whole row; a finger, the handle.
  const byRow = useMemo(() => dragResponder(motion, live, "row"), [motion]);
  const byHandle = useMemo(() => dragResponder(motion, live, "handle"), [motion]);

  const keys = {
    onKeyDown: (event: { key?: string; nativeEvent?: { key?: string }; preventDefault?(): void }) => {
      const key = event.key ?? event.nativeEvent?.key;
      if (movable && (key === "ArrowUp" || key === "ArrowDown")) {
        event.preventDefault?.();
        onStep(key === "ArrowUp" ? -1 : 1);
      }
    },
  };

  return (
    <Animated.View
      {...(compact ? {} : byRow.panHandlers)}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        height: rowH,
        zIndex: lifted ? 2 : 1,
        transform: [{ translateY: motion.y }, { scale: motion.scale }, { translateX: shakeX }],
        ...(Platform.OS === "web" ? ({ userSelect: "none", cursor: lifted ? "grabbing" : undefined } as object) : {}),
      }}
    >
      <Pressable
        {...(keys as object)}
        accessibilityRole="checkbox"
        accessibilityState={{ checked }}
        aria-checked={checked}
        accessibilityLabel={`Use ${row.label} for this agent${row.now ? ", runs here now" : ""}`}
        accessibilityHint={spokenDetails(row) || undefined}
        accessibilityActions={[
          ...(onUse ? [{ name: "useNow", label: "Use now" }] : []),
          ...(movable
            ? [
                { name: "moveUp", label: "Move up" },
                { name: "moveDown", label: "Move down" },
              ]
            : []),
        ]}
        onAccessibilityAction={(event) => {
          const action = event.nativeEvent.actionName;
          if (action === "useNow") onUse?.();
          else if (action === "moveUp") onStep(-1);
          else if (action === "moveDown") onStep(1);
        }}
        onHoverIn={peek.enter}
        onHoverOut={peek.leave}
        onFocus={peek.focus}
        onBlur={peek.leave}
        onPressIn={peek.hide}
        // A finger has no hover: holding it on the row shows the details, and lifting it hides them.
        onLongPress={compact ? peek.show : undefined}
        onPressOut={compact ? peek.hide : undefined}
        onPress={() => {
          if (Date.now() - droppedAt.current > DROP_CLICK_MS) onToggle();
        }}
        style={{ flex: 1 }}
      >
        {({ hovered, pressed }: { pressed: boolean; hovered?: boolean }) => (
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: size.gap,
              paddingLeft: size.pad,
              paddingRight: compact ? 0 : size.pad,
              borderRadius: 7,
              backgroundColor: lifted ? colors.surface0 : pressed ? colors.surface2 : hovered ? withAlpha(colors.surface2, 0.7) : withAlpha(colors.surface2, 0),
              ...({ boxShadow: lifted ? "0px 8px 24px rgba(0, 0, 0, 0.12), 0px 0px 0px 0.5px rgba(0, 0, 0, 0.06)" : "none" } as object),
              ...FADE,
            }}
          >
            <Check theme={theme} size={size.check} checked={checked} hovered={hovered === true} reduceMotion={reduceMotion} />
            <View style={{ opacity: checked ? 1 : 0.5 }}>
              <Glyph theme={theme} kind={row.glyph.kind} usedPercent={row.glyph.usedPercent} tone={row.glyph.tone} dashed={row.glyph.dashed} size={size.glyph} color={colors.foregroundMuted} />
            </View>
            <View style={{ flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 7 }}>
              <Text numberOfLines={1} style={{ flexShrink: 1, color: checked ? colors.foreground : colors.foregroundMuted, fontSize: size.text }}>
                {row.label}
              </Text>
              {row.now ? <View style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: colors.accent }} /> : null}
            </View>
            {/* A mouse on the row offers to move the agent there now, in place of the figure the details repeat. */}
            {onUse && hovered && !compact && !lifted ? (
              <TextButton theme={theme} size={size} label="Use now" spoken={`Move this agent to ${row.label} now`} onPress={onUse} />
            ) : (
              <Text style={{ color: colors.foregroundMuted, fontSize: size.small, fontVariant: TABULAR, opacity: checked ? 1 : 0.7 }}>{row.meta}</Text>
            )}
            {compact && movable ? (
              <View
                {...byHandle.panHandlers}
                accessible={false}
                importantForAccessibility="no-hide-descendants"
                style={{ width: size.grip, height: rowH, alignItems: "center", justifyContent: "center", opacity: lifted ? 0.8 : 0.4 }}
              >
                <Icon name="GripVertical" size={16} color={colors.foregroundMuted} />
              </View>
            ) : compact ? (
              // Keeps the figures of unchecked rows in line with the checked ones'.
              <View style={{ width: size.grip }} />
            ) : null}
          </View>
        )}
      </Pressable>
    </Animated.View>
  );
}

/** A round check: a hairline ring when off; on, a soft disc holding a fine tick that pops in. */
function Check({ theme, size, checked, hovered, reduceMotion }: { theme: Theme; size: number; checked: boolean; hovered: boolean; reduceMotion: boolean }) {
  const colors = theme.colors;
  const scale = useRef(new Animated.Value(1)).current;
  const was = useRef(checked);
  useEffect(() => {
    if (was.current === checked) return undefined;
    was.current = checked;
    if (reduceMotion || !checked) return undefined;
    scale.setValue(0.5);
    const animation = spring(scale, 1);
    animation.start();
    return () => animation.stop();
  }, [checked, reduceMotion, scale]);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: checked ? withAlpha(colors.foreground, hovered ? 0.14 : 0.09) : "transparent",
        borderWidth: checked ? 0 : 1,
        borderColor: withAlpha(colors.foregroundMuted, hovered ? 0.8 : 0.4),
        ...FADE,
      }}
    >
      {checked ? (
        <Animated.View style={{ transform: [{ scale }] }}>
          <Icon name="Check" size={Math.round(size * 0.7)} color={colors.foreground} />
        </Animated.View>
      ) : null}
    </View>
  );
}

/**
 * The next turn, said only when it matters: it moves ("Next turn on work"), or everything checked
 * is full ("All full for Fable", the wait, and "Use others once"). With automatic switching off
 * nothing moves on its own: the better account is offered instead ("Better on work", "Move now").
 */
function Status({
  theme,
  size,
  next,
  byHand,
  label,
  onOnce,
  onUse,
}: {
  theme: Theme;
  size: Size;
  next: NextTurn;
  /** Automatic switching is off: only the user moves the agent. */
  byHand: boolean;
  label(id: string): string;
  onOnce(): void;
  onUse(id: string): void;
}) {
  const colors = theme.colors;
  const { title, detail, offer } = statusLine(next, byHand, label);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 8, paddingTop: 2 }}>
      <View accessible accessibilityLiveRegion="polite" aria-live="polite" accessibilityLabel={[title, detail].filter(Boolean).join(". ")} style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={{ color: next.kind === "full" ? colors.statusWarning : colors.foreground, fontSize: size.small, lineHeight: size.small + 4 }}>
          {title}
        </Text>
        {detail ? (
          <Text numberOfLines={2} style={{ color: colors.foregroundMuted, fontSize: size.small, lineHeight: size.small + 4 }}>
            {detail}
          </Text>
        ) : null}
      </View>
      {next.kind === "full" && next.canOverflow ? <TextButton theme={theme} size={size} label="Use others once" onPress={onOnce} /> : null}
      {offer ? <TextButton theme={theme} size={size} label="Move now" spoken={`Move this agent to ${label(offer)} now`} onPress={() => onUse(offer)} /> : null}
    </View>
  );
}

export function ActionRow({
  theme,
  size,
  icon,
  trailing,
  label,
  detail,
  hover,
  onPress,
}: {
  theme: Theme;
  size: Size;
  icon?: string;
  trailing?: string;
  label: string;
  detail?: string;
  /** What it does, at the right while the pointer is on it (when there is no `detail` to show). */
  hover?: string;
  onPress(): void;
}) {
  const colors = theme.colors;
  return (
    <Pressable accessibilityRole="button" accessibilityHint={detail ?? hover} onPress={onPress}>
      {({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => {
        const tint = pressed || hovered ? colors.foreground : colors.foregroundMuted;
        const aside = detail ?? (hovered ? hover : undefined);
        return (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.choice + 6 }}>
            {icon ? <Icon name={icon} size={size.small + 1} color={tint} /> : null}
            <Text numberOfLines={1} style={{ flexShrink: 1, color: tint, fontSize: size.small, ...FADE }}>
              {label}
            </Text>
            {trailing ? <Icon name={trailing} size={size.small} color={tint} /> : null}
            {aside ? (
              <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, textAlign: "right", color: colors.foregroundMuted, fontSize: size.small, fontVariant: TABULAR }}>
                {aside}
              </Text>
            ) : null}
          </View>
        );
      }}
    </Pressable>
  );
}

function TextButton({ theme, size, label, spoken, onPress }: { theme: Theme; size: Size; label: string; spoken?: string; onPress(): void }): ReactNode {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spoken}
      // Inside a row, the press is the button's alone: the row under it must not toggle too.
      onPress={(event: GestureResponderEvent) => {
        (event as { stopPropagation?(): void }).stopPropagation?.();
        onPress();
      }}
      hitSlop={8}
    >
      {({ hovered, pressed }: { pressed: boolean; hovered?: boolean }) => (
        <Text
          style={{
            color: theme.colors.foreground,
            fontSize: size.small,
            lineHeight: size.small + 4,
            fontWeight: "500",
            opacity: pressed ? 0.5 : hovered ? 0.7 : 1,
            ...FADE,
          }}
        >
          {label}
        </Text>
      )}
    </Pressable>
  );
}

/** The time, ticking every `intervalMs`, so countdowns move while the panel stays open. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** The system's reduce-motion setting, followed live; motion stays on where it can't be read. */
export function useReducedMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    const check = AccessibilityInfo.isReduceMotionEnabled as (() => Promise<boolean>) | undefined;
    check?.()
      .then((value) => {
        if (live) setReduce(value);
        return undefined;
      })
      .catch(() => undefined);
    const subscription = AccessibilityInfo.addEventListener?.("reduceMotionChanged", (value: boolean) => setReduce(value));
    return () => {
      live = false;
      subscription?.remove?.();
    };
  }, []);
  return reduce;
}
