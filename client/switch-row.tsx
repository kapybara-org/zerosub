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

/** The work went on in a new agent on the other provider (Claude ↔ ChatGPT), or on OpenCode. */
function isFork(row: SwitchRow): boolean {
  return row.toProvider !== null || (row.toFamily !== null && row.toFamily !== row.family);
}

export function describeRow(row: SwitchRow): string {
  if (isFork(row) && row.continuedIn) {
    const title = row.continuedIn.title;
    const detail = row.detail ? ` ${row.detail}` : "";
    if (row.delivery === "up-to-date") {
      return `The work is already up to date in “${title}” on ${row.to}; ZeroSub sent nothing new.${detail}`;
    }
    if (row.delivery === "found") {
      return `ZeroSub found the existing OpenCode continuation “${title}” but couldn't tell what it has received. Nothing was sent; open that chat to check it against the latest instructions.${detail}`;
    }
    if (row.delivery === "uncertain") {
      return `ZeroSub couldn't confirm its last handoff to “${title}”. Nothing more was sent; open that chat before retrying.${detail}`;
    }
    const reset = formatResetIn(row.resetsAt);
    const lead =
      row.reason === "exhausted"
        ? `Every ${FAMILY_LABEL[row.family]} account is at its limit${reset ? ` (${row.from ?? "this one"} resets ${reset})` : ""}, so the work`
        : "The work";
    const destination = row.toProvider ? row.to : (row.toFamily ? FAMILY_LABEL[row.toFamily] : row.to);
    // A fork to the other provider moved to an account; an OpenCode fork has none to name.
    return `${lead} continues on ${destination} in a new agent: “${title}”${row.toProvider ? "." : ` (${row.to}).`}${detail}`;
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
        ? `${lead}ChatGPT conversations can't change accounts, so this task continues in “${row.continuedIn.title}” on ${row.to}.`
        : `${lead}Continuing on ${row.to}.`;
    case "stayed":
      return `${lead}This conversation stays on ${row.from ?? "its account"}.${row.detail ? ` ${row.detail}` : ""}`;
    case "pending":
      return `${lead}Moves to ${row.to} when its session next starts.${row.detail ? ` ${row.detail}` : ""}`;
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
