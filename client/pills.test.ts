import type { PluginButton, PluginButtonMenuEntry, PluginClientContext } from "@getpaseo/plugin/client";
import { describe, expect, it, vi } from "vitest";
import type { AccountView, AgentRoute, StateView, UsageWindow } from "../shared/model";
import { contributePills } from "./pills";
import type { ZeroSubStore } from "./store";

// The popovers are React Native views, which don't load here. The menu only links to them.
vi.mock("./fork-confirm", () => ({ forkPopover: () => () => null }));
vi.mock("./reset-confirm", () => ({ resetPopover: () => () => null }));
vi.mock("./usage-card", () => ({ usageCard: () => function UsageCard() { return null; } }));
vi.mock("./agent-accounts", () => ({ agentAccounts: () => function AgentAccounts() { return null; } }));

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
  };
}

/** The account button for one ChatGPT agent, routed as `route` says. */
async function accountButton(route: Partial<AgentRoute>, accounts?: AccountView[]): Promise<PluginButton> {
  return (await composerPills(route, accounts))[0]!;
}

/** Every pill one ChatGPT agent gets, routed as `route` says: the account button first. */
async function composerPills(
  route: Partial<AgentRoute>,
  accounts: AccountView[] = [account("work", true), account("home", false)],
): Promise<PluginButton[]> {
  const state: StateView = {
    accounts,
    agents: [{ agentId: "agent-1", family: "codex", accountId: "work", pinned: true, pendingAccountId: null, waiting: null, movable: false, ...route }],
    logins: [],
    providers: { codex: "codex" },
    canReopen: true,
    browserSignIn: true,
    piLaunchers: null,
    piHomes: null,
    showComposerPill: true,
    autoSwitch: true,
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
  // The account pill comes first, beside a usage pill when the current account has a reading.
  await vi.waitFor(() => expect(buttons.length).toBeGreaterThan(0));
  stop();
  return buttons;
}

/** The account button's menu, for an agent that can't move in place (a Codex thread with history). */
async function menu(route: Partial<AgentRoute>, accounts?: AccountView[]): Promise<readonly PluginButtonMenuEntry[]> {
  const behavior = (await accountButton(route, accounts)).behavior;
  return behavior.kind === "menu" ? behavior.items : [];
}

const usage = (windows: UsageWindow[]): AccountView["usage"] => ({
  fetchedAt: new Date().toISOString(),
  windows,
  error: null,
  cached: false,
  resets: null,
  credits: null,
});

describe("the account button", () => {
  it("opens the agent's own accounts panel when it can move in place", async () => {
    const button = await accountButton({ movable: true });
    expect(button).toMatchObject({ title: "Accounts for this agent: work", label: "work", behavior: { kind: "popover" } });
  });

  it("names the account the session runs on first while a switch waits", async () => {
    // Routed to "home" from the next session; the open one still runs on "work".
    const route = { accountId: "home", pendingAccountId: "work", waiting: "turn" as const };
    expect(await accountButton({ ...route, movable: true })).toMatchObject({
      title: "Accounts for this agent: work, moving to home when its current turn ends",
      label: "work → home",
      icon: "CircleUserRound",
    });
    expect(await accountButton({ ...route, movable: false })).toMatchObject({
      title: "Account: work, moving to home when its current turn ends",
      label: "work → home",
    });
  });

  it("shows the usage of the account the session runs on, not the one it will switch to", async () => {
    const work = { ...account("work", true), usage: usage([{ id: "secondary", label: "Weekly", usedPercent: 26, resetsAt: later(72), minutes: 10_080 }]) };
    const home = { ...account("home", false), usage: usage([{ id: "secondary", label: "Weekly", usedPercent: 55, resetsAt: later(48), minutes: 10_080 }]) };
    const shown = await composerPills({ movable: true, accountId: "home", pendingAccountId: "work" }, [work, home]);
    expect(shown.map((button) => button.label)).toEqual(["work → home", "26%"]);
  });

  it("says an agent waits when every account checked for it is full", async () => {
    const button = await accountButton({ movable: true, atWall: true });
    expect(button).toMatchObject({ label: "work · waiting", icon: "CircleAlert" });
  });

  it("never puts an account's e-mail in the button", async () => {
    const work: AccountView = { ...account("work", true), email: "someone@example.test" };
    for (const movable of [true, false]) {
      const button = await accountButton({ movable }, [work, account("home", false)]);
      expect(JSON.stringify([button.title, button.label])).not.toContain("@");
    }
  });

  it("weighs each account by the room it has left, with its limit's glyph", async () => {
    const work = { ...account("work", true), usage: usage([{ id: "primary", label: "5-hour", usedPercent: 12, resetsAt: later(2), minutes: 300 }, { id: "secondary", label: "Weekly", usedPercent: 54, resetsAt: later(72), minutes: 10_080 }]) };
    const home = { ...account("home", false), usage: usage([{ id: "primary", label: "5-hour", usedPercent: 95, resetsAt: later(2), minutes: 300 }]) };
    const away: AccountView = { ...account("away", false), status: "limited", limitedUntil: later(1.5) };
    const out: AccountView = { ...account("out", false), status: "signed_out" };
    const items = (await menu({ movable: false }, [work, home, away, out])).filter((entry) => entry.kind === "item" && entry.id.startsWith("account-"));
    expect(items.map((entry) => (entry.kind === "item" ? entry.title : ""))).toEqual([
      "work · 46% left · week",
      "Continue on home · 5% left · 5h",
      "Continue on away · full, back in 1h 30m",
      "Continue on out · signed out",
    ]);
    const icons = items.map((entry) => (entry.kind === "item" && typeof entry.icon === "function" ? (entry.icon as { displayName?: string }).displayName : entry.kind === "item" ? entry.icon : null));
    expect(icons).toEqual(["Glyph(weekly,54,calm)", "ArrowRightLeft", "ArrowRightLeft", "ArrowRightLeft"]);
  });

  it("says when an agent started on its account because the weekly reset was near", async () => {
    expect(await menu({ selectionReason: "weekly_reset" })).toContainEqual(
      expect.objectContaining({ id: "selection-reason", title: "Started here: weekly reset was near", disabled: true }),
    );
  });

  it("has no reason row for an agent placed any other way", async () => {
    expect((await menu({})).map((entry) => entry.id)).not.toContain("selection-reason");
  });
});

/** The pills one Claude agent gets, keyed by id, from an account with `windows`. */
async function pills(
  windows: { id: string; label: string; usedPercent: number; resetsAt: string | null }[],
  agentFields: Record<string, unknown> = {},
  stateFields: Partial<StateView> = {},
): Promise<Map<string, PluginButton>> {
  const fetchedAt = new Date().toISOString();
  const claude: AccountView = { ...account("main", true), family: "claude", usage: { fetchedAt, windows, error: null, cached: false, resets: null, credits: null } };
  const state: StateView = {
    accounts: [claude],
    agents: [],
    logins: [],
    providers: { claude: "claude" },
    canReopen: true,
    browserSignIn: true,
    showComposerPill: true,
    autoSwitch: true,
    piLaunchers: null,
    piHomes: null,
    warnings: [],
    ...stateFields,
  };
  const registered = new Map<string, PluginButton>();
  const agent = { id: "agent-1", workspaceId: "workspace-1", provider: "claude", ...agentFields };
  const client = {
    addComposerPill: ({ id, button }: { id: string; button: PluginButton }) => {
      registered.set(id, button);
      return { update: (next: PluginButton) => registered.set(id, next), remove: () => registered.delete(id) };
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
  await new Promise((resolve) => setTimeout(resolve, 0));
  const shown = new Map(registered);
  stop();
  return shown;
}

const later = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

describe("the usage pill", () => {
  it("shows the busiest window, even with a single account", async () => {
    const shown = await pills([
      { id: "five_hour", label: "5-hour", usedPercent: 42, resetsAt: later(2) },
      { id: "seven_day", label: "Weekly", usedPercent: 61, resetsAt: later(72) },
    ]);
    expect([...shown.keys()]).toEqual(["usage"]);
    expect(shown.get("usage")).toMatchObject({ label: "61%", behavior: { kind: "popover" } });
    expect(shown.get("usage")!.title).toMatch(/^Weekly limit · resets [A-Z][a-z]{2} \d\d:\d\d$/);
    expect((shown.get("usage")!.icon as { displayName?: string }).displayName).toBe("Glyph(weekly,61,calm)");
  });

  it("adds a second pill while the 5-hour window is nearly spent", async () => {
    const shown = await pills([
      { id: "five_hour", label: "5-hour", usedPercent: 92, resetsAt: later(1) },
      { id: "seven_day", label: "Weekly", usedPercent: 40, resetsAt: later(72) },
    ]);
    expect([...shown.entries()].map(([id, button]) => [id, button.label])).toEqual([
      ["usage", "92%"],
      ["usage-next", "40%"],
    ]);
    // The figures alone; each pill's glyph tells the windows apart.
    expect([...shown.values()].map((button) => (button.icon as { displayName?: string }).displayName?.split(",")[0])).toEqual(["Glyph(session", "Glyph(weekly"]);
  });

  it("reads the model an agent runs from what the provider resolved", async () => {
    const windows = [
      { id: "five_hour", label: "5-hour", usedPercent: 20, resetsAt: later(2) },
      { id: "weekly_fable", label: "Weekly · Fable", usedPercent: 100, resetsAt: later(72) },
    ];
    expect((await pills(windows, { model: null, runtimeInfo: { model: "claude-fable-5-2" } })).get("usage")?.label).toBe("3d");
    expect((await pills(windows, { model: "claude-opus-5-5" })).get("usage")?.label).toBe("20%");
  });

  it("follows the setting that hides ZeroSub's pills", async () => {
    const shown = await pills([{ id: "five_hour", label: "5-hour", usedPercent: 42, resetsAt: later(2) }], {}, { showComposerPill: false });
    expect(shown.size).toBe(0);
  });
});
