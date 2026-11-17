import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_METADATA_KEY, AGENT_METADATA_KEY, type AccountView, type AgentRoute, type StateView } from "../shared/model";
import { setAgentAccount } from "../shared/rpc";
import { FOLLOW, MANAGE, accountChoices, agentChoices, contributeComposerItem } from "./composer-item";
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
vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  useStore: (store: { state: StateView | null }) => ({ state: store.state }),
}));

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
    autoSwitch: true,
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
      icon: "CircleUserRound",
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
  const moved = { reopened: ["agent-1"], deferred: [], failed: [], pending: [], continuedIn: null };
  const rpc = vi.fn(async (_contract: unknown, _input: unknown): Promise<unknown> => moved);
  const openSurface = vi.fn();
  app.useComposer = () => ({ context: composer.context, agent: { provider: composer.provider ?? "claude", metadata: composer.metadata ?? {} }, setMetadata });
  app.Select = "Select";
  const client = {
    openSurface,
    addComposerItem(item: Item) {
      items.push(item);
      return () => removed.push(item.id);
    },
  } as unknown as PluginClientContext;
  const control = contributeComposerItem(client, { state, rpc } as unknown as ZeroSubStore);
  return { items, removed, setMetadata, rpc, openSurface, control, render: () => items[0]!.Component() };
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
    const older = contributeComposerItem({} as PluginClientContext, store);
    expect(older.added).toBe(false);
    expect(() => older.stop()).not.toThrow();
    // Whichever of the three is missing, nothing is added, and the account button is told so.
    expect(contributeComposerItem({ addComposerItem: added } as unknown as PluginClientContext, store).added).toBe(false);
    app.useComposer = () => ({});
    expect(contributeComposerItem({ addComposerItem: added } as unknown as PluginClientContext, store).added).toBe(false);
    expect(added).not.toHaveBeenCalled();
  });

  it("is added once and removed with the plugin", () => {
    const { items, removed, control } = setUp(view([main, work]), { context: "draft" });
    expect(items.map((item) => item.id)).toEqual(["account"]);
    expect(control.added).toBe(true);
    control.stop();
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
    const control = contributeComposerItem(client, { state: null } as unknown as ZeroSubStore);
    expect(control.added).toBe(false);
    expect(() => control.stop()).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("shows in a new agent's tab and on the New workspace screen, and for a running agent only once it knows which", () => {
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

  it("hands Paseo a refusal to show, as when the host has no metadata", async () => {
    const { render, setMetadata } = setUp(view([main, work]), { context: "draft" });
    setMetadata.mockRejectedValueOnce(new Error("Update the host to use metadata."));
    const change = render()!.props.onValueChange as (event: { value: string }) => Promise<void>;
    await expect(change({ value: "work" })).rejects.toThrow("Update the host to use metadata.");
  });
});

const route = (fields: Partial<AgentRoute> = {}): AgentRoute => ({
  agentId: "agent-1",
  family: "claude",
  accountId: "main",
  pinned: false,
  pendingAccountId: null,
  waiting: null,
  movable: true,
  inComposer: true,
  ...fields,
});
const running = (accounts: AccountView[], fields: Partial<AgentRoute> = {}, more: Partial<StateView> = {}) => view(accounts, { agents: [route(fields)], ...more });

describe("the accounts a running agent's composer offers", () => {
  it("lists the agent's account first, then the others, and the Accounts screen", () => {
    expect(agentChoices(running([work, main, home]), "agent-1")).toEqual({
      icon: "CircleUserRound",
      value: "main",
      options: [
        { value: "main", label: "main", description: "42% used" },
        { value: "work", label: "work", description: "7% used" },
        { value: "home", label: "home", description: undefined },
        { value: MANAGE, label: "Manage accounts…" },
      ],
    });
  });

  it("offers the way back to the default to an agent that was given an account", () => {
    const options = agentChoices(running([main, work], { accountId: "work", pinned: true }), "agent-1")!.options;
    expect(options.map((option) => option.label)).toEqual(["work", "main", "Follow default (main)", "Manage accounts…"]);
    expect(options[2]!.value).toBe(FOLLOW);
  });

  it("names both accounts while a move is under way, as the account button does", () => {
    const moving = agentChoices(running([main, work], { accountId: "work", pinned: true, pendingAccountId: "main", waiting: "turn" }), "agent-1")!;
    expect(moving.value).toBe("work");
    expect(moving.options[0]!.label).toBe("main → work");
  });

  it("leaves out accounts the agent can't move to, and marks its own at a limit", () => {
    const full = account("main", { isDefault: true, status: "limited" });
    const state = running([full, work, account("out", { status: "signed_out" }), account("off", { status: "disabled" }), account("spent", { status: "limited" })]);
    const choices = agentChoices(state, "agent-1")!;
    expect(choices.icon).toBe("CircleAlert");
    expect(choices.options.map((option) => option.value)).toEqual(["main", "work", MANAGE]);
    expect(choices.options[0]!.description).toBe("Limit reached");
    // With automatic switching off, an agent can be put on an account at its limit.
    expect(agentChoices({ ...state, autoSwitch: false }, "agent-1")!.options.map((option) => option.value)).toEqual(["main", "work", "spent", MANAGE]);
  });

  it("offers a ChatGPT thread its continuation on another account, and a Grok conversation no other", () => {
    const chatgpt = [account("a", { family: "codex", isDefault: true }), account("b", { family: "codex" })];
    const thread = agentChoices(running(chatgpt, { family: "codex", accountId: "a", movable: false, pinned: true }), "agent-1")!;
    expect(thread.options.map((option) => option.label)).toEqual(["a", "Continue on b", "Manage accounts…"]);
    const grok = [account("x", { family: "grok", isDefault: true }), account("y", { family: "grok" })];
    const conversation = agentChoices(running(grok, { family: "grok", accountId: "x", movable: false }), "agent-1")!;
    expect(conversation.options.map((option) => option.label)).toEqual(["x", "Manage accounts…"]);
  });

  it("offers nothing for an agent it can't place, with one account, or with the account button off", () => {
    expect(agentChoices(running([main, work]), "another-agent")).toBeNull();
    expect(agentChoices(running([main, work], { inComposer: false }), "agent-1")).toBeNull();
    expect(agentChoices(running([main, work], { accountId: "gone" }), "agent-1")).toBeNull();
    expect(agentChoices(running([main]), "agent-1")).toBeNull();
    expect(agentChoices(running([main, work], {}, { showComposerPill: false }), "agent-1")).toBeNull();
  });
});

describe("the account control of a running agent", () => {
  beforeEach(() => {
    app.useComposer = undefined;
    app.Select = undefined;
  });
  const named = { [AGENT_METADATA_KEY]: "agent-1" };

  it("shows the agent's account once the agent's metadata says which agent it is", () => {
    const element = setUp(running([main, work]), { context: "agent", metadata: named }).render();
    expect(element?.type).toBe("Select");
    expect(element?.props).toMatchObject({ title: "Account", icon: "CircleUserRound", value: "main" });
    // Until the daemon has written the ID there, and for an agent it doesn't route, nothing shows.
    expect(setUp(running([main, work]), { context: "agent" }).render()).toBeNull();
    expect(setUp(running([main, work]), { context: "agent", metadata: { [AGENT_METADATA_KEY]: "another-agent" } }).render()).toBeNull();
    expect(setUp(running([main, work]), { context: "agent", metadata: { [AGENT_METADATA_KEY]: 7 } }).render()).toBeNull();
  });

  it("moves the agent to the chosen account, and back to the default", async () => {
    const { render, rpc, setMetadata } = setUp(running([main, work], { accountId: "work", pinned: true }), { context: "agent", metadata: named });
    const change = render()!.props.onValueChange as (event: { value: string }) => Promise<void> | void;
    await change({ value: "main" });
    expect(rpc).toHaveBeenLastCalledWith(setAgentAccount, { agentId: "agent-1", accountId: "main" });
    await change({ value: FOLLOW });
    expect(rpc).toHaveBeenLastCalledWith(setAgentAccount, { agentId: "agent-1", accountId: null });
    expect(rpc).toHaveBeenCalledTimes(2);
    // The account it's on already is no move, and a running agent's choice isn't kept in its metadata.
    await change({ value: "work" });
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(setMetadata).not.toHaveBeenCalled();
  });

  it("opens the Accounts screen from its last choice", async () => {
    const { render, rpc, openSurface } = setUp(running([main, work]), { context: "agent", metadata: named });
    await (render()!.props.onValueChange as (event: { value: string }) => Promise<void> | void)({ value: MANAGE });
    expect(openSurface).toHaveBeenCalledWith("accounts");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("hands Paseo a move that didn't work, to show", async () => {
    const { render, rpc } = setUp(running([main, work]), { context: "agent", metadata: named });
    rpc.mockResolvedValueOnce({ reopened: [], deferred: [], failed: [{ agentId: "agent-1", error: "no session" }], pending: [], continuedIn: null });
    const change = render()!.props.onValueChange as (event: { value: string }) => Promise<void>;
    await expect(change({ value: "work" })).rejects.toThrow(/work/);
  });
});
