import type { PluginButton, PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountView, StateView } from "../shared/model";
import { setAgentAccount } from "../shared/rpc";
import type { MenuEntry } from "./account-menu";
import { contributePills } from "./pills";
import { resetPopover } from "./reset-confirm";
import type { StoreSnapshot, ZeroSubStore } from "./store";

// The menu and the confirmations are React Native views; the pill logic only hands them what they
// need. The menu, mocked, keeps what it reads its entries with, so they can be read as it would.
vi.mock("./account-menu", () => ({
  accountMenu: (_store: unknown, entriesOf: (state: StateView) => readonly MenuEntry[]) => Object.assign(() => null, { entriesOf }),
}));
vi.mock("./reset-confirm", () => ({ resetPopover: vi.fn(() => () => null) }));
vi.mock("./fork-confirm", () => ({ forkPopover: vi.fn(() => () => null) }));

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
    proxy: null,
    proxyEditable: false,
    inheritedProxy: null,
    proxyBlocked: null,
    proxyFile: null,
    proxyFollowers: [],
    launcher: null,
    egress: null,
    moving: null,
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
    autoSwitch: false,
    autoContinue: true,
    warnings: [],
    ...overrides,
  };
}

/** The pill contributor over a store and a Paseo client that only do what it uses. */
async function harness(initial: StateView, provider = "claude") {
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
  const stop = contributePills(client as unknown as PluginClientContext, store);
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
    expect(pill.registration.update).toHaveBeenLastCalledWith({ label: "5h 24%", title: "Account: work\n5h 24%", icon: "CircleUserRound" });
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
    // The pill has room for the usage only; its tooltip has the account, then a line a window.
    expect(pill.face()).toMatchObject({
      label: "5h 4% · 7d 24%",
      title: "Account: work\n5h 4% · resets in 2h40m (18:00)\n7d 24% · resets in 1d17h (Fri 09:00)\nIP: 203.0.113.7 (US)",
    });
    // The countdowns keep up as time goes by.
    vi.setSystemTime(new Date(2026, 9, 28, 15, 21));
    pill.publish(view([work, home, busy, away]));
    expect(pill.face().title).toMatch(/^Account: work\n5h 4% · resets in 2h39m \(18:00\)\n/);
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
      title: "Account: work, moving to home when its current turn ends\nIP: 203.0.113.7 (US)",
    });
  });

  it("says a move asked for from the menu is under way until its answer is in", async () => {
    const state = view([account("work", { isDefault: true }), account("home")]);
    const pill = await harness(state);
    let answer!: (summary: unknown) => void;
    vi.mocked(pill.store.rpc).mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    const pressed = press(pill.items(), "account-1");
    expect(pill.store.rpc).toHaveBeenCalledWith(setAgentAccount, { agentId: AGENT, accountId: "home" });
    expect(pill.face()).toMatchObject({ label: "work → home", title: "Moving to home…" });
    const moved = view([account("work", { isDefault: true }), account("home")]);
    moved.agents = [{ ...moved.agents[0]!, accountId: "home", pinned: true }];
    pill.publish(moved);
    answer({ continuedIn: null, reopened: [], pending: [], deferred: [], failed: [] });
    await pressed;
    await vi.advanceTimersByTimeAsync(0);
    expect(pill.face()).toMatchObject({ label: "home", title: "Account: home" });
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
    expect(patch).toEqual({ label: "home", title: "Account: home", icon: "CircleUserRound" });
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
    expect(pill.face().title).toBe("Account: chatgpt");
  });

  it("offers to continue on the other provider when only an API account of this one is ready", async () => {
    // The server counts this provider as out (it never moves work onto an API account) and says so.
    const work = account("work", { isDefault: true, status: "limited" });
    const api = account("api", { auth: "api" });
    const chatgpt = account("chatgpt", { family: "codex" });
    const pill = await harness(view([work, api, chatgpt]));
    expect(pill.items().map((item) => item.id)).toContain("fork-other");
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
