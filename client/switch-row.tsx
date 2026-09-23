import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { Text, View } from "react-native";
import { formatResetIn } from "../shared/format";
import { FAMILY_LABEL } from "../shared/model";
import type { SwitchRow } from "../shared/timeline";

function cause(row: SwitchRow): string | null {
  const reset = formatResetIn(row.resetsAt);
  const from = row.from ?? "The previous account";
  switch (row.reason) {
    case "limit":
      return `${from} hit its usage limit${reset ? ` (resets ${reset})` : ""}.`;
    case "signed_out":
      return `${from} is signed out — sign it in again from Accounts.`;
    case "removed":
      return `${from} was removed.`;
    case "disabled":
      return `${from} was disabled for now.`;
    case "enabled":
      return `${row.to} is enabled again.`;
    case "default":
      return "The default account changed.";
    default:
      return null;
  }
}

/** The work went on in a new agent on the other provider (Claude ↔ ChatGPT). */
function isFork(row: SwitchRow): boolean {
  return row.toFamily !== null && row.toFamily !== row.family;
}

export function describeRow(row: SwitchRow): string {
  if (isFork(row) && row.toFamily && row.continuedIn) {
    const reset = formatResetIn(row.resetsAt);
    const lead =
      row.reason === "exhausted"
        ? `Every ${FAMILY_LABEL[row.family]} account is at its limit${reset ? ` (${row.from ?? "this one"} resets ${reset})` : ""}, so the work`
        : "The work";
    return `${lead} continues on ${FAMILY_LABEL[row.toFamily]} in a new agent: “${row.continuedIn.title}” (${row.to}).`;
  }
  if (row.reason === "exhausted") {
    const reset = formatResetIn(row.resetsAt);
    return `Every ${FAMILY_LABEL[row.family]} account is at its limit${
      reset ? `; ${row.from ?? "this one"} resets ${reset}` : ""
    }. Add another account, use a banked reset from the account button, or wait.${row.detail ? ` ${row.detail}` : ""}`;
  }
  if (row.outcome === "reset") {
    return `${row.from ?? "This account"} hit its usage limit, so a banked reset was used. ${row.detail ?? "Limits reset."}${
      row.continued ? " Carrying on." : ""
    }`;
  }
  const why = cause(row);
  const lead = why ? `${why} ` : "";
  switch (row.outcome) {
    case "continued":
      return row.continuedIn
        ? `${lead}ChatGPT conversations can't change accounts, so this one continues in a new agent: “${row.continuedIn.title}” on ${row.to}.`
        : `${lead}Continuing on ${row.to}.`;
    case "stayed":
      return `${lead}This conversation stays on ${row.from ?? "its account"}.${row.detail ? ` ${row.detail}` : ""}`;
    case "pending":
      return `${lead}Moves to ${row.to} when its session next starts.`;
    default: {
      const from =
        row.from && row.reason !== "limit" && row.reason !== "signed_out" && row.reason !== "disabled" ? `from ${row.from} ` : "";
      return `${lead}Switched ${from}to ${row.to}${row.continued ? " and carried on" : ""}.`;
    }
  }
}

/** Inline note in an agent's timeline when ZeroSub moved it to another account. */
export function SwitchRowView({ item, theme }: PluginTimelineItemProps<SwitchRow>) {
  const row = item.data;
  const forked = isFork(row);
  const warning =
    !forked && (row.reason === "limit" || row.reason === "signed_out" || row.reason === "exhausted" || row.outcome === "stayed");
  const icon = forked
    ? "GitFork"
    : row.reason === "exhausted" || row.outcome === "stayed"
      ? "CircleAlert"
      : row.outcome === "continued"
        ? "CopyPlus"
        : row.outcome === "reset"
          ? "TimerReset"
          : "ArrowRightLeft";
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "flex-start",
        gap: 8,
        paddingVertical: 6,
        paddingHorizontal: 10,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface1,
        alignSelf: "flex-start",
        maxWidth: "100%",
      }}
    >
      <Icon name={icon} size={14} color={warning ? theme.colors.statusWarning : theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13, flexShrink: 1 }}>{describeRow(row)}</Text>
    </View>
  );
}
