import type { PluginHostProps } from "@getpaseo/plugin/client";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { PACE_GATE_PERCENT, type PaceView } from "../shared/model";
import { Hint, useText } from "./ui";

type Theme = PluginHostProps["theme"];

/** A run of text; the bold ones are the numbers, as in the usage rows above. */
export type Segment = { text: string; bold?: boolean };

export interface PaceCopy {
  fiveHour: Segment[];
  pending: string | null;
  /** What the short pending line adds up to, for screen readers. */
  pendingDetail: string | null;
  weekly: Segment[] | null;
  standing: "ahead" | "behind" | "on" | null;
  held: string | null;
}

const r = Math.round;
const PROJECTION_HINT =
  "Projected up to 1 hour ahead (never past the reset) at this window's average burn rate so far, counted over at least 30 minutes, plus 10% for each agent just placed here.";
const STANDING_LABEL = { ahead: "ahead of pace", behind: "behind pace", on: "on pace" };

/** The words under an account's pacing bars. */
export function describePace(pace: PaceView): PaceCopy {
  const { fiveHourUsed, fiveHourProjected, pendingFiveHour, weeklyUsed, pendingWeekly, weekElapsed, pending, gated } = pace;
  let standing: PaceCopy["standing"] = null;
  let weekly: Segment[] | null = weeklyUsed === null ? null : [{ text: `${r(weeklyUsed)}%`, bold: true }, { text: " used" }];
  if (weeklyUsed !== null && weekElapsed !== null) {
    const used = r(weeklyUsed + pendingWeekly);
    const gone = r(weekElapsed);
    standing = used > gone ? "ahead" : used < gone ? "behind" : "on";
    weekly = [
      { text: `${r(weeklyUsed)}%`, bold: true },
      { text: " used · " },
      { text: `${r(weekElapsed)}%`, bold: true },
      { text: ` elapsed · ${STANDING_LABEL[standing]}` },
    ];
  }
  return {
    fiveHour:
      fiveHourUsed === null
        ? [{ text: `No 5-hour reading yet. Pacing counts it as ${r(fiveHourProjected)}%.` }]
        : [{ text: `${r(fiveHourUsed)}%`, bold: true }, { text: " now · " }, { text: `${r(fiveHourProjected)}%`, bold: true }, { text: " projected" }],
    pending: pending === 0 ? null : `+${pending} new agent${pending === 1 ? "" : "s"} not in the reading yet`,
    pendingDetail:
      pending === 0
        ? null
        : `Counts ${pending} new agent${pending === 1 ? "" : "s"} the reading doesn't show yet (+${r(pendingFiveHour)}% 5-hour, +${r(pendingWeekly)}% weekly)`,
    weekly,
    standing,
    held: gated
      ? `Pacing holds it back: new agents start on other accounts first while it is projected at or past ${PACE_GATE_PERCENT}% of its 5-hour limit.`
      : null,
  };
}

/** Segments as one Text, bold runs in the foreground color over a muted base, like `UsageBar`. */
function Segments({ theme, parts }: { theme: Theme; parts: Segment[] }) {
  const colors = theme.colors;
  return (
    <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>
      {parts.map((part, index) =>
        part.bold ? (
          <Text key={index} style={{ color: colors.foreground, fontWeight: "600" }}>
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}

/** A thin bar of stacked fills, widest first, with an optional tick. */
function PaceBar({
  theme,
  color,
  fills,
  tick,
  label,
  now,
  hint,
}: {
  theme: Theme;
  color: string;
  fills: Array<[percent: number, opacity: number]>;
  tick: number | null;
  label: string;
  now: number;
  hint?: string;
}) {
  const colors = theme.colors;
  const bar = (
    <View style={{ height: 12, position: "relative" }}>
      <View
        accessibilityRole="progressbar"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(Math.min(100, now)) }}
        style={{ height: 6, borderRadius: 3, backgroundColor: colors.surface2, overflow: "hidden", marginTop: 3 }}
      >
        {fills.map(([percent, opacity], index) => (
          <View
            key={index}
            style={{ position: "absolute", left: 0, top: 0, height: 6, borderRadius: 3, width: `${Math.min(100, percent)}%`, backgroundColor: color, opacity }}
          />
        ))}
      </View>
      {tick === null ? null : (
        <View style={{ position: "absolute", left: `${tick}%`, top: 0, width: 2, height: 12, marginLeft: -1, backgroundColor: colors.foreground }} />
      )}
    </View>
  );
  return hint ? (
    <Hint theme={theme} text={hint}>
      {bar}
    </Hint>
  ) : (
    bar
  );
}

function PaceRow({ theme, left, right }: { theme: Theme; left: ReactNode; right: ReactNode }) {
  return <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", columnGap: 8 }}>{left}{right}</View>;
}

/** How pacing reads an account: the 5-hour projection against the gate, the weekly use, and pending agents. */
export function PaceSection({ theme, pace }: { theme: Theme; pace: PaceView }) {
  const text = useText(theme);
  const colors = theme.colors;
  const copy = describePace(pace);
  const { fiveHourUsed, fiveHourProjected, pendingFiveHour, weeklyUsed, pendingWeekly, weekElapsed } = pace;
  return (
    // Rows sit 10 apart and a label sits 4 over its bar, as in `UsageBar`; each bar's box has 3 spare above and
    // below its 6 px track, so the row gap is 7, the label gap 1, and the closing margin -3.
    <View style={{ gap: 7, marginBottom: copy.held ? 0 : -3 }}>
      <Text style={[text.small, { fontWeight: "600", marginBottom: 4 }]}>Pacing</Text>
      <View style={{ gap: 1 }}>
        <PaceRow
          theme={theme}
          left={<Text style={text.small}>Hourly projection</Text>}
          right={
            <Hint theme={theme} text={PROJECTION_HINT} align="end">
              <View accessible accessibilityLabel={copy.fiveHour.map((part) => part.text).join("")} accessibilityHint={PROJECTION_HINT}>
                <Segments theme={theme} parts={copy.fiveHour} />
              </View>
            </Hint>
          }
        />
        <PaceBar
          theme={theme}
          color={pace.gated ? colors.statusWarning : colors.statusSuccess}
          fills={[
            [fiveHourProjected, 0.2],
            [fiveHourProjected - pendingFiveHour, 0.45],
            [fiveHourUsed ?? 0, 1],
          ]}
          tick={PACE_GATE_PERCENT}
          label={`5-hour use projected an hour ahead, gate ${PACE_GATE_PERCENT}%`}
          hint={`New agents skip an account projected at ${PACE_GATE_PERCENT}% or more of its 5-hour limit`}
          now={fiveHourProjected}
        />
      </View>
      {copy.pending ? (
        <Text accessibilityLabel={copy.pendingDetail ?? undefined} numberOfLines={1} style={text.small}>
          {copy.pending}
        </Text>
      ) : null}
      {copy.weekly && weeklyUsed !== null ? (
        <View style={{ gap: 1 }}>
          <PaceRow
            theme={theme}
            left={<Text style={text.small}>Weekly pace</Text>}
            right={<Segments theme={theme} parts={copy.weekly} />}
          />
          <PaceBar
            theme={theme}
            color={copy.standing === "ahead" ? colors.statusWarning : colors.statusSuccess}
            fills={[
              [weeklyUsed + pendingWeekly, 0.2],
              [weeklyUsed, 1],
            ]}
            tick={weekElapsed}
            label="Weekly use against the week gone"
            now={weeklyUsed + pendingWeekly}
          />
        </View>
      ) : null}
      {copy.held ? <Text style={text.warning}>{copy.held}</Text> : null}
    </View>
  );
}
