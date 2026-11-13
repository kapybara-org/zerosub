import type { ReactElement, ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountView, StateView } from "../shared/model";
import { DEFAULT_CONTINUE_PROMPT, preferences, type Preferences } from "../shared/preferences";
import { accountMenu, type MenuEntry } from "./account-menu";
import { AccountsSurface } from "./accounts-surface";
import { PreferencesScreen } from "./settings-screen";
import type { StoreSnapshot, ZeroSubStore } from "./store";

// There's no React Native renderer here: a screen is called as the function it is, with React's
// hooks kept per mounted screen, and what it returns is searched for the views it hands Paseo.
const hooks = vi.hoisted(() => {
  let cells: unknown[] = [];
  let index = 0;
  return {
    run<T>(own: unknown[], render: () => T): T {
      const outer = { cells, index };
      cells = own;
      index = 0;
      try {
        return render();
      } finally {
        ({ cells, index } = outer);
      }
    },
    useState(initial: unknown) {
      const at = index++;
      const own = cells;
      if (!(at in own)) own[at] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      const set = (next: unknown) => {
        own[at] = typeof next === "function" ? (next as (value: unknown) => unknown)(own[at]) : next;
      };
      return [own[at], set];
    },
  };
});

const paseo = vi.hoisted(() => ({
  settings: null as unknown,
  toast: { show: (() => undefined) as (...args: unknown[]) => void, error: (() => undefined) as (...args: unknown[]) => void },
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: hooks.useState,
  useCallback: (callback: unknown) => callback,
  useMemo: (make: () => unknown) => make(),
  useEffect: () => undefined,
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("react-native", () => ({ ScrollView: "ScrollView", Text: "Text", View: "View", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator" }));
vi.mock("@getpaseo/plugin/client", () => ({ useHosts: () => [{ serverId: "host", status: "online" }], useSettings: () => paseo.settings }));
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsAction: "SettingsAction",
  SettingsCard: "SettingsCard",
  SettingsInput: "SettingsInput",
  SettingsSection: "SettingsSection",
  SettingsSwitch: "SettingsSwitch",
}));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  copyText: () => undefined,
  Icon: "Icon",
  Modal: Object.assign(() => null, { Content: "ModalContent" }),
  TextInput: "TextInput",
  useToast: () => paseo.toast,
}));
vi.mock("./ui", () => ({
  Badge: "Badge",
  Button: "Button",
  Card: "Card",
  IconButton: "IconButton",
  UsageBar: "UsageBar",
  useText: () => new Proxy({}, { get: () => ({}) }),
}));
vi.mock("./add-account", () => ({ AddAccountModal: "AddAccountModal" }));
vi.mock("./api-account", () => ({ ApiAccountModal: "ApiAccountModal" }));
vi.mock("./reset-confirm", () => ({ ResetConfirm: "ResetConfirm", redeemToast: () => undefined, resetBadge: () => "" }));

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

/** A screen that keeps its state between renders, as a mounted one does. */
function mount<Props>(component: (props: Props) => ReactNode, props: Props): () => Element {
  const cells: unknown[] = [];
  return () => hooks.run(cells, () => component(props)) as Element;
}

function* elements(node: ReactNode): Generator<Element> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
  } else if (node && typeof node === "object" && "props" in node) {
    yield node as Element;
    yield* elements((node as Element).props.children);
  }
}

function find(tree: ReactNode, match: (element: Element) => boolean): Element {
  const found = [...elements(tree)].find(match);
  if (!found) throw new Error("no such element");
  return found;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  return node && typeof node === "object" && "props" in node ? textOf((node as Element).props.children) : "";
}

const named = (type: string, label?: string) => (element: Element) =>
  element.type === type && (label === undefined || element.props.label === label);

const theme = { colors: new Proxy({}, { get: () => "#000" }) };

beforeEach(() => {
  paseo.toast = { show: vi.fn(), error: vi.fn() };
});

describe("the preferences screen", () => {
  function setUp(continuePrompt: string) {
    const settings = {
      status: "ready",
      error: null as string | null,
      values: preferences.schema.parse({ autoContinue: true, continuePrompt }),
      revision: "1",
      saving: false,
      saveError: null as string | null,
      save: vi.fn(async (values: Preferences) => {
        settings.values = values;
        return true;
      }),
      reset: vi.fn(async () => false),
    };
    paseo.settings = settings;
    const draw = mount(PreferencesScreen, { theme, host: { label: "This Mac" }, onOpenAccounts: () => undefined } as never);
    // The box is uncontrolled, as Paseo's is: it shows the text it was mounted with, then what's typed.
    // A new key from one render to the next makes a new box, even a key it had before, and so does a
    // render without the box.
    let mounted: { key: unknown; text: string } | null = null;
    const render = () => {
      const tree = draw();
      const input = [...elements(tree)].find(named("SettingsInput"));
      if (!input) mounted = null;
      else if (!mounted || mounted.key !== input.key) mounted = { key: input.key, text: String(input.props.initialValue ?? "") };
      return tree;
    };
    /** The box in `tree`, which has to be the latest render. */
    const box = (tree: Element) => {
      const input = find(tree, named("SettingsInput"));
      const shown = mounted!;
      return { input, text: shown.text, type: (text: string) => ((shown.text = text), (input.props.onChangeText as (text: string) => void)(text)) };
    };
    const press = (tree: Element, label: string) => (find(tree, named("SettingsAction", label)).props.onPress as () => void)();
    const saveDisabled = (tree: Element) => find(tree, named("SettingsAction", "Save the follow-up message")).props.disabled;
    return { settings, render, box, press, saveDisabled };
  }

  it("shows the default follow-up once it's restored, with nothing left to save", async () => {
    const { settings, render, box, press, saveDisabled } = setUp("Keep at it.");
    expect(box(render()).text).toBe("Keep at it.");
    box(render()).type("Something else");
    expect(saveDisabled(render())).toBe(false);

    press(render(), "Restore the default follow-up");
    await vi.waitFor(() => expect(settings.values.continuePrompt).toBe(DEFAULT_CONTINUE_PROMPT));
    expect(box(render()).text).toBe(DEFAULT_CONTINUE_PROMPT);
    expect(saveDisabled(render())).toBe(true);
  });

  it("keeps nothing typed before a save once the default is restored", async () => {
    const { settings, render, box, press, saveDisabled } = setUp(DEFAULT_CONTINUE_PROMPT);
    box(render()).type("Mine");
    press(render(), "Save the follow-up message");
    await vi.waitFor(() => expect(settings.values.continuePrompt).toBe("Mine"));
    expect(box(render()).text).toBe("Mine");
    expect(saveDisabled(render())).toBe(true);

    press(render(), "Restore the default follow-up");
    await vi.waitFor(() => expect(settings.values.continuePrompt).toBe(DEFAULT_CONTINUE_PROMPT));
    expect(box(render()).text).toBe(DEFAULT_CONTINUE_PROMPT);
    expect(saveDisabled(render())).toBe(true);
  });

  it("keeps nothing typed while the settings couldn't be shown", () => {
    const { settings, render, box, saveDisabled } = setUp("Keep at it.");
    box(render()).type("Mine");
    expect(saveDisabled(render())).toBe(false);

    // A refresh fails, and the next one works: the box is made again, with the saved message in it.
    Object.assign(settings, { status: "error", error: "Plugin is not available" });
    expect(textOf(render())).toContain("Plugin is not available");
    Object.assign(settings, { status: "ready", error: null });
    expect(box(render()).text).toBe("Keep at it.");
    expect(saveDisabled(render())).toBe(true);
  });

  it("says why restoring the defaults of damaged settings failed", () => {
    const { settings, render, press } = setUp("Keep at it.");
    Object.assign(settings, { status: "invalid", error: "The saved settings aren't valid." });
    press(render(), "Restore defaults");
    expect(settings.reset).toHaveBeenCalled();
    settings.saveError = "The settings changed elsewhere.";
    expect(textOf(render())).toContain("The settings changed elsewhere.");
  });

  it("shows why a save failed beside what was saved", () => {
    const { settings, render, box, press } = setUp("Keep at it.");
    const toggle = find(render(), named("SettingsSwitch", "Switch accounts when one hits its limit"));
    (toggle.props.onValueChange as (value: boolean) => void)(true);
    settings.saveError = "The settings changed elsewhere.";
    expect(box(render()).input.props.error ?? null).toBeNull();
    expect(textOf(render())).toContain("The settings changed elsewhere.");

    box(render()).type("Go on.");
    press(render(), "Save the follow-up message");
    expect(box(render()).input.props.error).toBe("The settings changed elsewhere.");
  });
});

describe("the accounts screen", () => {
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

  function setUp(overrides: Partial<StateView> = {}) {
    const state: StateView = {
      accounts: [account("work", { isDefault: true }), account("home")],
      agents: [],
      logins: [],
      providers: { claude: "claude" },
      canReopen: true,
      browserSignIn: true,
      launchers: null,
      claudeHomes: null,
      piLaunchers: null,
      piHomes: null,
      showComposerPill: true,
      autoSwitch: true,
      autoContinue: true,
      warnings: [],
      ...overrides,
    };
    const snapshot: StoreSnapshot = { state, error: null, updatedAt: 0 };
    const store = {
      subscribe: () => () => undefined,
      getSnapshot: () => snapshot,
      watch: () => () => undefined,
      refresh: vi.fn(async () => undefined),
      rpc: vi.fn(),
    };
    paseo.settings = { status: "ready", values: preferences.schema.parse({}), revision: "1", saving: false, saveError: null, save: vi.fn() };
    const surface = mount(AccountsSurface, { theme, layout: { compact: false }, host: { id: "host", label: "This Mac" }, store } as never);
    /** The card of the account called `label`, mounted on its own. */
    const card = (label: string) => {
      const section = find(surface(), (element) => typeof element.type === "function" && element.type.name === "FamilySection");
      const tree = mount(section.type as (props: unknown) => ReactNode, section.props)();
      const entry = find(tree, (element) => typeof element.type === "function" && (element.props.account as AccountView | undefined)?.label === label);
      return mount(entry.type as (props: unknown) => ReactNode, entry.props);
    };
    return { surface, card, store: store as typeof store & ZeroSubStore };
  }

  it("says agents wait at a switch when they don't keep going by themselves", () => {
    const intro = (tree: Element) => textOf(find(tree, (element) => element.type === "Text" && textOf(element).startsWith("Keep several")));
    expect(intro(setUp().surface())).toContain("agents move to another and keep going.");
    expect(intro(setUp({ autoContinue: false }).surface())).toContain("agents move to another and wait for you there.");
    expect(intro(setUp({ autoSwitch: false }).surface())).toContain("turn on automatic switching below.");
  });

  it("says above Pi's accounts what a proxy on them reaches, and only there", () => {
    const sections = (tree: Element) => {
      const found: Element[] = [];
      const walk = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(walk);
        const element = node as Element;
        if (typeof element.type === "function" && element.type.name === "FamilySection") found.push(element);
        walk(element.props?.children);
      };
      walk(tree);
      return found.map((section) => ({ family: section.props.family, tree: mount(section.type as (props: unknown) => ReactNode, section.props)() }));
    };
    const noted = (tree: Element) => {
      try {
        find(tree, (element) => typeof element.type === "function" && element.type.name === "PiSectionNotes");
        return true;
      } catch {
        return false;
      }
    };
    const withPi = sections(setUp({ accounts: [account("work", { isDefault: true }), account("Pi (CLI login)", { family: "pi", kind: "main" })] }).surface());
    expect(withPi.map((section) => [section.family, noted(section.tree)])).toEqual([
      ["claude", false],
      ["codex", false],
      ["pi", true],
    ]);
    // The notes are upstream's own (client/pi-accounts.tsx), with its note about proxies among them.
    const notes = find(withPi[2]!.tree, (element) => typeof element.type === "function" && element.type.name === "PiSectionNotes");
    const note = find(mount(notes.type as (props: unknown) => ReactNode, notes.props)(), (element) => typeof element.type === "function" && element.type.name === "PiProxyNote");
    const text = textOf(mount(note.type as (props: unknown) => ReactNode, note.props)());
    expect(text).toContain("Agents already running keep the network they started with");
    expect(text).toContain("It's also written as httpProxy in Pi's settings");
    // Without a Pi account there's no Pi section at all.
    expect(sections(setUp().surface()).map((section) => section.family)).toEqual(["claude", "codex"]);
  });

  describe("proxy box", () => {
    /** The proxy box of the account called `home`, opened from its card. */
    function open(proxy: string | null, overrides: Partial<AccountView> = {}) {
      const { card } = setUp({ accounts: [account("work", { isDefault: true }), account("home", { proxy, proxyEditable: true, ...overrides })] });
      const render = card("home");
      (find(render(), (element) => element.type === "IconButton" && element.props.label === "Proxy").props.onPress as () => void)();
      const modal = find(render(), (element) => typeof element.type === "function" && element.type.name === "ProxyModal");
      const draw = mount(modal.type as (props: unknown) => ReactNode, modal.props);
      const input = (tree: Element) => find(tree, named("TextInput"));
      const saveDisabled = (tree: Element) => find(tree, (element) => element.type === "Button" && element.props.label === "Save").props.disabled;
      const type = (text: string) => (input(draw()).props.onChangeText as (text: string) => void)(text);
      return { draw, input, saveDisabled, type };
    }

    it("opens with the account's proxy in it, saved once it's changed", () => {
      const { draw, input, saveDisabled, type } = open("http://127.0.0.1:2020");
      expect(input(draw()).props.value).toBe("http://127.0.0.1:2020");
      expect(saveDisabled(draw())).toBe(true);
      type("http://127.0.0.1:7890");
      expect(saveDisabled(draw())).toBe(false);
    });

    it("shows a proxy's password hidden, and saves a change only with it typed again", () => {
      const { draw, input, saveDisabled, type } = open("http://me:•••@proxy.example:8080");
      expect(input(draw()).props.value).toBe("http://me:•••@proxy.example:8080");
      type("http://me:•••@proxy.example:8443");
      expect(saveDisabled(draw())).toBe(true);
      expect(textOf(draw())).toContain("type it in full");
      type("http://me:secret@proxy.example:8443");
      expect(saveDisabled(draw())).toBe(false);
    });

    it("says which proxy an account without its own goes through, and where that's set", () => {
      const inheritedProxy = { proxy: "http://127.0.0.1:1133", from: "~/.claude/settings.json" };
      expect(textOf(open(null, { inheritedProxy }).draw())).toContain(
        "Now: no proxy of its own; it goes through http://127.0.0.1:1133, set in ~/.claude/settings.json.",
      );
      expect(textOf(open("http://127.0.0.1:7890", { inheritedProxy }).draw())).toContain("Now: http://127.0.0.1:7890.");
      expect(textOf(open(null).draw())).toContain("it uses the network the CLI already has");
      // The empty box keeps that proxy, so that's what it shows; an example address would read as one in use.
      const box = open(null, { inheritedProxy });
      expect(box.input(box.draw()).props.placeholder).toBe("http://127.0.0.1:1133");
      const bare = open(null);
      expect(bare.input(bare.draw()).props.placeholder).toBe("http://host:port");
    });

    it("says why the proxy can't be set here, with nothing to type or save", () => {
      const tree = open(null, { kind: "main", proxyBlocked: "~/.claude/settings.json sets HTTPS_PROXY in its env" }).draw();
      expect(textOf(tree)).toContain("~/.claude/settings.json sets HTTPS_PROXY in its env");
      expect(textOf(tree)).not.toContain("Agents started after saving");
      const buttons = [...elements(tree)].filter((element) => element.type === "Button").map((element) => element.props.label);
      expect(buttons).toEqual(["Close"]);
      expect([...elements(tree)].some(named("TextInput"))).toBe(false);
      // One of its own set before can still be taken off.
      const own = open("http://127.0.0.1:7890", { kind: "main", proxyBlocked: "blocked" }).draw();
      expect([...elements(own)].filter((element) => element.type === "Button").map((element) => element.props.label)).toEqual(["Close", "Remove proxy"]);
    });

    it("changes the CLI login's in ~/.claude/settings.json when it's set there, saying what else goes by it", () => {
      const { draw, input, saveDisabled, type } = open("http://127.0.0.1:1133", {
        kind: "main",
        proxyFile: "~/.claude/settings.json",
        proxyFollowers: ["Work", "Personal"],
        inheritedProxy: { proxy: "http://127.0.0.1:2020", from: "the daemon's environment" },
      });
      const shown = textOf(draw());
      expect(shown).toContain("Now: http://127.0.0.1:1133, set in ~/.claude/settings.json.");
      expect(shown).toContain(
        "Saving changes it there, so plain claude in a terminal uses it too, and so do Work, Personal, which have no proxy of their own.",
      );
      expect(shown).toContain("Removing it takes it out of there, and they then go through http://127.0.0.1:2020, set in the daemon's environment.");
      expect(input(draw()).props.value).toBe("http://127.0.0.1:1133");
      const remove = find(draw(), (element) => element.type === "Button" && element.props.label === "Remove proxy");
      expect(remove.props.tooltip).toBe("Take the proxy out of ~/.claude/settings.json");
      type("http://127.0.0.1:7890");
      expect(saveDisabled(draw())).toBe(false);
    });

    it("says what follows a change: for the CLI login, only agents", () => {
      expect(textOf(open(null).draw())).toContain("Agents and terminal sessions started after saving use the new setting");
      const main = textOf(open(null, { kind: "main" }).draw());
      expect(main).toContain("Agents started after saving use the new setting");
      expect(main).toContain("Plain claude in a terminal doesn't");
    });
  });

  describe("where accounts are kept", () => {
    /** The folder box, opened from under the Claude accounts. */
    function open(claudeHomes: StateView["claudeHomes"]) {
      const { surface, store } = setUp({ claudeHomes });
      const section = find(surface(), (element) => typeof element.type === "function" && element.type.name === "FamilySection");
      const tree = mount(section.type as (props: unknown) => ReactNode, section.props)();
      const hint = find(tree, (element) => typeof element.type === "function" && element.type.name === "HomesHint");
      const render = mount(hint.type as (props: unknown) => ReactNode, hint.props);
      (find(render(), (element) => element.type === "IconButton" && element.props.label === "Change where accounts are kept").props.onPress as () => void)();
      const modal = find(render(), (element) => typeof element.type === "function" && element.type.name === "HomesModal");
      const draw = mount(modal.type as (props: unknown) => ReactNode, modal.props);
      const input = (tree: Element) => find(tree, named("TextInput"));
      const saveDisabled = (tree: Element) => find(tree, (element) => element.type === "Button" && element.props.label === "Save").props.disabled;
      const type = (text: string) => (input(draw()).props.onChangeText as (text: string) => void)(text);
      return { hint: render, draw, input, saveDisabled, type, store };
    }

    it("names the folder under the Claude accounts, and only there", () => {
      const { hint } = open({ dir: "~/.claude-config", isDefault: true });
      expect(textOf(hint())).toContain("~/.claude-config");
      // Older servers don't say, and keep accounts in ZeroSub's own folder.
      const section = find(setUp().surface(), (element) => typeof element.type === "function" && element.type.name === "FamilySection");
      const tree = mount(section.type as (props: unknown) => ReactNode, section.props)();
      expect([...elements(tree)].some((element) => typeof element.type === "function" && element.type.name === "HomesHint")).toBe(false);
    });

    it("saves another folder once one is typed, saying the accounts move there", async () => {
      const { draw, input, saveDisabled, type, store } = open({ dir: "~/.claude-config", isDefault: true });
      expect(input(draw()).props.value).toBe("");
      expect(input(draw()).props.placeholder).toBe("~/.claude-config");
      expect(textOf(draw())).toContain("Its Keychain entry moves with it.");
      expect(saveDisabled(draw())).toBe(true);
      type("~/accounts");
      expect(saveDisabled(draw())).toBe(false);
      store.rpc.mockResolvedValue({ ok: true, dir: "~/accounts", moving: 2 });
      await (find(draw(), (element) => element.type === "Button" && element.props.label === "Save").props.onPress as () => Promise<void>)();
      expect(store.rpc).toHaveBeenCalledWith(expect.anything(), { dir: "~/accounts" });
      expect(paseo.toast.show).toHaveBeenCalledWith("Accounts are kept in ~/accounts now · 2 accounts move there once nothing runs on them", expect.anything());
    });

    it("goes back to the default when emptied", () => {
      const { draw, input, saveDisabled, type } = open({ dir: "~/accounts", isDefault: false });
      expect(input(draw()).props.value).toBe("~/accounts");
      expect(saveDisabled(draw())).toBe(true);
      type("");
      expect(saveDisabled(draw())).toBe(false);
    });

    it("says on a card where its folder is moving and what it waits for, or why it couldn't", () => {
      const waiting = { to: "~/.claude-config", waiting: "Claude Code runs on it (an agent or a terminal); it moves once that stops", error: null };
      const failed = { to: "~/.claude-config/claude-home", waiting: null, error: "the Keychain entry is locked" };
      expect(textOf(setUp({ accounts: [account("home", { moving: waiting })] }).card("home")())).toContain(
        "Moving its folder to ~/.claude-config: Claude Code runs on it (an agent or a terminal); it moves once that stops",
      );
      expect(textOf(setUp({ accounts: [account("home", { moving: failed })] }).card("home")())).toContain(
        "Couldn't move its folder to ~/.claude-config/claude-home: the Keychain entry is locked",
      );
    });
  });

  it("refreshes one Claude subscription account's usage from its card", () => {
    const { card, store } = setUp({ accounts: [account("work", { isDefault: true }), account("home"), account("metered", { auth: "api" })] });
    const button = (render: () => Element) =>
      [...elements(render())].find((element) => element.type === "IconButton" && element.props.label === "Refresh usage");
    (button(card("home"))!.props.onPress as () => void)();
    expect(store.refresh).toHaveBeenCalledWith({ refreshUsage: true, accountId: "home" });
    // An API account has no usage to read.
    expect(button(card("metered"))).toBeUndefined();
  });

  it("says a removal Paseo stopped waiting for goes on, rather than that it failed", async () => {
    const { card, store } = setUp();
    store.rpc.mockRejectedValue(new Error("Plugin RPC timed out after 30000ms"));
    const render = card("home");
    const remove = find(render(), (element) => element.type === "Button" && element.props.label === "Remove");
    await (remove.props.onPress as () => Promise<void>)();
    await vi.waitFor(() => expect(paseo.toast.show).toHaveBeenCalled());
    expect(paseo.toast.error).not.toHaveBeenCalled();
    expect(paseo.toast.show).toHaveBeenCalledWith(expect.stringMatching(/^Still removing home/), expect.objectContaining({ variant: "info" }));
  });
});

describe("an agent's account menu", () => {
  const store = {
    getSnapshot: () => ({ state: {} as StateView, error: null, updatedAt: 0 }),
    subscribe: () => () => undefined,
    watch: () => () => undefined,
  } as unknown as ZeroSubStore;

  function setUp(entries: MenuEntry[]) {
    const close = vi.fn();
    const render = mount(accountMenu(store, () => entries) as (props: never) => ReactNode, { theme, close } as never);
    const entry = (label: string) => find(render(), (element) => element.type === "Pressable" && element.props.accessibilityLabel === label);
    return { close, render, entry };
  }

  it("puts an entry's second line under its title", () => {
    const { entry } = setUp([
      { kind: "item", id: "a", title: "sam@example.com (limit reached ↻4h10m)", detail: "5h – · 7d –", icon: "Circle", behavior: { kind: "action", onPress: () => undefined } },
      { kind: "item", id: "b", title: "Manage accounts…", icon: "Users", behavior: { kind: "action", onPress: () => undefined } },
    ]);
    const lines = [...elements(entry("sam@example.com (limit reached ↻4h10m), 5h – · 7d –").props.children)].filter((element) => element.type === "Text");
    expect(lines.map(textOf)).toEqual(["sam@example.com (limit reached ↻4h10m)", "5h – · 7d –"]);
    expect([...elements(entry("Manage accounts…").props.children)].filter((element) => element.type === "Text")).toHaveLength(1);
  });

  it("closes as an action runs, and shows what the action throws", async () => {
    const onPress = vi.fn(async () => {
      throw new Error("Couldn't reload this agent onto home.");
    });
    const { close, entry } = setUp([{ kind: "item", id: "a", title: "home", icon: "Circle", behavior: { kind: "action", onPress } }]);
    (entry("home").props.onPress as () => void)();
    expect(close).toHaveBeenCalled();
    await vi.waitFor(() => expect(paseo.toast.error).toHaveBeenCalledWith("Couldn't reload this agent onto home."));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it("leaves an entry that can't be picked alone", () => {
    const { entry } = setUp([{ kind: "item", id: "a", title: "work", icon: "CircleCheck", disabled: true, behavior: { kind: "action", onPress: () => undefined } }]);
    expect(entry("work").props.disabled).toBe(true);
  });

  it("opens a confirmation in its place, the same one as it re-renders", () => {
    const Confirm = () => null;
    const entries: MenuEntry[] = [{ kind: "item", id: "use-reset", title: "Use a banked reset…", icon: "TimerReset", behavior: { kind: "popover", Content: Confirm } }];
    const { close, render, entry } = setUp(entries);
    (entry("Use a banked reset…").props.onPress as () => void)();
    expect(close).not.toHaveBeenCalled();
    // The menu builds its entries afresh each time; what's open stays what was opened.
    entries[0] = { ...entries[0]!, behavior: { kind: "popover", Content: () => null } } as MenuEntry;
    const shown = render();
    expect(shown.type).toBe(Confirm);
    expect(shown.props).toMatchObject({ close });
  });
});
