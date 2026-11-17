import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_METADATA_KEY, type AccountView, type StateView } from "../shared/model";
import { FOLLOW, accountChoices, contributeComposerItem } from "./composer-item";
import type { ZeroSubStore } from "./store";

// What the app hands a plugin: Paseo 0.16 has `useComposer` and `Select`, an older app has neither.
const app = vi.hoisted(() => ({ useComposer: undefined as unknown, Select: undefined as unknown }));
vi.mock("@getpaseo/plugin/client", () => ({
  get useComposer() {
    return app.useComposer;
  },
}));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  get Select() {
    return app.Select;
  },
}));
vi.mock("./store", () => ({ useStore: (store: { state: StateView | null }) => ({ state: store.state }) }));

function account(id: string, fields: Partial<AccountView> = {}): AccountView {
  return {
    id,
    family: "claude",
    label: id,
    kind: "managed",
    email: null,
    plan: null,
    organization: null,
    status: "ready",
    isDefault: false,
    limitedUntil: null,
    usage: null,
    agentCount: 0,
    home: null,
    auth: "subscription",
    api: null,
    apiEditable: false,
    proxy: null,
    proxyEditable: false,
    proxyBlocked: null,
    inheritedProxy: null,
    proxyFile: null,
    proxyFollowers: [],
    launcher: null,
    egress: null,
    externalHome: false,
    moving: null,
    azure: null,
    ...fields,
  };
}

const used = (usedPercent: number): AccountView["usage"] => ({
  fetchedAt: "2026-11-09T12:00:00Z",
  windows: [{ id: "five_hour", label: "5-hour", usedPercent, resetsAt: null }],
  error: null,
  cached: false,
  resets: null,
  credits: null,
});

function view(accounts: AccountView[], fields: Partial<StateView> = {}): StateView {
  return {
    accounts,
    agents: [],
    logins: [],
    providers: { claude: "claude", "claude-team": "claude", codex: "codex" },
    canReopen: true,
    browserSignIn: true,
    launchers: null,
    piLaunchers: null,
    piHomes: null,
    claudeHomes: null,
    showComposerPill: true,
    openCodeAvailable: false,
    autoSwitch: true,
    agentMetadata: true,
    warnings: [],
    ...fields,
  };
}

const main = account("main", { isDefault: true, usage: used(42) });
const work = account("work", { usage: used(7) });
const home = account("home");

describe("the accounts a composer without an agent offers", () => {
  it("lists the default first, as the choice that names no account, then the others", () => {
    expect(accountChoices(view([work, main, home]), "claude", undefined)).toEqual({
      value: FOLLOW,
      options: [
        { value: FOLLOW, label: "main", description: "Default · 42% used" },
        { value: "work", label: "work", description: "7% used" },
        { value: "home", label: "home", description: undefined },
      ],
    });
  });

  it("shows the account that was chosen, also for a profile of the provider", () => {
    expect(accountChoices(view([main, work]), "claude", "work")?.value).toBe("work");
    expect(accountChoices(view([main, work]), "claude-team", "work")?.value).toBe("work");
  });

  it("reads a choice it doesn't offer as none", () => {
    const state = view([main, work, account("chatgpt", { family: "codex" }), account("out", { status: "signed_out" })]);
    for (const chosen of ["gone", "chatgpt", "out", "main", "", 7, null, { id: "work" }]) {
      expect(accountChoices(state, "claude", chosen)?.value, String(chosen)).toBe(FOLLOW);
    }
  });

  it("offers nothing where the host's Paseo keeps no agent metadata to carry the choice in", () => {
    // An app from 0.16 with a host before it, or a ZeroSub on the host from before it said.
    expect(accountChoices(view([main, work], { agentMetadata: false }), "claude", undefined)).toBeNull();
    expect(accountChoices(view([main, work], { agentMetadata: undefined }), "claude", undefined)).toBeNull();
  });

  it("offers nothing without a second account, with the account button off, or for a provider ZeroSub doesn't route", () => {
    expect(accountChoices(view([main]), "claude", undefined)).toBeNull();
    expect(accountChoices(view([main, account("chatgpt", { family: "codex" })]), "claude", undefined)).toBeNull();
    expect(accountChoices(view([main, work], { showComposerPill: false }), "claude", undefined)).toBeNull();
    expect(accountChoices(view([main, work]), "opencode", undefined)).toBeNull();
    expect(accountChoices(view([main, work]), null, undefined)).toBeNull();
  });

  it("leaves out accounts that can't take a new agent", () => {
    const state = view([main, work, account("out", { status: "signed_out" }), account("off", { status: "disabled" }), account("full", { status: "limited" })]);
    expect(accountChoices(state, "claude", undefined)?.options.map((option) => option.value)).toEqual([FOLLOW, "work"]);
    // With automatic switching off, an agent may start on an account at its limit.
    const manual = accountChoices({ ...state, autoSwitch: false }, "claude", "full");
    expect(manual?.value).toBe("full");
    expect(manual?.options.at(-1)).toEqual({ value: "full", label: "full", description: "Limit reached" });
  });

  it("says Automatic when new agents are spread, or the default can't take one, and lists every account", () => {
    const automatic = { value: FOLLOW, label: "Automatic", description: "The account with the most room" };
    expect(accountChoices(view([main, work], { balanceNewAgents: true }), "claude", undefined)?.options).toEqual([
      automatic,
      { value: "main", label: "main", description: "42% used" },
      { value: "work", label: "work", description: "7% used" },
    ]);
    const full = account("main", { isDefault: true, status: "limited" });
    expect(accountChoices(view([full, work, home]), "claude", undefined)?.options.map((option) => option.label)).toEqual(["Automatic", "work", "home"]);
  });

  it("puts the next-new-agent pick first, ahead of spreading and the default", () => {
    const picked = account("work", { nextAgentUntil: "2026-11-09T12:10:00Z", usage: used(7) });
    for (const balanceNewAgents of [false, true]) {
      expect(accountChoices(view([main, picked], { balanceNewAgents }), "claude", undefined)?.options).toEqual([
        { value: FOLLOW, label: "work", description: "Picked for the next new agent · 7% used" },
        { value: "main", label: "main", description: "42% used" },
      ]);
    }
  });
});

interface Item {
  id: string;
  Component: () => ReactElement<Record<string, unknown>> | null;
}

/** The app as `contributeComposerItem` sees it, and the composer its item sits in. */
function setUp(state: StateView | null, composer: { context: string; provider?: string | null; metadata?: Record<string, unknown> }) {
  const items: Item[] = [];
  const removed: string[] = [];
  const setMetadata = vi.fn(async (_patch: Record<string, string | null>) => undefined);
  app.useComposer = () => ({ context: composer.context, agent: { provider: composer.provider ?? "claude", metadata: composer.metadata ?? {} }, setMetadata });
  app.Select = "Select";
  const client = {
    addComposerItem(item: Item) {
      items.push(item);
      return () => removed.push(item.id);
    },
  } as unknown as PluginClientContext;
  const stop = contributeComposerItem(client, { state } as unknown as ZeroSubStore);
  return { items, removed, setMetadata, stop, render: () => items[0]!.Component() };
}

describe("the account control for an agent that doesn't exist yet", () => {
  beforeEach(() => {
    app.useComposer = undefined;
    app.Select = undefined;
  });

  it("is left out of an app without composer items", () => {
    const store = { state: view([main, work]) } as unknown as ZeroSubStore;
    const added = vi.fn(() => () => undefined);
    // Paseo before 0.16: no `addComposerItem`, no `useComposer`, no `Select`.
    expect(() => contributeComposerItem({} as PluginClientContext, store)()).not.toThrow();
    // Whichever of the three is missing, nothing is added.
    contributeComposerItem({ addComposerItem: added } as unknown as PluginClientContext, store)();
    app.useComposer = () => ({});
    contributeComposerItem({ addComposerItem: added } as unknown as PluginClientContext, store)();
    expect(added).not.toHaveBeenCalled();
  });

  it("is added once and removed with the plugin", () => {
    const { items, removed, stop } = setUp(view([main, work]), { context: "draft" });
    expect(items.map((item) => item.id)).toEqual(["account"]);
    stop();
    expect(removed).toEqual(["account"]);
  });

  it("carries on without it when the app refuses the item", () => {
    app.useComposer = () => ({});
    app.Select = "Select";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const client = {
      addComposerItem() {
        throw new Error("Duplicate composer item");
      },
    } as unknown as PluginClientContext;
    expect(() => contributeComposerItem(client, { state: null } as unknown as ZeroSubStore)()).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("shows in a new agent's tab and on the New workspace screen, and not for a running agent, which has its account button", () => {
    for (const context of ["draft", "new-workspace"]) {
      const element = setUp(view([main, work]), { context, metadata: { [ACCOUNT_METADATA_KEY]: "work" } }).render();
      expect(element?.type, context).toBe("Select");
      expect(element?.props, context).toMatchObject({ title: "Account", icon: "CircleUserRound", value: "work" });
      expect((element?.props.options as { value: string }[]).map((option) => option.value), context).toEqual([FOLLOW, "work"]);
    }
    expect(setUp(view([main, work]), { context: "agent" }).render()).toBeNull();
  });

  it("shows nothing until the accounts are known, or when there's nothing to choose", () => {
    expect(setUp(null, { context: "draft" }).render()).toBeNull();
    expect(setUp(view([main]), { context: "draft" }).render()).toBeNull();
    expect(setUp(view([main, work]), { context: "draft", provider: "opencode" }).render()).toBeNull();
  });

  it("names the chosen account in the new agent's metadata, and takes it out again for the first choice", async () => {
    const { render, setMetadata } = setUp(view([main, work]), { context: "draft" });
    const change = render()!.props.onValueChange as (event: { value: string }) => Promise<void>;
    await change({ value: "work" });
    expect(setMetadata).toHaveBeenLastCalledWith({ [ACCOUNT_METADATA_KEY]: "work" });
    await change({ value: FOLLOW });
    expect(setMetadata).toHaveBeenLastCalledWith({ [ACCOUNT_METADATA_KEY]: null });
  });

  it("doesn't show on a host without metadata support, where choosing would fail the agent's creation", () => {
    for (const context of ["draft", "new-workspace"]) {
      expect(setUp(view([main, work], { agentMetadata: false }), { context }).render(), context).toBeNull();
      expect(setUp(view([main, work], { agentMetadata: undefined }), { context }).render(), context).toBeNull();
    }
  });
});
