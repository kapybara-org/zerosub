import type { PluginClientContext, PluginHostProps } from "@getpaseo/plugin/client";
import type { ComponentType, ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountView, StateView } from "../shared/model";
import type { ZeroSubStore } from "./store";

// The component is called as a plain function: every hook it uses is one of these stand-ins, and
// state stays at its first value (the list closed).
const host = vi.hoisted(() => ({
  composer: { context: "draft", agent: { provider: "claude", model: null } } as { context: string; agent: { provider: string | null; model: string | null } },
  state: null as unknown,
  toast: { show: vi.fn(), error: vi.fn() },
  withComposerApi: true,
  withModal: true,
  width: 1200,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => [typeof initial === "function" ? (initial as () => unknown)() : initial, () => undefined],
    useEffect: () => undefined,
    useRef: (current: unknown) => ({ current }),
  };
});
vi.mock("react-native", () => ({
  Animated: { Value: class {}, View: "Animated.View", timing: () => ({ start() {}, stop() {} }) },
  Easing: { out: () => 0, cubic: 0 },
  Modal: "Modal",
  Platform: { OS: "web" },
  Pressable: "Pressable",
  StyleSheet: { absoluteFill: {}, hairlineWidth: 1 },
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: host.width, height: 800 }),
}));
vi.mock("@getpaseo/plugin/client", () => ({
  get useComposer() {
    return host.withComposerApi ? () => host.composer : undefined;
  },
}));
const Sheet = Object.assign(function Sheet() {
  return null;
}, {
  Content: function SheetContent() {
    return null;
  },
});
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  Icon: function Icon() {
    return null;
  },
  Select: function Select() {
    return null;
  },
  get Modal() {
    return host.withModal ? Sheet : undefined;
  },
  useToast: () => host.toast,
}));
vi.mock("./agent-accounts", () => ({
  ActionRow: () => null,
  FADE: {},
  isDark: () => false,
  PEEK_DWELL_MS: 380,
  PEEK_WARM_MS: 500,
  PeekCard: () => null,
  SIZE: { regular: { row: 32 }, compact: { row: 44 } },
  useNow: () => Date.parse("2026-11-14T12:00:00Z"),
  useReducedMotion: () => false,
  withAlpha: (color: string) => color,
}));
vi.mock("./store", () => ({ useStore: () => ({ state: host.state, error: null }), VISIBLE_POLL_MS: 15_000 }));

const { contributeComposerAccount } = await import("./composer-account");
const { MANAGE_ACCOUNTS } = await import("./agent-account");

function account(id: string, isDefault = false): AccountView {
  return {
    id,
    family: "claude",
    label: id,
    kind: "managed",
    email: null,
    plan: null,
    organization: null,
    status: "ready",
    isDefault,
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
  };
}

const theme = { colors: { statusDanger: "#9d433b", statusWarning: "#7b5d39" } } as unknown as PluginHostProps["theme"];

type Element = ReactElement<Record<string, unknown> & { children?: unknown }>;

function setUp(withItems = true) {
  const registered: { id: string; Component: ComponentType<PluginHostProps> }[] = [];
  const client = {
    openSurface: vi.fn(),
    ...(withItems
      ? {
          addComposerItem: (contribution: { id: string; Component: ComponentType<PluginHostProps> }) => {
            registered.push(contribution);
            return () => undefined;
          },
        }
      : {}),
  };
  const store = { rpc: vi.fn(async () => ({ reopened: [], deferred: [], failed: [], pending: [], continuedIn: null })), watch: vi.fn(), refresh: vi.fn(async () => undefined) };
  contributeComposerAccount(client as unknown as PluginClientContext, store as unknown as ZeroSubStore);
  const render = (compact = false) => {
    const Component = registered[0]!.Component as unknown as (props: PluginHostProps) => Element | null;
    return Component({ theme, layout: { compact, platform: "web" } } as PluginHostProps);
  };
  return { registered, client, store, render };
}

/** The pieces of what the item renders: a fragment of the trigger and its list. */
function parts(element: Element | null): Element[] {
  const children = (element?.props.children ?? []) as unknown[];
  return children.filter(Boolean) as Element[];
}

/** The list inside the phone's sheet. */
function sheetList(element: Element | null): Element {
  const sheet = parts(element)[1]!;
  const content = sheet.props.children as Element;
  return content.props.children as Element;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  host.composer = { context: "draft", agent: { provider: "claude", model: null } };
  host.state = { accounts: [account("main", true), account("side")], agents: [], logins: [], providers: { claude: "claude" }, showComposerPill: true } as unknown as StateView;
  host.toast.show.mockClear();
  host.toast.error.mockClear();
  host.withComposerApi = true;
  host.withModal = true;
});

describe("the starting account in the composer", () => {
  it("shows the default account as a pill among Paseo's toolbar pickers, its list closed", () => {
    const { registered, render } = setUp();
    expect(registered.map((item) => item.id)).toEqual(["starting-account"]);
    const [pill, ...rest] = parts(render());
    expect((pill!.type as { name: string }).name).toBe("ToolbarPill");
    expect(pill!.props).toMatchObject({ open: false, row: { id: "main", label: "main", current: true } });
    expect(rest).toEqual([]);
  });

  it("is a row of the composer sheet on a phone, which opens the accounts in a sheet with a tick on the default", () => {
    const element = setUp().render(true);
    const [row, sheet] = parts(element);
    expect((row!.type as { name: string }).name).toBe("SheetRow");
    expect(sheet!.type).toBe(Sheet);
    expect(sheet!.props).toMatchObject({ title: "New agents start on", open: false });
    const list = sheetList(element);
    expect((list.props.rows as { id: string; current: boolean }[]).map((row) => [row.id, row.current])).toEqual([
      ["main", true],
      ["side", false],
    ]);
  });

  it("follows a one-time pick for the next agent, and a pick here replaces it", async () => {
    host.state = {
      ...(host.state as StateView),
      accounts: [account("main", true), { ...account("side"), nextAgentUntil: new Date(Date.now() + 60_000).toISOString() }, account("spare")],
    } as StateView;
    const [pill] = parts(setUp().render());
    expect(pill!.props).toMatchObject({ title: "Next new agent starts on", row: { id: "side", current: true } });

    // Back to the default: the one-time pick goes, and the default stays as it was.
    const { store, render } = setUp();
    (sheetList(render(true)).props.onPick as (id: string) => void)("main");
    await flush();
    expect(store.rpc).toHaveBeenCalledWith(expect.objectContaining({ name: "zerosub.accounts.next_agent" }), { accountId: "side", enabled: false });
    expect(store.rpc).not.toHaveBeenCalledWith(expect.objectContaining({ name: "zerosub.accounts.default" }), expect.anything());
    expect(host.toast.show).toHaveBeenCalledWith("New agents start on main again", { variant: "success" });

    // Another account: the one-time pick goes, and that account becomes the default.
    const other = setUp();
    (sheetList(other.render(true)).props.onPick as (id: string) => void)("spare");
    await flush();
    expect(other.store.rpc).toHaveBeenCalledWith(expect.objectContaining({ name: "zerosub.accounts.next_agent" }), { accountId: "side", enabled: false });
    expect(other.store.rpc).toHaveBeenCalledWith(expect.objectContaining({ name: "zerosub.accounts.default" }), { accountId: "spare" });
  });

  it("makes the picked account the default, and says so", async () => {
    const { store, render } = setUp();
    (sheetList(render(true)).props.onPick as (id: string) => void)("side");
    await flush();
    expect(store.rpc).toHaveBeenCalledWith(expect.objectContaining({ name: "zerosub.accounts.default" }), { accountId: "side" });
    expect(host.toast.show).toHaveBeenCalledWith("side is now the default", { variant: "success" });
  });

  it("says why when the daemon refuses the pick", async () => {
    const { store, render } = setUp();
    store.rpc.mockRejectedValueOnce(new Error("Account is signed out"));
    (sheetList(render(true)).props.onPick as (id: string) => void)("side");
    await flush();
    expect(host.toast.error).toHaveBeenCalledWith("Account is signed out");
  });

  it("does nothing for the current account, and Manage accounts opens the Accounts screen", async () => {
    const { store, client, render } = setUp();
    const list = sheetList(render(true));
    (list.props.onPick as (id: string) => void)("main");
    (list.props.onManage as () => void)();
    await flush();
    expect(store.rpc).not.toHaveBeenCalled();
    expect(client.openSurface).toHaveBeenCalledWith("accounts");
  });

  it("figures for the model picked beside it", () => {
    host.composer = { context: "draft", agent: { provider: "claude", model: "claude-fable-5-2" } };
    expect(sheetList(setUp().render(true)).props.model).toBe("Fable 5.2");
    host.composer = { context: "draft", agent: { provider: "claude", model: "default" } };
    expect(sheetList(setUp().render(true)).props.model).toBeNull();
  });

  it("stays out of a running agent's composer, which has its account pill", () => {
    host.composer = { context: "agent", agent: { provider: "claude", model: null } };
    expect(setUp().render()).toBeNull();
  });

  it("shows on the New workspace screen too, for the provider picked there", () => {
    host.composer = { context: "new-workspace", agent: { provider: "codex", model: null } };
    expect(setUp().render()).toBeNull();
    host.composer = { context: "new-workspace", agent: { provider: "claude", model: null } };
    expect(setUp().render()).not.toBeNull();
  });

  it("keeps Paseo's own picker on a phone when the host has no modal", async () => {
    host.withModal = false;
    const { store, client, render } = setUp();
    const element = render(true)!;
    expect((element.type as { name: string }).name).toBe("Select");
    expect(element.props).toMatchObject({ title: "New agents start on", value: "main" });
    const { options, onValueChange } = element.props as { options: { value: string }[]; onValueChange(event: { value: string }): Promise<void> };
    expect(options.map((option) => option.value)).toEqual(["main", "side", MANAGE_ACCOUNTS]);
    await onValueChange({ value: "side" });
    await onValueChange({ value: MANAGE_ACCOUNTS });
    expect(store.rpc).toHaveBeenCalledWith(expect.objectContaining({ name: "zerosub.accounts.default" }), { accountId: "side" });
    expect(client.openSurface).toHaveBeenCalledWith("accounts");
  });

  it("registers nothing on a Paseo without composer items", () => {
    expect(setUp(false).registered).toEqual([]);
    host.withComposerApi = false;
    expect(setUp().registered).toEqual([]);
  });
});
