import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { Icon, useToast } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState, type ComponentType } from "react";
import { Pressable, Text, View } from "react-native";
import type { StateView } from "../shared/model";
import { describe, useStore, VISIBLE_POLL_MS, type ZeroSubStore } from "./store";

/** One entry of an agent's account menu, as `contributePills` builds it. */
export type MenuEntry =
  | { kind: "separator"; id: string }
  | {
      kind: "item";
      id: string;
      title: string;
      /** A line of its own under the title. */
      detail?: string | null;
      icon: string;
      disabled?: boolean;
      behavior:
        | { kind: "action"; onPress(): void | Promise<void> }
        | { kind: "popover"; Content: ComponentType<PluginButtonContentProps> };
    };

/**
 * An agent's account menu, drawn by ZeroSub rather than Paseo: Paseo's menus are one line an entry,
 * too narrow for an account and its usage, so here each entry wraps. It reads the store as it
 * renders, so it keeps up while open, and Paseo never has to replace it (which would close it). An
 * action closes the menu, and what it throws shows as a toast; a confirmation opens in its place.
 */
export function accountMenu(
  store: ZeroSubStore,
  entriesOf: (state: StateView) => readonly MenuEntry[],
): ComponentType<PluginButtonContentProps> {
  return function AccountMenu(props: PluginButtonContentProps) {
    const { theme, close } = props;
    const colors = theme.colors;
    const toast = useToast();
    const { state } = useStore(store);
    useEffect(() => store.watch(VISIBLE_POLL_MS), []);
    // The confirmation open in the menu's place: kept as it opened, so it keeps what's typed or under way.
    const [page, setPage] = useState<ComponentType<PluginButtonContentProps> | null>(null);
    if (page) {
      const Page = page;
      return <Page {...props} />;
    }
    const entries = state ? entriesOf(state) : [];
    return (
      <View style={{ gap: 2 }}>
        {entries.map((entry) => {
          if (entry.kind === "separator") {
            return <View key={entry.id} style={{ height: 1, marginVertical: 4, backgroundColor: colors.border }} />;
          }
          const { behavior } = entry;
          const press = () => {
            if (behavior.kind === "popover") {
              setPage(() => behavior.Content);
              return;
            }
            close();
            void Promise.resolve()
              .then(behavior.onPress)
              .catch((error: unknown) => toast.error(describe(error)));
          };
          return (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              accessibilityLabel={entry.detail ? `${entry.title}, ${entry.detail}` : entry.title}
              accessibilityState={{ disabled: Boolean(entry.disabled) }}
              disabled={entry.disabled}
              onPress={press}
              style={(pressable) => ({
                flexDirection: "row",
                alignItems: "flex-start",
                gap: 10,
                paddingHorizontal: 8,
                paddingVertical: 6,
                borderRadius: 6,
                backgroundColor:
                  !entry.disabled && (pressable.pressed || (pressable as { hovered?: boolean }).hovered) ? colors.surface2 : "transparent",
                opacity: entry.disabled ? 0.5 : 1,
              })}
            >
              <View style={{ paddingTop: 2 }}>
                <Icon name={entry.icon} size={16} color={colors.foregroundMuted} />
              </View>
              <View style={{ flexShrink: 1, minWidth: 0, gap: 2 }}>
                <Text style={{ color: colors.foreground, fontSize: 14 }}>{entry.title}</Text>
                {entry.detail ? <Text style={{ color: colors.foregroundMuted, fontSize: 12 }}>{entry.detail}</Text> : null}
              </View>
            </Pressable>
          );
        })}
      </View>
    );
  };
}
