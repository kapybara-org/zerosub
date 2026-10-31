import type { PluginButton, PluginButtonMenuEntry, PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import type { AccountView, AgentRoute, StateView } from "../shared/model";
import { contributePills } from "./pills";
import type { ZeroSubStore } from "./store";

// The popovers are React Native views, which don't load here. The menu only links to them.
vi.mock("./fork-confirm", () => ({ forkPopover: () => () => null }));
vi.mock("./reset-confirm", () => ({ resetPopover: () => () => null }));

function account(id: string, isDefault: boolean): AccountView {
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
  };
}

/** The account button's menu for one ChatGPT agent, routed as `route` says. */
async function menu(route: Partial<AgentRoute>): Promise<readonly PluginButtonMenuEntry[]> {
  const state: StateView = {
    accounts: [account("work", true), account("home", false)],
    agents: [{ agentId: "agent-1", family: "codex", accountId: "work", pinned: true, pendingAccountId: null, movable: false, ...route }],
    logins: [],
    providers: { codex: "codex" },
    canReopen: true,
    browserSignIn: true,
    showComposerPill: true,
    warnings: [],
  };
  const buttons: PluginButton[] = [];
  const agent = { id: "agent-1", workspaceId: "workspace-1", provider: "codex" };
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
