import type { PluginButton, PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountView, StateView } from "../shared/model";
import { preferences } from "../shared/preferences";
import { setAgentAccount } from "../shared/rpc";
import type { MenuEntry } from "./account-menu";
import { forgetControlsShown, setControlShown } from "./control-visibility";
import { agentMenu, contributePills } from "./pills";
import { resetPopover } from "./reset-confirm";
import type { StoreSnapshot, ZeroSubStore } from "./store";

// The menu and the confirmations are React Native views; the pill logic only hands them what they
// need. The menu, mocked, keeps what it reads its entries with, so they can be read as it would.
vi.mock("./account-menu", () => ({
  accountMenu: (_store: unknown, entriesOf: (state: StateView) => readonly MenuEntry[]) => Object.assign(() => null, { entriesOf }),
}));
vi.mock("./reset-confirm", () => ({ resetPopover: vi.fn(() => () => null) }));
vi.mock("./fork-confirm", () => ({ forkPopover: vi.fn(() => () => null), openCodeForkPopover: vi.fn(() => () => null) }));

const AGENT = "agent-1";

function account(id: string, overrides: Partial<AccountView> = {}): AccountView {
  return {
    id,
    family: "claude",
    label: id,
    kind: "managed",
    auth: "subscription",
    api: null,
    apiEditable: false,
    email: null,
    plan: null,
    organization: null,
    status: "ready",
    disabled: false,
    isDefault: false,
    limitedUntil: null,
    usage: null,
    agentCount: 0,
    home: null,
    externalHome: false,
    sessionsShared: null,
    proxy: null,
    proxyEditable: false,
    inheritedProxy: null,
    proxyBlocked: null,
    proxyFile: null,
    proxyFollowers: [],
    launcher: null,
    egress: null,
    moving: null,
    pace: null,
    azure: null,
    bedrock: null,
    apiError: null,
    ...overrides,
  };
}

function used(percent: number): AccountView["usage"] {
  return {
    fetchedAt: "2026-10-28T10:00:00Z",
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: null }],
    error: null,
    cached: false,
    resets: null,
    credits: null,
  };
}

function view(accounts: AccountView[], overrides: Partial<StateView> = {}, provider = "claude"): StateView {
  const family = provider === "codex" ? "codex" : provider === "pi" ? "pi" : "claude";
  const current = accounts.find((entry) => entry.family === family);
  return {
    version: 1,
    accounts,
    agents: current
      ? [{ agentId: AGENT, family, accountId: current.id, pinned: false, pendingAccountId: null, waiting: null, movable: true }]
      : [],
    logins: [],
    providers: { claude: "claude", codex: "codex", pi: "pi" },
    canReopen: true,
    browserSignIn: true,
    launchers: null,
    claudeHomes: null,
    piLaunchers: null,
    piHomes: null,
    showComposerPill: true,
    keepComposerPill: true,
    openCodeAvailable: false,
    autoSwitch: false,
    autoContinue: true,
    warnings: [],
    ...overrides,
  };
}

/** The pill contributor over a store and a Paseo client that only do what it uses. */
async function harness(initial: StateView, provider = "claude", inComposer = false) {
  let snapshot: StoreSnapshot = { state: initial, error: null, updatedAt: 0 };
  const listeners = new Set<() => void>();
  const store = {
    get current() {
      return snapshot;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: vi.fn(async () => undefined),
    rpc: vi.fn(),
  } as unknown as ZeroSubStore;
  const registration = { update: vi.fn(), remove: vi.fn() };
  let observer: { snapshot(page: unknown): void; update(message: unknown): void } | null = null;
  const client = {
    addComposerPill: vi.fn((_: { button: PluginButton }) => registration),
    openSurface: vi.fn(),
    paseo: {
      agents: {
        list: vi.fn(async () => ({ subscription: { subscribe: (next: typeof observer) => void (observer = next) } })),
      },
    },
  };
  const stop = contributePills(client as unknown as PluginClientContext, store, inComposer);
  await vi.advanceTimersByTimeAsync(0);
  observer!.snapshot({ entries: [{ agent: { id: AGENT, workspaceId: "ws-1", provider } }], pageInfo: { hasMore: false, nextCursor: null } });
  return {
    store,
    client,
    registration,
    stop,
    publish(state: StateView) {
      snapshot = { state, error: null, updatedAt: 0 };
      for (const listener of [...listeners]) listener();
    },
    /** Paseo reporting a change to an agent, maybe one the pill hasn't seen. */
    agentChanged(id: string) {
      observer!.update({ type: "agent_update", payload: { kind: "upsert", agent: { id, workspaceId: "ws-1", provider } } });
    },
    /** The menu as it reads now. */
    items(): readonly MenuEntry[] {
      const behavior = client.addComposerPill.mock.calls.at(-1)?.[0].button.behavior;
      if (behavior?.kind !== "popover" || !snapshot.state) return [];
      return (behavior.Content as unknown as { entriesOf(state: StateView): readonly MenuEntry[] }).entriesOf(snapshot.state);
    },
    /** The pill as Paseo shows it now. */
    face(): Partial<PluginButton> {
      const added = client.addComposerPill.mock.calls.at(-1)?.[0].button;
      return Object.assign({}, added, ...registration.update.mock.calls.map(([patch]) => patch as Partial<PluginButton>));
    },
  };
}

/** Each account's entry: its name, then the line under it. */
function rows(items: readonly MenuEntry[]): [string, string | null][] {
  return items.flatMap((item) => (item.kind === "item" && item.id.startsWith("account-") ? [[item.title, item.detail ?? null] as [string, string | null]] : []));
}

function titles(items: readonly MenuEntry[]): string[] {
  return items.flatMap((item) => (item.kind === "item" ? [item.title] : []));
}

function press(items: readonly MenuEntry[], id: string): Promise<void> {
  const item = items.find((entry) => entry.id === id);
  if (item?.kind !== "item" || item.behavior.kind !== "action") throw new Error(`no action ${id}`);
  return Promise.resolve(item.behavior.onPress());
}

describe("account pills", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(resetPopover).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("hands Paseo its menu once, which reads the accounts as they are each time it shows", async () => {
    const work = account("work", { isDefault: true, usage: used(20) });
    const home = account("home", { usage: used(31) });
    const pill = await harness(view([work, home]));
    expect(rows(pill.items())).toEqual([
      ["work", "5h 20%"],
      ["home", "5h 31%"],
    ]);
    pill.publish(view([{ ...work, usage: used(24) }, { ...home, usage: used(38) }]));
    expect(rows(pill.items())).toEqual([
      ["work", "5h 24%"],
      ["home", "5h 38%"],
    ]);
    // Only the pill's own text is updated: a new menu would close the one open.
    expect(pill.registration.update).toHaveBeenCalledTimes(1);
    expect(pill.registration.update).toHaveBeenLastCalledWith({ label: "5h 24", title: "Claude account: work\n5h 24%", icon: "CircleUserRound" });
  });

  it("names the provider first in the tooltip, so a Claude and a ChatGPT account of the same name don't look alike", async () => {
    // One person signed in to both. The icon is the same for every provider: Paseo shares none of its own.
    const accounts = [
      account("claude-work", { label: "work", isDefault: true }),
      account("claude-home", { label: "home" }),
      account("codex-work", { family: "codex", label: "work", isDefault: true }),
      account("codex-home", { family: "codex", label: "home" }),
    ];
    const claude = await harness(view(accounts));
    const codex = await harness(view(accounts, {}, "codex"), "codex");
    expect(claude.face()).toMatchObject({ label: "work", title: "Claude account: work", icon: "CircleUserRound" });
    expect(codex.face()).toMatchObject({ label: "work", title: "ChatGPT account: work", icon: "CircleUserRound" });
    // At its limit the account keeps the alert icon, and the tooltip still names the provider.
    codex.publish(view(accounts.map((entry) => (entry.id === "codex-work" ? { ...entry, status: "limited" as const } : entry)), {}, "codex"));
    expect(codex.face()).toMatchObject({ title: "ChatGPT account: work", icon: "CircleAlert" });
  });

  it("shows the windows that stop the whole account, not one model's full window", async () => {
    const work = account("work", { isDefault: true });
    const opusFull = used(20)!;
    opusFull.windows.push({ id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 100, resetsAt: null });
    const pill = await harness(view([work, account("home", { usage: opusFull })]));
    expect(rows(pill.items())).toContainEqual(["home", "5h 20%"]);
  });

  it("shows no usage windows for Pi accounts, which report none", async () => {
    const main = account("Pi-ClaudeAPI-1", { family: "pi", kind: "main", isDefault: true });
    const added = account("Pi-ClaudeAPI-2", { family: "pi", auth: "api" });
    const pill = await harness(view([main, added], {}, "pi"), "pi");
    expect(rows(pill.items())).toEqual([
      ["Pi-ClaudeAPI-1", null],
      ["Pi-ClaudeAPI-2", null],
    ]);
  });

  it("puts each account's usage under it, with how long until each window resets", async () => {
    // Local times, so it reads the same in every time zone. 28 October 2026 is a Wednesday.
    vi.setSystemTime(new Date(2026, 9, 28, 15, 20));
    const windows = (five: number, week: number) => [
      { id: "five_hour", label: "5-hour", usedPercent: five, resetsAt: new Date(2026, 9, 28, 18, 0).toISOString() },
      { id: "seven_day", label: "Weekly", usedPercent: week, resetsAt: new Date(2026, 9, 30, 9, 0).toISOString() },
      { id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 100, resetsAt: null },
    ];
    const egress = { ip: "203.0.113.7", country: "US", checkedAt: new Date(2026, 9, 28, 15, 18).toISOString(), error: null };
    const work = account("work", { isDefault: true, proxy: "http://127.0.0.1:2020", egress, usage: { ...used(0)!, windows: windows(4, 24) } });
    const home = account("home", { status: "limited", usage: { ...used(0)!, windows: windows(100, 61) } });
    const busy = account("busy", { status: "limited", usage: { ...used(0)!, windows: windows(40, 50) } });
    const away = account("away", { status: "limited", limitedUntil: new Date(2026, 9, 28, 19, 30).toISOString() });
    const pill = await harness(view([work, home, busy, away]));
    expect(rows(pill.items())).toEqual([
      // Hours and minutes, or days and hours.
      ["work", "5h 4% ↻2h40m · 7d 24% ↻1d17h"],
      // A full window says it already.
      ["home", "5h 100% ↻2h40m · 7d 61% ↻1d17h"],
      ["busy (limit reached)", "5h 40% ↻2h40m · 7d 50% ↻1d17h"],
      // With no reading, the same windows, empty, and the limit's own end.
      ["away (limit reached ↻4h10m)", "5h – · 7d –"],
    ]);
    // The pill has room for the usage only; its tooltip has the account, then one line per window of usage.
    expect(pill.face()).toMatchObject({
      label: "5h 4 · 7d 24",
      title: "Claude account: work\n5h 4% · resets in 2h40m (18:00)\n7d 24% · resets in 1d17h (Fri 09:00)\nIP: 203.0.113.7 (US)",
    });
    // The countdowns keep up as time goes by.
    vi.setSystemTime(new Date(2026, 9, 28, 15, 21));
    pill.publish(view([work, home, busy, away]));
    expect(pill.face().title).toMatch(/^Claude account: work\n5h 4% · resets in 2h39m \(18:00\)\n/);
    expect(rows(pill.items())[0]).toEqual(["work", "5h 4% ↻2h39m · 7d 24% ↻1d17h"]);
    // Under a day, the weekly window counts hours and minutes too; the 5-hour one has started again.
    vi.setSystemTime(new Date(2026, 9, 29, 15, 34));
    pill.publish(view([work, home, busy, away]));
    expect(rows(pill.items())[0]).toEqual(["work", "5h 0% · 7d 24% ↻17h26m"]);
  });

  it("gives an API account, billed per use with no windows, only its name", async () => {
    const pill = await harness(view([account("work", { isDefault: true, usage: used(10) }), account("api", { auth: "api" })]));
    expect(rows(pill.items())).toEqual([
      ["work", "5h 10%"],
      ["api", null],
    ]);
  });

  it("names both accounts on the pill while a move is under way, whatever their usage", async () => {
    const egress = (ip: string) => ({ ip, country: "US", checkedAt: new Date().toISOString(), error: null });
    const work = account("work", { isDefault: true, egress: egress("203.0.113.7"), usage: used(10) });
    const moving = view([work, account("home", { egress: egress("198.51.100.4"), usage: used(20) })]);
    moving.agents = [{ ...moving.agents[0]!, accountId: "home", pinned: true, pendingAccountId: "work", waiting: "turn" }];
    const pill = await harness(moving);
    expect(pill.face()).toMatchObject({
      label: "work → home",
      // The address is the one of the account the agent still runs on.
      title: "Claude account: work, moving to home when its current turn ends\nIP: 203.0.113.7 (US)",
    });
  });

  it("says a move asked for from the menu is under way until its answer is in", async () => {
    const state = view([account("work", { isDefault: true }), account("home")]);
    const pill = await harness(state);
    let answer!: (summary: unknown) => void;
    vi.mocked(pill.store.rpc).mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    const pressed = press(pill.items(), "account-1");
    expect(pill.store.rpc).toHaveBeenCalledWith(setAgentAccount, { agentId: AGENT, accountId: "home" });
    expect(pill.face()).toMatchObject({ label: "work → home", title: "Claude account: moving to home…" });
    const moved = view([account("work", { isDefault: true }), account("home")]);
    moved.agents = [{ ...moved.agents[0]!, accountId: "home", pinned: true }];
    pill.publish(moved);
    answer({ continuedIn: null, reopened: [], pending: [], deferred: [], failed: [] });
    await pressed;
    await vi.advanceTimersByTimeAsync(0);
    expect(pill.face()).toMatchObject({ label: "home", title: "Claude account: home" });
  });

  it("says why a move from the menu didn't happen now", async () => {
    const pill = await harness(view([account("work", { isDefault: true }), account("home")]));
    vi.mocked(pill.store.rpc).mockResolvedValue({
      continuedIn: null,
      reopened: [],
      pending: [],
      deferred: [],
      failed: [{ agentId: AGENT, error: "Agent is busy." }],
    } as never);
    await expect(press(pill.items(), "account-1")).rejects.toThrow("Couldn't reload this agent onto home (Agent is busy)");
    await vi.advanceTimersByTimeAsync(0);
    // The pill goes back to what the daemon says.
    expect(pill.face()).toMatchObject({ label: "work" });
  });

  it("starts a window past its reset again from nothing", async () => {
    vi.setSystemTime(new Date(2026, 9, 28, 17, 59));
    const reading = { ...used(0)!, windows: [{ id: "five_hour", label: "5-hour", usedPercent: 4, resetsAt: new Date(2026, 9, 28, 18, 0).toISOString() }] };
    const state = view([account("work", { isDefault: true }), account("home", { usage: reading })]);
    const pill = await harness(state);
    expect(rows(pill.items())).toContainEqual(["home", "5h 4% ↻1m"]);
    vi.setSystemTime(new Date(2026, 9, 28, 18, 0, 30));
    pill.publish(state);
    expect(rows(pill.items())).toContainEqual(["home", "5h 0%"]);
  });

  it("looks up a new agent's account at once, and again once the daemon's list of agents is renewed", async () => {
    const pill = await harness(view([account("work", { isDefault: true }), account("home")]));
    vi.mocked(pill.store.refresh).mockClear();
    pill.agentChanged("agent-2");
    pill.agentChanged("agent-3");
    expect(pill.store.refresh).toHaveBeenCalledTimes(2);
    expect(pill.store.refresh).toHaveBeenCalledWith({ fresh: true });
    await vi.advanceTimersByTimeAsync(3_500);
    expect(pill.store.refresh).toHaveBeenCalledTimes(3);
    // An agent it already knows needs no lookup.
    pill.agentChanged("agent-2");
    await vi.advanceTimersByTimeAsync(3_500);
    expect(pill.store.refresh).toHaveBeenCalledTimes(3);

    pill.agentChanged("agent-4");
    pill.stop();
    await vi.advanceTimersByTimeAsync(3_500);
    expect(pill.store.refresh).toHaveBeenCalledTimes(4);
  });

  it("updates the pill's own text in place, and only when it says something new", async () => {
    const work = account("work", { isDefault: true });
    const home = account("home");
    const pill = await harness(view([work, home]));
    pill.publish(view([work, home]));
    expect(pill.registration.update).not.toHaveBeenCalled();
    const moving = view([work, home]);
    moving.agents = [{ ...moving.agents[0]!, accountId: "home", pinned: true, pendingAccountId: "work", waiting: "turn" }];
    pill.publish(moving);
    const landed = view([work, home]);
    landed.agents = [{ ...moving.agents[0]!, pendingAccountId: null, waiting: null }];
    pill.publish(landed);
    expect(pill.registration.update).toHaveBeenCalledTimes(2);
    const patch = pill.registration.update.mock.calls.at(-1)?.[0] as Partial<PluginButton>;
    expect(patch).toEqual({ label: "home", title: "Claude account: home", icon: "CircleUserRound" });
    // The check mark has moved in the menu all the same.
    expect(pill.items().find((item) => item.id === "account-1")).toMatchObject({ icon: "CircleCheck", disabled: true });
  });

  it("shows what the menu offers as it changes", async () => {
    const work = account("work", { isDefault: true });
    const home = account("home");
    const pill = await harness(view([work, home], { autoSwitch: true }));
    pill.publish(view([work, { ...home, status: "limited" }], { autoSwitch: true }));
    const limited = pill.items().find((item) => item.kind === "item" && item.title === "home (limit reached)");
    expect(limited).toMatchObject({ detail: "5h – · 7d –", disabled: true });
  });

  it("offers a banked reset as a confirmation that reads the account itself", async () => {
    const resets = { available: 1, usableNow: true, blockedReason: null, expiresAt: null, refills: [], label: null };
    const work = account("work", { isDefault: true, status: "limited", usage: { ...used(100)!, resets } });
    const pill = await harness(view([work, account("home", { status: "limited" })]));
    // It gets the account's id and reads the account from the store, so it never shows an old copy.
    expect(pill.items()[0]).toMatchObject({ id: "use-reset", behavior: { kind: "popover" } });
    expect(resetPopover).toHaveBeenCalledWith(pill.store, "work", AGENT);
  });

  it("doesn't offer a banked reset on an account that's signed out", async () => {
    // Usage keeps the resets it last read when a signed-out account reports no windows.
    const resets = { available: 1, usableNow: true, blockedReason: null, expiresAt: null, refills: [], label: null };
    const work = account("work", { isDefault: true, status: "signed_out", usage: { ...used(40)!, resets } });
    const pill = await harness(view([work, account("home")]));
    expect(pill.items().map((item) => item.id)).not.toContain("use-reset");
  });

  it("only offers to continue on the other provider when an account there can take the work", async () => {
    const chatgpt = account("chatgpt", { family: "codex", isDefault: true, status: "limited" });
    const api = account("api", { auth: "api", isDefault: true });
    // The server never forks onto an API account, so there's nothing to offer, and one account needs no pill.
    const apiOnly = await harness(view([chatgpt, api], {}, "codex"), "codex");
    expect(apiOnly.client.addComposerPill).not.toHaveBeenCalled();
    apiOnly.stop();
    const pill = await harness(view([chatgpt, api, account("max")], {}, "codex"), "codex");
    expect(pill.items().map((item) => item.id)).toContain("fork-other");
    // Only Claude accounts say where their requests come from.
    expect(pill.face().title).toBe("ChatGPT account: chatgpt");
  });

  it("offers to continue on the other provider when only an API account of this one is ready", async () => {
    // The server counts this provider as out (it never moves work onto an API account) and says so.
    const work = account("work", { isDefault: true, status: "limited" });
    const api = account("api", { auth: "api" });
    const chatgpt = account("chatgpt", { family: "codex" });
    const pill = await harness(view([work, api, chatgpt]));
    expect(pill.items().map((item) => item.id)).toContain("fork-other");
  });

  it("doesn't offer the other provider when an API account of this one may stand in", async () => {
    const work = account("work", { isDefault: true, status: "limited" });
    const bedrock = account("bedrock", { auth: "api", bedrock: {} as NonNullable<AccountView["bedrock"]> });
    const chatgpt = account("chatgpt", { family: "codex" });
    const pill = await harness(view([work, bedrock, chatgpt], { paidApiFallback: true }));
    expect(pill.items().map((item) => item.id)).not.toContain("fork-other");
    // A plain API key never stands in, so it doesn't hold the other provider back.
    const key = account("key", { auth: "api" });
    const withKey = await harness(view([work, key, chatgpt], { paidApiFallback: true }));
    expect(withKey.items().map((item) => item.id)).toContain("fork-other");
  });

  it("shows an account that's disabled and signed out as both", async () => {
    const work = account("work", { isDefault: true });
    const away = account("away", { status: "signed_out", disabled: true });
    const pill = await harness(view([work, away]));
    expect(pill.items().find((item) => item.id === "account-1")).toMatchObject({
      title: "away (signed out, disabled)",
      detail: "5h – · 7d –",
      disabled: true,
    });
    expect(titles(pill.items())).toContain("Manage accounts…");
  });
});

/** Whether one Claude agent on `work`, with `home` to move to, gets a pill, and its menu if it does. */
async function buttons(options: { inComposer: boolean; keep?: boolean; agentMetadata?: boolean; route?: Partial<StateView["agents"][number]> | null; work?: Partial<AccountView>; openCodeAvailable?: boolean }) {
  const state = view([account("work", { isDefault: true, ...options.work }), account("home")], {
    openCodeAvailable: options.openCodeAvailable ?? false,
    autoSwitch: true,
    agentMetadata: options.agentMetadata,
    keepComposerPill: options.keep ?? false,
  });
  const agents = options.route === null ? [] : state.agents.map((route) => ({ ...route, ...options.route }));
  const pill = await harness({ ...state, agents }, "claude", options.inComposer);
  pill.stop();
  return { count: pill.client.addComposerPill.mock.calls.length, ids: pill.items().map((entry) => entry.id) };
}

describe("the account button, where the composer has the Account control", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    forgetControlsShown();
  });

  it("steps back for a running agent, also one the daemon hasn't listed yet", async () => {
    expect((await buttons({ inComposer: true, agentMetadata: true, route: { inComposer: true } })).count).toBe(0);
    expect((await buttons({ inComposer: true, agentMetadata: true, route: null })).count).toBe(0);
  });

  it("stays without the control: an older app, or a Paseo that keeps no agent metadata", async () => {
    expect((await buttons({ inComposer: false, agentMetadata: true, route: { inComposer: true } })).count).toBe(1);
    expect((await buttons({ inComposer: true, agentMetadata: false })).count).toBe(1);
    expect((await buttons({ inComposer: true })).count).toBe(1);
  });

  it("stands in for an agent the control can't show for", async () => {
    expect((await buttons({ inComposer: true, agentMetadata: true, route: { inComposer: false } })).count).toBe(1);
  });

  it("still offers the way out of a limit, which the control can't", async () => {
    const resets = { available: 1, usableNow: true, expiresAt: null };
    const usage = { fetchedAt: "2026-11-09T12:00:00Z", windows: [], error: null, cached: false, resets, credits: null } as unknown as AccountView["usage"];
    const stuck = await buttons({ inComposer: true, agentMetadata: true, route: { inComposer: true }, work: { status: "limited", usage } });
    expect(stuck.count).toBe(1);
    expect(stuck.ids).toContain("use-reset");
    // At its limit with nothing to offer, the control says so and the button has nothing to add.
    expect((await buttons({ inComposer: true, agentMetadata: true, route: { inComposer: true }, work: { status: "limited" } })).count).toBe(0);
  });

  it("stays for a Claude agent on a host with OpenCode, to keep Continue on OpenCode within reach", async () => {
    // The entry opens a confirmation, which the control can't, so it lives on the button alone.
    const kept = await buttons({ inComposer: true, agentMetadata: true, route: { inComposer: true }, openCodeAvailable: true });
    expect(kept.count).toBe(1);
    expect(kept.ids).toContain("fork-opencode");
    // Also for an agent the daemon hasn't listed yet.
    expect((await buttons({ inComposer: true, agentMetadata: true, route: null, openCodeAvailable: true })).count).toBe(1);
  });

  // The control shows only the account's name, and on a phone it sits in a sheet.
  // With keepComposerPill on, the button steps back only while the control is on screen.
  it("stays for a running agent while keepComposerPill is on and its control isn't on screen", async () => {
    expect((await buttons({ inComposer: true, keep: true, agentMetadata: true, route: { inComposer: true } })).count).toBe(1);
    expect((await buttons({ inComposer: true, keep: true, agentMetadata: true, route: null })).count).toBe(1);
    expect((await buttons({ inComposer: true, keep: true, agentMetadata: true, route: { inComposer: true }, work: { status: "limited" } })).count).toBe(1);
  });

  it("steps back while the control is on screen, and comes back when it goes off", async () => {
    const state = view([account("work", { isDefault: true }), account("home")], { autoSwitch: true, agentMetadata: true, keepComposerPill: true });
    const pill = await harness(state, "claude", true);
    expect(pill.client.addComposerPill).toHaveBeenCalledTimes(1);
    // The toolbar's control and a split pane's: the agent counts as shown while either is.
    const toolbar = {};
    const pane = {};
    setControlShown(AGENT, toolbar, true);
    setControlShown(AGENT, pane, true);
    expect(pill.registration.remove).toHaveBeenCalledTimes(1);
    setControlShown(AGENT, toolbar, false);
    expect(pill.client.addComposerPill).toHaveBeenCalledTimes(1);
    // The window narrows and Paseo moves the control into the composer's sheet.
    setControlShown(AGENT, pane, false);
    expect(pill.client.addComposerPill).toHaveBeenCalledTimes(2);
    // With the preference off it steps back as before, on screen or not.
    pill.publish({ ...state, keepComposerPill: false });
    expect(pill.registration.remove).toHaveBeenCalledTimes(2);
    pill.stop();
  });

  it("still offers the way out of a limit while the control is on screen", async () => {
    const resets = { available: 1, usableNow: true, expiresAt: null };
    const usage = { fetchedAt: "2026-11-09T12:00:00Z", windows: [], error: null, cached: false, resets, credits: null } as unknown as AccountView["usage"];
    setControlShown(AGENT, {}, true);
    expect((await buttons({ inComposer: true, keep: true, agentMetadata: true, route: { inComposer: true }, work: { status: "limited", usage } })).count).toBe(1);
    expect((await buttons({ inComposer: true, keep: true, agentMetadata: true, route: { inComposer: true } })).count).toBe(0);
  });

  it("keeps the pill unless the preference was turned off", () => {
    expect(preferences.schema.parse({}).keepComposerPill).toBe(true);
  });
});

describe("the account button's titles", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("show pacing while spreading, and today's text without it", async () => {
    const pace = { fiveHourUsed: 61, fiveHourProjected: 78, pendingFiveHour: 0, weeklyUsed: 30, pendingWeekly: 0, weekElapsed: 50, pending: 0, gated: true };
    const pill = await harness(view([account("work", { family: "codex", isDefault: true, pace }), account("home", { family: "codex" })], {}, "codex"), "codex");
    expect(rows(pill.items()).map(([title]) => title)).toEqual(["work (held back: busy hour)", "home"]);
  });
});

describe("the account button's reason row", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function routed(selectionReason?: "weekly_reset"): StateView {
    const state = view([account("work", { family: "codex", isDefault: true }), account("home", { family: "codex" })], {}, "codex");
    return { ...state, agents: state.agents.map((route) => ({ ...route, pinned: true, movable: false, selectionReason })) };
  }

  it("says when an agent started on its account because the weekly reset was near", async () => {
    const pill = await harness(routed("weekly_reset"), "codex");
    expect(pill.items()).toContainEqual(
      expect.objectContaining({ id: "selection-reason", title: "Started here: weekly reset was near", disabled: true }),
    );
  });

  it("has no reason row for an agent placed any other way", async () => {
    const pill = await harness(routed(), "codex");
    expect(pill.items().map((entry) => entry.id)).not.toContain("selection-reason");
  });

  it("puts a ChatGPT account's credits after its usage", async () => {
    const usage = { ...used(20)!, credits: { unlimited: false, balance: 57714 } };
    const state = view([account("work", { family: "codex", isDefault: true, usage }), account("home", { family: "codex" })], {}, "codex");
    const pill = await harness(state, "codex");
    expect(rows(pill.items())).toContainEqual(["work", "5h 20% · 57,714 ChatGPT credits left"]);
  });
});

describe("the account button on a Grok or Cursor conversation", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function staying(family: "grok" | "cursor" | "codex"): StateView {
    const state = view([account("work", { family, isDefault: true }), account("home", { family })]);
    return {
      ...state,
      providers: { ...state.providers, [family]: family },
      agents: [{ agentId: AGENT, family, accountId: "work", pinned: true, pendingAccountId: null, waiting: null, movable: false }],
    };
  }

  for (const [family, label] of [["grok", "Grok"], ["cursor", "Cursor"]] as const) {
    it(`lists ${label}'s other accounts without offering them, and says why`, async () => {
      const pill = await harness(staying(family), family);
      const items = pill.items();
      const accounts = items.filter((item) => item.kind === "item" && item.id.startsWith("account-"));
      expect(accounts).toHaveLength(2);
      for (const item of accounts) expect(item).toMatchObject({ disabled: true });
      expect(titles(items).some((title) => title.startsWith("Continue on"))).toBe(false);
      expect(items).toContainEqual(
        expect.objectContaining({ id: "stays", title: `${label} conversations stay on their account; new agents follow your pick`, disabled: true }),
      );
      expect(items.map((item) => item.id)).not.toContain("follow-default");
    });
  }

  it("still offers a ChatGPT conversation's continuation in another tab", async () => {
    const pill = await harness(staying("codex"), "codex");
    const items = pill.items();
    expect(titles(items)).toContain("Continue on home");
    expect(items.map((item) => item.id)).not.toContain("stays");
  });
});

describe("the OpenCode entry", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  const openCode = { openCodeAvailable: true };
  const entry = expect.objectContaining({ id: "fork-opencode", title: "Continue on OpenCode (new agent)…", icon: "Bot" });

  it("is on every Claude agent's menu, with no ready ChatGPT account and automatic forking beside the point", async () => {
    // forkOtherProvider is a server preference; the menu entry doesn't read it. The single Claude
    // account is limited and no ChatGPT account exists at all.
    const pill = await harness(view([account("solo", { isDefault: true, status: "limited" })], openCode));
    expect(pill.items()).toContainEqual(entry);
  });

  it("is never on a Codex agent's menu", async () => {
    const accounts = [account("work", { family: "codex", isDefault: true }), account("home", { family: "codex" })];
    const pill = await harness(view(accounts, openCode, "codex"), "codex");
    expect(pill.items().map((item) => item.id)).not.toContain("fork-opencode");
  });

  it("keeps the pill and the OpenCode entry for a single ready Claude account", async () => {
    // Nothing is limited and there is no way out to offer: the "Continue on OpenCode" entry is reason
    // enough for the pill to exist.
    const pill = await harness(view([account("solo", { isDefault: true })], openCode));
    expect(pill.items()).toContainEqual(entry);
  });

  it("leaves the OpenCode entry out when this host has no OpenCode", async () => {
    const pill = await harness(view([account("a", { isDefault: true }), account("b")]));
    expect(pill.items().map((item) => item.id)).not.toContain("fork-opencode");
  });

  it("hides the pill from a single ready Claude account when OpenCode is unavailable", async () => {
    const pill = await harness(view([account("solo", { isDefault: true })]));
    expect(pill.client.addComposerPill).not.toHaveBeenCalled();
    pill.stop();
  });

  it("still hides the pill from a single ready Codex account", async () => {
    const pill = await harness(view([account("solo", { family: "codex", isDefault: true })], openCode, "codex"), "codex");
    expect(pill.client.addComposerPill).not.toHaveBeenCalled();
    pill.stop();
  });
});

// The Account control opens the account button's own menu where it shows instead.
describe("the account button's menu, opened from the Account control", () => {
  afterEach(() => forgetControlsShown());

  it("lists the accounts as the button does, whole while the control is on screen, and moves the agent", async () => {
    const state = view([account("work", { isDefault: true, usage: used(20) }), account("home", { usage: used(31) })], { agentMetadata: true, keepComposerPill: true });
    setControlShown(AGENT, {}, true);
    const rpc = vi.fn(async () => ({ reopened: [AGENT], deferred: [], failed: [], pending: [], continuedIn: null }));
    const store = { current: { state, error: null, updatedAt: 0 }, refresh: vi.fn(async () => undefined), rpc } as unknown as ZeroSubStore;
    const menu = agentMenu({ openSurface: vi.fn() } as unknown as PluginClientContext, store, { id: AGENT, provider: "claude" }) as unknown as {
      entriesOf(state: StateView): readonly MenuEntry[];
    };
    const items = menu.entriesOf(state);
    expect(rows(items).map(([title]) => title)).toEqual(["work", "home"]);
    await press(items, "account-1");
    expect(rpc).toHaveBeenCalledWith(setAgentAccount, { agentId: AGENT, accountId: "home" });
    await vi.waitFor(() => expect(store.refresh).toHaveBeenCalled());
  });
});
