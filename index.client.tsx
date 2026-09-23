import type { PluginClientContext } from "@getpaseo/plugin/client";
import { AccountsSurface } from "./client/accounts-surface";
import { contributeCommands } from "./client/commands";
import { contributePills } from "./client/pills";
import { PreferencesScreen } from "./client/settings-screen";
import { ZeroSubStore } from "./client/store";
import { SwitchRowView } from "./client/switch-row";
import { SWITCH_ROW_KIND, SWITCH_ROW_VERSION, SwitchRowSchema } from "./shared/timeline";

export default function contribute(client: PluginClientContext) {
  const store = new ZeroSubStore(client);
  store.start();

  client.addSurface("accounts", (props) => <AccountsSurface {...props} store={store} />);
  client.addSidebarItem({ id: "accounts", title: "Accounts (ZeroSub)", icon: "Users", surface: "accounts" });
  client.addSettingsScreen({
    id: "preferences",
    title: "ZeroSub preferences",
    icon: "SlidersHorizontal",
    Component: (props) => (
      <PreferencesScreen {...props} onOpenAccounts={() => client.openSurface("accounts")} />
    ),
  });
  client.addTimelineRenderer({
    kind: SWITCH_ROW_KIND,
    version: SWITCH_ROW_VERSION,
    schema: SwitchRowSchema,
    Component: SwitchRowView,
  });

  const stopCommands = contributeCommands(client, store);
  const stopPills = contributePills(client, store);

  return () => {
    stopPills();
    stopCommands();
    store.stop();
  };
}
