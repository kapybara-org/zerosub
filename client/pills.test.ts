import type { PluginButton, PluginButtonMenuEntry, PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import type { AccountView, AgentRoute, StateView } from "../shared/model";
import { contributePills } from "./pills";
import type { ZeroSubStore } from "./store";

// The popovers are React Native views, which don't load here. The menu only links to them.
vi.mock("./fork-confirm", () => ({ forkPopover: () => () => null, openCodeForkPopover: () => () => null }));
vi.mock("./reset-confirm", () => ({ resetPopover: () => () => null }));

function account(id: string, isDefault: boolean, overrides: Partial<AccountView> = {}): AccountView {
  return {
    id,
    family: "codex",
    label: id,
    kind: "managed",
    email: null,
    plan: null,
    organization: null,
    status: "ready",
    isDefault,
    limitedUntil: null,
    usage: null,
    agentCount: 1,
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
    ...overrides,
  };
}

/** The account button's menu for one agent, routed as `route` says. */
async function menu(route: Partial<AgentRoute>, family: "claude" | "codex" = "codex", accounts: AccountView[] = [account("work", true), account("home", false)], openCodeAvailable = true): Promise<readonly PluginButtonMenuEntry[]> {
  const state: StateView = {
    accounts,
    agents: [{ agentId: "agent-1", family, accountId: accounts[0]!.id, pinned: true, pendingAccountId: null, waiting: null, movable: false, ...route }],
    logins: [],
    providers: { [family]: family },
    canReopen: true,
    browserSignIn: true,
    piLaunchers: null,
    piHomes: null,
    showComposerPill: true,
    openCodeAvailable,
    autoSwitch: true,
    warnings: [],
  };
  const buttons: PluginButton[] = [];
  const agent = { id: "agent-1", workspaceId: "workspace-1", provider: family };
  const client = {
    addComposerPill: ({ button }: { button: PluginButton }) => {
      buttons.push(button);
      return { update: () => undefined, remove: () => undefined };
    },
    paseo: {
      agents: {
        list: async () => ({
          subscription: {
            subscribe: ({ snapshot }: { snapshot: (page: unknown) => void }) =>
              snapshot({ entries: [{ agent }], pageInfo: { hasMore: false } }),
          },
        }),
      },
    },
  };
  const store = { current: { state }, subscribe: () => () => undefined, refresh: async () => undefined };
  const stop = contributePills(client as unknown as PluginClientContext, store as unknown as ZeroSubStore);
  await vi.waitFor(() => expect(buttons).toHaveLength(1));
  stop();
  const behavior = buttons[0]!.behavior;
  return behavior.kind === "menu" ? behavior.items : [];
}

describe("the account button", () => {
  it("says when an agent started on its account because the weekly reset was near", async () => {
    expect(await menu({ selectionReason: "weekly_reset" })).toContainEqual(
      expect.objectContaining({ id: "selection-reason", title: "Started here: weekly reset was near", disabled: true }),
    );
  });

  it("has no reason row for an agent placed any other way", async () => {
    expect((await menu({})).map((entry) => entry.id)).not.toContain("selection-reason");
  });
});

describe("the OpenCode entry", () => {
  it("is on every Claude agent's menu, with no ready ChatGPT account and automatic forking beside the point", async () => {
    // forkOtherProvider is a server preference; the menu entry doesn't read it. The single Claude
    // account is limited and no ChatGPT account exists at all.
    const items = await menu({}, "claude", [account("solo", true, { family: "claude", status: "limited" })]);
    expect(items).toContainEqual(expect.objectContaining({ id: "fork-opencode", title: "Continue on OpenCode (new agent)…", icon: "Bot" }));
  });

  it("is never on a Codex agent's menu", async () => {
    expect((await menu({})).map((entry) => entry.id)).not.toContain("fork-opencode");
  });

  it("keeps the pill and the OpenCode entry for a single ready Claude account", async () => {
    // Nothing is limited and there is no way out to offer — the hand "Continue on OpenCode" entry
    // is reason enough for the pill to exist.
    const items = await menu({}, "claude", [account("solo", true, { family: "claude", status: "ready" })]);
    expect(items).toContainEqual(expect.objectContaining({ id: "fork-opencode", title: "Continue on OpenCode (new agent)…", icon: "Bot" }));
  });

  it("leaves the OpenCode entry out when this host has no OpenCode", async () => {
    const items = await menu({}, "claude", [account("a", true, { family: "claude" }), account("b", false, { family: "claude" })], false);
    expect(items.some((entry) => entry.id === "fork-opencode")).toBe(false);
  });

  it("hides the pill from a single ready Claude account when OpenCode is unavailable", async () => {
    const buttons: PluginButton[] = [];
    const state: StateView = {
      accounts: [account("solo", true, { family: "claude", status: "ready" })],
      agents: [{ agentId: "agent-1", family: "claude", accountId: "solo", pinned: true, pendingAccountId: null, waiting: null, movable: true }],
      logins: [],
      providers: { claude: "claude" },
      canReopen: true,
      browserSignIn: true,
      piLaunchers: null,
      piHomes: null,
      showComposerPill: true,
      openCodeAvailable: false,
      autoSwitch: true,
      warnings: [],
    };
    const client = {
      addComposerPill: ({ button }: { button: PluginButton }) => {
        buttons.push(button);
        return { update: () => undefined, remove: () => undefined };
      },
      paseo: {
        agents: {
          list: async () => ({
            subscription: {
              subscribe: ({ snapshot }: { snapshot: (page: unknown) => void }) =>
                snapshot({ entries: [{ agent: { id: "agent-1", workspaceId: "workspace-1", provider: "claude" } }], pageInfo: { hasMore: false } }),
            },
          }),
        },
      },
    };
    const store = { current: { state }, subscribe: () => () => undefined, refresh: async () => undefined };
    const stop = contributePills(client as unknown as PluginClientContext, store as unknown as ZeroSubStore);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(buttons).toHaveLength(0);
    stop();
  });

  it("still hides the pill from a single ready Codex account", async () => {
    const buttons: PluginButton[] = [];
    const state: StateView = {
      accounts: [account("solo", true)],
      agents: [{ agentId: "agent-1", family: "codex", accountId: "solo", pinned: true, pendingAccountId: null, waiting: null, movable: true }],
      logins: [],
      providers: { codex: "codex" },
      canReopen: true,
      browserSignIn: true,
      piLaunchers: null,
      piHomes: null,
      showComposerPill: true,
      openCodeAvailable: true,
      autoSwitch: true,
      warnings: [],
    };
    const client = {
      addComposerPill: ({ button }: { button: PluginButton }) => {
        buttons.push(button);
        return { update: () => undefined, remove: () => undefined };
      },
      paseo: {
        agents: {
          list: async () => ({
            subscription: {
              subscribe: ({ snapshot }: { snapshot: (page: unknown) => void }) =>
                snapshot({ entries: [{ agent: { id: "agent-1", workspaceId: "workspace-1", provider: "codex" } }], pageInfo: { hasMore: false } }),
            },
          }),
        },
      },
    };
    const store = { current: { state }, subscribe: () => () => undefined, refresh: async () => undefined };
    const stop = contributePills(client as unknown as PluginClientContext, store as unknown as ZeroSubStore);
    // The snapshot has run by the time subscribe resolves; no pill may appear for it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(buttons).toHaveLength(0);
    stop();
  });

  it("keeps the pill visible for a limited single-account Claude setup", async () => {
    // No reset to spend and no ChatGPT to fork to; the OpenCode entry is the pill's reason to exist.
    const buttons: PluginButton[] = [];
    const state: StateView = {
      accounts: [account("solo", true, { family: "claude", status: "limited" })],
      agents: [{ agentId: "agent-1", family: "claude", accountId: "solo", pinned: true, pendingAccountId: null, waiting: null, movable: true }],
      logins: [],
      providers: { claude: "claude" },
      canReopen: true,
      browserSignIn: true,
      piLaunchers: null,
      piHomes: null,
      showComposerPill: true,
      openCodeAvailable: true,
      autoSwitch: true,
      warnings: [],
    };
    const client = {
      addComposerPill: ({ button }: { button: PluginButton }) => {
        buttons.push(button);
        return { update: () => undefined, remove: () => undefined };
      },
      paseo: {
        agents: {
          list: async () => ({
            subscription: {
              subscribe: ({ snapshot }: { snapshot: (page: unknown) => void }) =>
                snapshot({ entries: [{ agent: { id: "agent-1", workspaceId: "workspace-1", provider: "claude" } }], pageInfo: { hasMore: false } }),
            },
          }),
        },
      },
    };
    const store = { current: { state }, subscribe: () => () => undefined, refresh: async () => undefined };
    const stop = contributePills(client as unknown as PluginClientContext, store as unknown as ZeroSubStore);
    await vi.waitFor(() => expect(buttons).toHaveLength(1));
    stop();
  });
});
