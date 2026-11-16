import * as pluginClient from "@getpaseo/plugin/client";
import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import * as kit from "@getpaseo/plugin/client/react-native";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, type ComponentType, type ReactNode, type RefObject } from "react";
import { Animated, Easing, Modal as Overlay, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View, type ViewStyle } from "react-native";
import { glyphSvg } from "../shared/glyph";
import { modelName } from "../shared/plan-input";
import { setDefaultAccount, setNextAgentAccount } from "../shared/rpc";
import { describeReopen } from "../shared/format";
import { MANAGE_ACCOUNTS, startingChoice, type StartingOption, type StartingRow } from "./agent-account";
import { ActionRow, FADE, isDark, PEEK_DWELL_MS, PEEK_WARM_MS, PeekCard, SIZE, type Size, useNow, useReducedMotion, withAlpha } from "./agent-accounts";
import { useStore, VISIBLE_POLL_MS, type ZeroSubStore } from "./store";
import { Glyph, toneColor } from "./usage-icon";

type Theme = PluginHostProps["theme"];

/**
 * What Paseo 0.16 gives a composer item. ZeroSub builds against an older SDK that doesn't list it,
 * so it is read from the host at runtime, and an older host simply gets no item.
 */
interface ComposerView {
  readonly context: "agent" | "draft" | "new-workspace";
  readonly agent: { readonly provider: string | null; readonly model?: string | null };
}

interface SelectControlProps {
  title: string;
  icon: string | { svg: string };
  disabled?: boolean;
  value: string;
  options: readonly StartingOption[];
  onValueChange(event: { value: string }): void | Promise<void>;
}

/** Paseo's own modal: a bottom sheet with a grabber on phones. Also read at runtime. */
interface SheetKit {
  (props: { title: string; open: boolean; onOpenChange(open: boolean): void; children: ReactNode }): ReactNode;
  Content: ComponentType<{ children: ReactNode; contentContainerStyle?: ViewStyle; scrollable?: boolean }>;
}

interface ComposerItemHost {
  addComposerItem?(contribution: { id: string; Component: ComponentType<PluginHostProps> }): () => void;
}

/** Names the control for screen readers, heads its panel, and titles its sheet. */
const TITLE = "New agents start on";
/** The same while a one-time pick sends only the next new agent elsewhere. */
const NEXT_TITLE = "Next new agent starts on";
/** Below Paseo's md breakpoint the composer puts plugin items in its sheet, never in the toolbar. */
const COMPACT_WIDTH = 600;
const TICK_MS = 30_000;
/** The panel, as wide as Paseo's popovers at their narrowest; its padding is theirs too. */
const PANEL_WIDTH = 280;
const PANEL_PAD = 12;
/** Between the pill and the panel, and between the panel and the window's edge. */
const ANCHOR_GAP = 6;
const EDGE = 8;
const APPEAR_MS = 140;
const NATIVE = Platform.OS !== "web";
const TABULAR = ["tabular-nums" as const];
/** Paseo's toolbar control: a 28-point pill, 8 points of padding, a 16-point glyph beside 14-point text. */
const PILL = { height: 28, pad: 8, gap: 4, glyph: 16, text: 14, caret: 14 } as const;
/** Paseo's sheet header indent: the ticks and "Manage accounts" line up with the sheet's title. */
const SHEET_INSET = 24;
/** Paseo's sheet row: 44 points tall, a 16-point glyph in a 20-point slot. */
const ROW = { height: 44, pad: 16, gap: 8, glyph: 16, slot: 20, text: 14, radius: 16 } as const;

/**
 * The account new agents start on, in the composer of an agent not started yet (a new agent in a
 * workspace, or the New workspace screen), as "Make default" on the Accounts screen sets it.
 *
 * - In the toolbar: a pill like the model picker beside it, the account's glyph and name. It opens a
 *   panel anchored above it, laid out like an agent's account panel: a tick on the account new agents
 *   start on, each account's glyph and one figure (the share used, or once full the wait), its
 *   limits when the pointer rests on it, and the way to the Accounts screen. One click picks.
 * - On a phone (Paseo puts the item in its composer sheet): a row of that sheet, which opens the same
 *   list in a bottom sheet with touch-sized rows; holding a row shows its limits.
 *
 * The figures are those of the model picked in the composer, so an account whose Fable is spent
 * reads full for Fable and not for Opus. A running agent has its account pill instead.
 */
export function contributeComposerAccount(client: PluginClientContext, store: ZeroSubStore): () => void {
  const host = client as unknown as ComposerItemHost;
  const hooks = pluginClient as unknown as { useComposer?: () => ComposerView };
  const controls = kit as unknown as { Select?: ComponentType<SelectControlProps>; Modal?: SheetKit };
  if (typeof host.addComposerItem !== "function" || typeof hooks.useComposer !== "function" || typeof controls.Select !== "function") {
    return () => undefined;
  }
  const useComposer = hooks.useComposer;
  const Select = controls.Select;
  const Sheet = typeof controls.Modal === "function" && controls.Modal.Content ? controls.Modal : null;

  function StartingAccount({ theme, layout }: PluginHostProps) {
    const composer = useComposer();
    const { state } = useStore(store);
    const toast = useToast();
    const now = useNow(TICK_MS);
    const reduceMotion = useReducedMotion();
    const { width } = useWindowDimensions();
    const compact = layout?.compact ?? width < COMPACT_WIDTH;
    const [open, setOpen] = useState(false);
    // Where the pill sits in the window, measured as the panel opens.
    const [frame, setFrame] = useState<Frame | null>(null);
    // The account just picked, shown until the daemon's state says so too.
    const [picked, setPicked] = useState<string | null>(null);
    const pill = useRef<View>(null);

    const choice = state && composer.context !== "agent" ? startingChoice(state, composer.agent.provider, composer.agent.model ?? null, now) : null;
    const savedId = choice?.current.id ?? null;
    useEffect(() => {
      if (picked !== null && picked === savedId) setPicked(null);
    }, [picked, savedId]);
    // Keep the figures moving while the list is open.
    useEffect(() => (open ? store.watch(VISIBLE_POLL_MS) : undefined), [open]);

    if (!state || !choice) return null;

    const pick = async (id: string): Promise<void> => {
      if (id === MANAGE_ACCOUNTS) {
        client.openSurface("accounts");
        return;
      }
      const account = state.accounts.find((candidate) => candidate.id === id);
      if (!account || id === (picked ?? choice.current.id)) return;
      setPicked(id);
      try {
        // A pick here replaces a one-time pick for the next agent: it's what the user just chose.
        if (choice.once) await store.rpc(setNextAgentAccount, { accountId: choice.current.id, enabled: false });
        if (account.isDefault) {
          await store.refresh();
          toast.show(`New agents start on ${account.label} again`, { variant: "success" });
          return;
        }
        const summary = await store.rpc(setDefaultAccount, { accountId: id });
        toast.show(describeReopen(`${account.label} is now the default`, summary), { variant: "success" });
      } catch (error) {
        setPicked(null);
        // The list has closed by now: say it where the user looks next.
        toast.error(error instanceof Error ? error.message : String(error));
      }
    };

    const title = choice.once ? NEXT_TITLE : TITLE;
    // A host without Paseo's modal keeps its own picker on phones.
    if (compact && !Sheet) {
      const fill = toneColor(theme, choice.glyph.tone, "currentColor");
      return (
        <Select
          title={title}
          icon={{ svg: glyphSvg(choice.glyph.kind, choice.glyph.usedPercent, { fill, dashed: choice.glyph.dashed }) }}
          value={choice.current.id}
          options={choice.options}
          onValueChange={({ value }) => pick(value)}
        />
      );
    }

    const shownId = picked ?? choice.current.id;
    const rows = choice.rows.map((row) => ({ ...row, current: row.id === shownId }));
    const shown = rows.find((row) => row.current) ?? rows[0]!;
    const model = versionedName(composer.agent.model ?? null);
    const choose = (id: string) => {
      setOpen(false);
      void pick(id);
    };
    const manage = () => {
      setOpen(false);
      client.openSurface("accounts");
    };

    if (compact && Sheet) {
      return (
        <>
          <SheetRow theme={theme} title={title} row={shown} open={open} onPress={() => setOpen(true)} />
          <Sheet title={title} open={open} onOpenChange={setOpen}>
            <Sheet.Content scrollable={false} contentContainerStyle={{ paddingHorizontal: SHEET_INSET, paddingTop: 8, paddingBottom: 16, gap: 0 }}>
              <StartingList theme={theme} title={title} size={SIZE.compact} compact rows={rows} model={model} reduceMotion={reduceMotion} onPick={choose} onManage={manage} />
            </Sheet.Content>
          </Sheet>
        </>
      );
    }

    return (
      <>
        <ToolbarPill
          ref={pill}
          theme={theme}
          title={title}
          row={shown}
          open={open}
          onPress={() => {
            const target = pill.current;
            if (!target) return;
            target.measureInWindow((x, y, w, h) => {
              setFrame({ x, y, w, h });
              setOpen(true);
            });
          }}
        />
        {open && frame ? (
          <Anchored theme={theme} frame={frame} reduceMotion={reduceMotion} onClose={() => setOpen(false)}>
            <StartingList theme={theme} title={title} size={SIZE.regular} compact={false} rows={rows} model={model} reduceMotion={reduceMotion} heading onPick={choose} onManage={manage} />
          </Anchored>
        ) : null}
      </>
    );
  }
  StartingAccount.displayName = "ZeroSubStartingAccount";

  return host.addComposerItem({ id: "starting-account", Component: StartingAccount });
}

/** "Fable 5.2", "Opus 4.7"; null for an alias such as "default", which names no model. */
function versionedName(model: string | null): string | null {
  const name = modelName(model);
  return name && /\d/.test(name) ? name : null;
}

interface Frame {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The pill, drawn as Paseo draws its toolbar pickers so it sits among them as one of theirs. */
function ToolbarPill({
  ref,
  theme,
  title,
  row,
  open,
  onPress,
}: {
  ref: RefObject<View | null>;
  theme: Theme;
  title: string;
  row: StartingRow;
  open: boolean;
  onPress(): void;
}) {
  const colors = theme.colors;
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={`${title} ${row.label}`}
      accessibilityState={{ expanded: open }}
      aria-expanded={open}
      onPress={onPress}
      style={{ flexShrink: 1, minWidth: 0 }}
    >
      {({ hovered, pressed }: { pressed: boolean; hovered?: boolean }) => (
        <View
          style={{
            height: PILL.height,
            paddingHorizontal: PILL.pad,
            borderRadius: PILL.height / 2,
            flexDirection: "row",
            alignItems: "center",
            gap: PILL.gap,
            backgroundColor: hovered || pressed || open ? colors.surface2 : withAlpha(colors.surface2, 0),
            ...FADE,
          }}
        >
          <View style={{ width: PILL.glyph, height: PILL.glyph, alignItems: "center", justifyContent: "center" }}>
            <Glyph theme={theme} kind={row.glyph.kind} usedPercent={row.glyph.usedPercent} tone={row.glyph.tone} dashed={row.glyph.dashed} size={PILL.glyph} color={colors.foregroundMuted} />
          </View>
          <Text numberOfLines={1} style={{ flexShrink: 1, minWidth: 0, color: colors.foregroundMuted, fontSize: PILL.text }}>
            {row.label}
          </Text>
          <View style={{ transform: [{ translateY: 1 }] }}>
            <Icon name="ChevronDown" size={PILL.caret} color={colors.foregroundMuted} />
          </View>
        </View>
      )}
    </Pressable>
  );
}

/** A row of Paseo's composer sheet: the control's name, then the account. */
function SheetRow({ theme, title, row, open, onPress }: { theme: Theme; title: string; row: StartingRow; open: boolean; onPress(): void }) {
  const colors = theme.colors;
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={`${title} ${row.label}`} accessibilityState={{ expanded: open }} onPress={onPress}>
      {({ pressed }: { pressed: boolean }) => (
        <View
          style={{
            minHeight: ROW.height,
            marginHorizontal: -4,
            paddingHorizontal: ROW.pad,
            borderRadius: ROW.radius,
            flexDirection: "row",
            alignItems: "center",
            gap: ROW.gap,
            backgroundColor: pressed || open ? colors.surface2 : colors.surface1,
          }}
        >
          <View style={{ width: ROW.slot, height: ROW.slot, alignItems: "center", justifyContent: "center" }}>
            <Glyph theme={theme} kind={row.glyph.kind} usedPercent={row.glyph.usedPercent} tone={row.glyph.tone} dashed={row.glyph.dashed} size={ROW.glyph} color={colors.foregroundMuted} />
          </View>
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: ROW.text }}>
            {title}
          </Text>
          <Text numberOfLines={1} style={{ maxWidth: "45%", flexShrink: 1, minWidth: 0, color: colors.foregroundMuted, fontSize: ROW.text }}>
            {row.label}
          </Text>
        </View>
      )}
    </Pressable>
  );
}

/**
 * A panel anchored to the pill: above it (the composer sits at the bottom of the window), below it
 * when there is more room there, kept on screen. A click outside it or Escape closes it.
 */
function Anchored({ theme, frame, reduceMotion, onClose, children }: { theme: Theme; frame: Frame; reduceMotion: boolean; onClose(): void; children: ReactNode }) {
  const colors = theme.colors;
  const dark = isDark(theme);
  const { width, height: windowHeight } = useWindowDimensions();
  const [height, setHeight] = useState<number | null>(null);
  const appear = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;
  const size = useRef(`${width}x${windowHeight}`);
  // The pill moves with the window: rather than float away from it, the panel closes.
  useEffect(() => {
    if (size.current !== `${width}x${windowHeight}`) onClose();
  }, [width, windowHeight]);
  const measured = height !== null;
  useEffect(() => {
    if (!measured || reduceMotion) return undefined;
    const animation = Animated.timing(appear, { toValue: 1, duration: APPEAR_MS, easing: Easing.out(Easing.cubic), useNativeDriver: NATIVE });
    animation.start();
    return () => animation.stop();
  }, [measured]);

  const above = frame.y - ANCHOR_GAP - EDGE;
  const below = windowHeight - frame.y - frame.h - ANCHOR_GAP - EDGE;
  const up = measured ? height <= above || above >= below : above >= below;
  const left = Math.max(EDGE, Math.min(frame.x, width - PANEL_WIDTH - EDGE));
  const place: ViewStyle = up ? { bottom: windowHeight - frame.y + ANCHOR_GAP } : { top: frame.y + frame.h + ANCHOR_GAP };
  return (
    <Overlay visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={StyleSheet.absoluteFill}>
        <Pressable accessible={false} focusable={false} {...({ tabIndex: -1 } as object)} onPress={onClose} style={StyleSheet.absoluteFill} />
        <Animated.View
          accessibilityViewIsModal
          onLayout={(event) => {
            const next = Math.round(event.nativeEvent.layout.height);
            setHeight((previous) => (previous === next ? previous : next));
          }}
          style={{
            position: "absolute",
            left,
            ...place,
            width: PANEL_WIDTH,
            padding: PANEL_PAD,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: dark ? withAlpha(colors.foreground, 0.1) : colors.border,
            backgroundColor: colors.surface1,
            // Shown once measured, so it never flashes on the wrong side.
            opacity: measured ? appear : 0,
            transform: [
              { translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [up ? 4 : -4, 0] }) },
              { scale: appear.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) },
            ],
            ...({ boxShadow: dark ? "0px 4px 8px rgba(0, 0, 0, 0.20)" : "0px 4px 16px rgba(0, 0, 0, 0.06), 0px 1px 2px rgba(0, 0, 0, 0.04)" } as object),
          }}
        >
          {children}
        </Animated.View>
      </View>
    </Overlay>
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
 * The accounts, one line each in an agent panel's columns: a tick on the one new agents start on
 * (a faint one under the pointer elsewhere, for what a click does), the glyph, the name, the figure.
 * Resting on a line shows its limits; then the way to the Accounts screen.
 */
function StartingList({
  theme,
  title,
  size,
  compact,
  rows,
  model,
  reduceMotion,
  heading = false,
  onPick,
  onManage,
}: {
  theme: Theme;
  /** What the list picks: where new agents start, or only the next one. */
  title: string;
  size: Size;
  compact: boolean;
  rows: StartingRow[];
  /** The model the figures are for, when the composer has picked one. */
  model: string | null;
  reduceMotion: boolean;
  /** Says what the list is; a sheet has its own title. */
  heading?: boolean;
  onPick(id: string): void;
  onManage(): void;
}) {
  const colors = theme.colors;
  const rowH = size.row;
  const [peek, setPeek] = useState<{ id: string; instant: boolean } | null>(null);
  const [listTop, setListTop] = useState(0);
  const [panelHeight, setPanelHeight] = useState(0);
  // A key was pressed in the list: from then on focus, not just the pointer, opens a row's details.
  // The ref answers the focus that the very key moves, before the state has rendered.
  const [keyed, setKeyed] = useState(false);
  const keyedNow = useRef(false);
  const peekTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const peekShown = useRef<string | null>(null);
  const peekLeftAt = useRef(0);
  const hovering = useRef<string | null>(null);
  const tops = useRef(new Map<string, Animated.Value>()).current;
  const refs = useRef<(View | null)[]>([]);
  peekShown.current = peek?.id ?? null;
  useEffect(
    () => () => {
      if (peekTimer.current) clearTimeout(peekTimer.current);
    },
    [],
  );
  // The keyboard starts on the account new agents start on.
  const currentIndex = Math.max(0, rows.findIndex((row) => row.current));
  useEffect(() => {
    if (compact) return;
    const target = refs.current[currentIndex] as unknown as { focus?: () => void } | null;
    target?.focus?.();
  }, []);

  const wait = () => {
    if (peekTimer.current) clearTimeout(peekTimer.current);
    peekTimer.current = null;
  };
  const peeks = (id: string): Peek => ({
    enter() {
      hovering.current = id;
      wait();
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
      if (compact || !keyedNow.current || hovering.current !== null) return;
      wait();
      setPeek({ id, instant: peekShown.current !== null });
    },
    show() {
      wait();
      setPeek({ id, instant: false });
    },
    hide() {
      wait();
      peekLeftAt.current = 0;
      if (peekShown.current !== null) setPeek(null);
    },
  });
  // Rows stay put, so a row's details follow a fixed top.
  const topOf = (id: string, index: number): Animated.Value => {
    const key = `${id}:${index}`;
    let top = tops.get(key);
    if (!top) {
      top = new Animated.Value(index * rowH);
      tops.set(key, top);
    }
    return top;
  };
  const step = (index: number, delta: -1 | 1) => {
    const next = (index + delta + rows.length) % rows.length;
    const target = refs.current[next] as unknown as { focus?: () => void } | null;
    target?.focus?.();
  };

  const peekIndex = peek ? rows.findIndex((row) => row.id === peek.id) : -1;
  const peekRow = peekIndex >= 0 ? rows[peekIndex] : undefined;
  const peekTop = listTop + peekIndex * rowH;

  return (
    <View
      onLayout={(event) => {
        const next = Math.round(event.nativeEvent.layout.height);
        setPanelHeight((previous) => (previous === next ? previous : next));
      }}
      style={{ gap: 6 }}
    >
      {heading ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: size.choice }}>
          <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foregroundMuted, fontSize: size.small }}>
            {title}
          </Text>
          {model ? (
            <Text numberOfLines={1} accessibilityLabel={`Figures for ${model}`} style={{ color: colors.foregroundMuted, fontSize: size.small, opacity: 0.8 }}>
              {model}
            </Text>
          ) : null}
        </View>
      ) : null}
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel={title}
        onLayout={(event) => {
          const top = Math.round(event.nativeEvent.layout.y);
          setListTop((previous) => (previous === top ? previous : top));
        }}
        // Above the line that follows, so a row's details can open over it.
        style={{ marginHorizontal: -size.pad, zIndex: 1 }}
      >
        {rows.map((row, index) => (
          <StartingRowView
            key={row.id}
            ref={(node) => {
              refs.current[index] = node;
            }}
            theme={theme}
            row={row}
            size={size}
            compact={compact}
            keyed={keyed}
            peek={peeks(row.id)}
            onKey={(key) => {
              keyedNow.current = true;
              if (!keyed) setKeyed(true);
              if (key === "ArrowDown") step(index, 1);
              else if (key === "ArrowUp") step(index, -1);
            }}
            onPress={() => onPick(row.id)}
          />
        ))}
        {peekRow ? (
          <PeekCard
            key={peekRow.id}
            theme={theme}
            size={size}
            row={{ now: false, why: "", lines: peekRow.lines, note: peekRow.note }}
            y={topOf(peekRow.id, peekIndex)}
            above={peekTop}
            below={panelHeight - peekTop - rowH}
            instant={peek?.instant === true}
            reduceMotion={reduceMotion}
          />
        ) : null}
      </View>
      <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.border, marginTop: 2 }} />
      <ActionRow theme={theme} size={size} trailing="ArrowUpRight" label="Manage accounts" hover="Sign in, rename, turn off" onPress={onManage} />
    </View>
  );
}

function StartingRowView({
  ref,
  theme,
  row,
  size,
  compact,
  keyed,
  peek,
  onKey,
  onPress,
}: {
  ref(node: View | null): void;
  theme: Theme;
  row: StartingRow;
  size: Size;
  compact: boolean;
  /** The keyboard is in use: the focused row lights up as a hovered one does. */
  keyed: boolean;
  peek: Peek;
  onKey(key: string): void;
  onPress(): void;
}) {
  const colors = theme.colors;
  const keys = {
    onKeyDown: (event: { key?: string; nativeEvent?: { key?: string }; preventDefault?(): void }) => {
      const key = event.key ?? event.nativeEvent?.key ?? "";
      if (key === "ArrowDown" || key === "ArrowUp") event.preventDefault?.();
      onKey(key);
    },
  };
  const spoken = [row.label, row.current ? "new agents start on it" : null, row.room].filter(Boolean).join(", ");
  return (
    <Pressable
      ref={ref}
      {...(keys as object)}
      accessibilityRole="radio"
      accessibilityState={{ checked: row.current }}
      aria-checked={row.current}
      accessibilityLabel={spoken}
      accessibilityHint={row.current ? undefined : "Makes it the default"}
      onHoverIn={peek.enter}
      onHoverOut={peek.leave}
      onFocus={peek.focus}
      onBlur={peek.leave}
      onPressIn={peek.hide}
      // A finger has no hover: holding it on the row shows the limits, and lifting it hides them.
      onLongPress={compact ? peek.show : undefined}
      onPressOut={compact ? peek.hide : undefined}
      onPress={onPress}
      style={{ height: size.row, ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}) }}
    >
      {({ hovered, pressed, focused }: { pressed: boolean; hovered?: boolean; focused?: boolean }) => {
        const lit = hovered === true || (keyed && focused === true);
        return (
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: size.gap,
              paddingHorizontal: size.pad,
              borderRadius: 7,
              backgroundColor: pressed ? colors.surface2 : lit ? withAlpha(colors.surface2, 0.7) : withAlpha(colors.surface2, 0),
              ...FADE,
            }}
          >
            <View style={{ width: size.check, alignItems: "center" }}>
              {row.current || lit ? (
                <Icon name="Check" size={Math.round(size.check * 0.9)} color={row.current ? colors.foreground : withAlpha(colors.foregroundMuted, 0.5)} />
              ) : null}
            </View>
            <Glyph theme={theme} kind={row.glyph.kind} usedPercent={row.glyph.usedPercent} tone={row.glyph.tone} dashed={row.glyph.dashed} size={size.glyph} color={colors.foregroundMuted} />
            <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: colors.foreground, fontSize: size.text }}>
              {row.label}
            </Text>
            <Text style={{ color: colors.foregroundMuted, fontSize: size.small, fontVariant: TABULAR }}>{row.meta}</Text>
          </View>
        );
      }}
    </Pressable>
  );
}
