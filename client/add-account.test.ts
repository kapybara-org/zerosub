import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AccountView } from "../shared/model";
import { AddAccountModal } from "./add-account";

// As in screens.test.ts: no React Native renderer, so a step is called as the function it is, with
// its hooks kept per mounted step, and what it returns is searched for the views it hands Paseo.
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
    useRef(initial: unknown) {
      const at = index++;
      if (!(at in cells)) cells[at] = { current: initial };
      return cells[at];
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useCallback: (callback: unknown) => callback,
  useMemo: (make: () => unknown) => make(),
  useEffect: () => undefined,
}));
vi.mock("react-native", () => ({ Text: "Text", View: "View", Pressable: "Pressable", ActivityIndicator: "ActivityIndicator" }));
vi.mock("@getpaseo/plugin/client", () => ({ openExternalUrl: async () => undefined }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  copyText: () => undefined,
  Modal: Object.assign(() => null, { Content: "ModalContent" }),
  TextInput: "TextInput",
  useToast: () => ({ show: () => undefined, error: () => undefined }),
}));
vi.mock("./ui", () => ({ Button: "Button", useText: () => new Proxy({}, { get: () => ({}) }) }));
vi.mock("./api-account", () => ({ ApiAccountForm: "ApiAccountForm" }));
vi.mock("./store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./store")>()),
  useStore: (store: { state: unknown }) => ({ state: store.state }),
}));

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

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

const theme = { colors: new Proxy({}, { get: () => "#000" }) };

describe("adding a folder that's signed in already", () => {
  function setUp() {
    const store = {
      state: { accounts: [] as Partial<AccountView>[], logins: [], autoSwitch: false, browserSignIn: true },
      rpc: vi.fn(),
      refresh: vi.fn(async () => undefined),
      watchClosely: () => () => undefined,
    };
    const draw = mount(AddAccountModal, {
      theme,
      layout: { platform: "web", compact: false },
      host: { label: "This Mac" },
      multiHost: false,
      store,
      family: "claude",
      onClose: () => undefined,
    } as never);
    const modes = find(draw(), (element) => typeof element.type === "function" && element.type.name === "ModeStep");
    const choices = [...elements(mount(modes.type as (props: unknown) => ReactNode, modes.props)())].flatMap((element) =>
      typeof element.props.title === "string" ? [element.props.title] : [],
    );
    (modes.props.onImport as () => void)();
    const step = find(draw(), (element) => typeof element.type === "function" && element.type.name === "ImportStep");
    const fill = mount(step.type as (props: unknown) => ReactNode, step.props);
    const type = (text: string) => (find(fill(), (element) => element.type === "TextInput").props.onChangeText as (text: string) => void)(text);
    const add = find(fill(), (element) => element.type === "Button" && element.props.label === "Add account");
    return { store, draw, fill, type, choices, add: () => find(fill(), (element) => element.type === "Button" && element.props.label === add.props.label) };
  }

  it("is offered beside a sign-in and an API key, and asks for the folder", () => {
    const { choices, fill, add } = setUp();
    expect(choices).toEqual(["Claude subscription", "API key or token", "A folder that's signed in already"]);
    expect(find(fill(), (element) => element.type === "TextInput").props.placeholder).toBe("~/.claude-config/claude-work");
    expect(textOf(fill())).toContain("CLAUDE_CONFIG_DIR");
    expect(add().props.disabled).toBe(true);
  });

  it("adds the folder typed, then says who it's signed in as", async () => {
    const { store, draw, fill, type, add } = setUp();
    type(" ~/.claude-config/claude-work ");
    expect(add().props.disabled).toBe(false);
    store.rpc.mockResolvedValue({ accountId: "claude-aaaaaaaaaaaa" });
    store.state.accounts = [{ id: "claude-aaaaaaaaaaaa", label: "work", email: "work@acme.com", plan: "max" }];
    (add().props.onPress as () => void)();
    await vi.waitFor(() => expect(textOf(draw())).toContain("work (work@acme.com) · Max is ready, signed in as it was."));
    expect(store.rpc).toHaveBeenCalledWith(expect.objectContaining({ name: "zerosub.accounts.import" }), { path: "~/.claude-config/claude-work" });
    expect(store.refresh).toHaveBeenCalled();
  });

  it("says why a folder can't be added, and keeps what was typed", async () => {
    const { store, fill, type, add } = setUp();
    type("~/somewhere");
    store.rpc.mockRejectedValue(
      new Error("Request failed: Claude Code isn't signed in with ~/somewhere. requestType=plugin.rpc.invoke.request code=handler_error"),
    );
    (add().props.onPress as () => void)();
    await vi.waitFor(() => expect(textOf(fill())).toContain("Claude Code isn't signed in with ~/somewhere."));
    expect(textOf(fill())).not.toContain("requestType");
    expect(find(fill(), (element) => element.type === "TextInput").props.value).toBe("~/somewhere");
  });
});
