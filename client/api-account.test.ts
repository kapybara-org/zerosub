import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AccountView } from "../shared/model";
import { addApiAccount } from "../shared/rpc";
import { ApiAccountForm } from "./api-account";

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
vi.mock("@getpaseo/plugin/client/ui", () => ({ SettingsCard: "SettingsCard", SettingsSelect: "SettingsSelect", SettingsSwitch: "SettingsSwitch" }));
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

describe("a new Claude API account's form", () => {
  it("adds it as a Claude account with the key kind and traffic switches chosen", async () => {
    const store = { rpc: vi.fn(async () => ({ accountId: "claude-new" })), refresh: vi.fn(async () => undefined) };
    const done = vi.fn();
    const fill = mount(ApiAccountForm, { theme, store, onDone: done, onCancel: () => undefined } as never);
    const input = (label: string) => find(fill(), (element) => element.type === "TextInput" && element.props.accessibilityLabel === label);
    (input("Account name").props.onChangeText as (text: string) => void)("Gateway");
    (find(fill(), (element) => element.type === "SettingsSelect").props.onValueChange as (value: string) => void)("auth_token");
    (input("Auth token").props.onChangeText as (text: string) => void)(" token-1234 ");
    (input("Base URL").props.onChangeText as (text: string) => void)("https://gateway.example.com");
    (find(fill(), (element) => element.type === "SettingsSwitch" && element.props.label === "Turn off telemetry").props.onValueChange as (on: boolean) => void)(true);
    await (find(fill(), (element) => element.type === "Button" && element.props.label === "Add account").props.onPress as () => Promise<void>)();
    expect(store.rpc).toHaveBeenCalledWith(addApiAccount, {
      family: "claude",
      label: "Gateway",
      keyKind: "auth_token",
      key: "token-1234",
      baseUrl: "https://gateway.example.com",
      proxy: undefined,
      disableTelemetry: true,
      disableErrorReporting: false,
      disableNonessentialTraffic: false,
    });
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith("claude-new"));
  });
});
