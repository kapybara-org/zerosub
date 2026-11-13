import { describe, expect, it, vi } from "vitest";
import type { AccountView, StateView } from "../shared/model";
import { setNextAgentAccount } from "../shared/rpc";
import { contributeCommands } from "./commands";

function account(status: AccountView["status"], nextAgentUntil: string | null): AccountView {
  return {
    id: "claude-hello",
    family: "claude",
    label: "hello",
    kind: "managed",
    email: null,
    plan: null,
    organization: null,
    status,
    isDefault: false,
    nextAgentUntil,
    limitedUntil: null,
    usage: null,
    agentCount: 0,
    home: null,
    auth: "subscription",
    api: null,
    apiEditable: false,
    proxy: null,
    proxyEditable: false,
    inheritedProxy: null,
    proxyFile: null,
    proxyFollowers: [],
    launcher: null,
    egress: null,
    externalHome: false,
    moving: null,
  };
}

/** The Command Center entries contributed for these accounts, and the RPCs they send. */
function commandCenter(accounts: AccountView[]) {
  const items: Array<{ title: string; onSelect(): unknown }> = [];
  const client = {
    addCommandCenterItem: (item: (typeof items)[number]) => {
      items.push(item);
      return () => void items.splice(items.indexOf(item), 1);
    },
    addSlashCommand: () => () => undefined,
  };
  const state: StateView = {
    accounts,
    agents: [],
    logins: [],
    providers: {},
    canReopen: false,
    browserSignIn: true,
    showComposerPill: false,
    openCodeAvailable: false,
    autoSwitch: true,
    warnings: [],
    piLaunchers: null,
    piHomes: null,
  };
  const rpc = vi.fn(async () => ({ until: null }));
  const store = { current: { state, error: null, updatedAt: 0 }, subscribe: () => () => undefined, rpc, refresh: async () => undefined };
  contributeCommands(client as never, store as never);
  return { items, rpc };
}

describe("next new agent commands", () => {
  it("keep the cancel entry of a waiting pick, whatever has become of its account", async () => {
    for (const status of ["ready", "limited", "signed_out", "disabled"] as const) {
      const { items, rpc } = commandCenter([account(status, "2026-11-13T12:10:00.000Z")]);
      const cancel = items.filter((item) => item.title === "Cancel: next new Claude agent on hello");
      expect(cancel, status).toHaveLength(1);
      await cancel[0]!.onSelect();
      expect(rpc, status).toHaveBeenCalledWith(setNextAgentAccount, { accountId: "claude-hello", enabled: false });
    }
  });

  it("offer a pick only on accounts that can take agents", () => {
    const titles = (status: AccountView["status"]) => commandCenter([account(status, null)]).items.map((item) => item.title);
    expect(titles("ready")).toContain("Next new Claude agent: use hello");
    expect(titles("limited")).toContain("Next new Claude agent: use hello");
    for (const status of ["signed_out", "disabled"] as const) {
      expect(titles(status).filter((title) => title.includes("next new") || title.startsWith("Next new")), status).toEqual([]);
    }
  });
});
