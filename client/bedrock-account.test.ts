import type { ReactElement, ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { AccountView } from "../shared/model";
import { addBedrockAccount, detectBedrockRegion, updateBedrockAccount } from "../shared/rpc";
import { BedrockAccountForm, bedrockCardDetails } from "./bedrock-account";

// As in add-account.test.ts: no React Native renderer, so the form is called as the function it is,
// with its hooks kept between calls. Effects run once, when the form first draws.
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
    useEffect(effect: () => unknown) {
      const at = index++;
      if (at in cells) return;
      cells[at] = true;
      effect();
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useCallback: (callback: unknown) => callback,
  useMemo: (make: () => unknown) => make(),
  useEffect: hooks.useEffect,
}));
vi.mock("react-native", () => ({ Text: "Text", View: "View", Pressable: "Pressable" }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({
  Modal: Object.assign(() => null, { Content: "ModalContent" }),
  TextInput: "TextInput",
  useToast: () => ({ show: () => undefined, error: () => undefined }),
}));
vi.mock("./ui", () => ({ Button: "Button", IconButton: "IconButton", useText: () => new Proxy({}, { get: () => ({}) }) }));

type Element = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function* elements(node: ReactNode): Generator<Element> {
  if (Array.isArray(node)) {
    for (const child of node) yield* elements(child);
  } else if (node && typeof node === "object" && "props" in node) {
    yield node as Element;
    yield* elements((node as Element).props.children);
  }
}

const theme = { colors: new Proxy({}, { get: () => "#000" }) };

function setUp(rpc: (contract: unknown, input: unknown) => Promise<unknown>, account?: Partial<AccountView>) {
  const store = { rpc: vi.fn(rpc), refresh: vi.fn(async () => undefined) };
  const done = vi.fn();
  const cells: unknown[] = [];
  const draw = () =>
    hooks.run(cells, () =>
      BedrockAccountForm({ theme, store, account: account as AccountView | undefined, paidFallback: false, onDone: done, onCancel: () => undefined } as never),
    ) as Element;
  const input = (label: string) => [...elements(draw())].find((element) => element.type === "TextInput" && element.props.accessibilityLabel === label)!;
  const button = (label: string) => [...elements(draw())].find((element) => element.type === "Button" && element.props.label === label)!;
  return { store, done, draw, input, button };
}

describe("the AWS Bedrock form", () => {
  it("looks up the host's region as it opens, and fills it in", async () => {
    const { store, draw, input } = setUp(async (contract) => (contract === detectBedrockRegion ? { region: "eu-central-1", source: "config" } : null));
    draw();
    expect(store.rpc).toHaveBeenCalledTimes(1);
    expect(store.rpc.mock.calls[0]![0]).toBe(detectBedrockRegion);
    await vi.waitFor(() => expect(input("AWS region").props.value).toBe("eu-central-1"));
    const text = [...elements(draw())].map((element) => element.props.children).filter((child) => typeof child === "string");
    expect(text).toContain("From the host's ~/.aws/config.");
    // Drawing again doesn't ask again.
    draw();
    expect(store.rpc).toHaveBeenCalledTimes(1);
  });

  it("leaves a region the user typed alone when the lookup answers late", async () => {
    let answer!: (value: unknown) => void;
    const { draw, input } = setUp((contract) => (contract === detectBedrockRegion ? new Promise((resolve) => (answer = resolve)) : Promise.resolve(null)));
    draw();
    (input("AWS region").props.onChangeText as (value: string) => void)("us-west-2");
    answer({ region: "eu-central-1", source: "instance" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(input("AWS region").props.value).toBe("us-west-2");
  });

  it("sends an access key only when it's that source, and adds the account", async () => {
    const { store, draw, input, button, done } = setUp(async (contract) =>
      contract === addBedrockAccount ? { accountId: "claude-1", warning: null } : { region: null, source: null },
    );
    draw();
    (input("Account name").props.onChangeText as (value: string) => void)("Bedrock");
    (input("AWS region").props.onChangeText as (value: string) => void)("us-east-1");
    expect(button("Add account").props.disabled).toBe(false);
    const sources = [...elements(draw())].filter((element) => element.type === "Pressable");
    (sources.find((element) => element.props.accessibilityLabel === "Access key")!.props.onPress as () => void)();
    expect(button("Add account").props.disabled).toBe(true);
    (input("Access key ID").props.onChangeText as (value: string) => void)("AKIAIOSFODNN7EXAMPLE");
    (input("Secret access key").props.onChangeText as (value: string) => void)("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
    expect(input("Secret access key").props.secureTextEntry).toBe(true);
    await (button("Add account").props.onPress as () => Promise<void>)();
    await vi.waitFor(() => expect(done).toHaveBeenCalledWith("claude-1", null));
    const [, sent] = store.rpc.mock.calls.find(([contract]) => contract === addBedrockAccount)!;
    expect(sent).toMatchObject({ label: "Bedrock", region: "us-east-1", source: "keys", accessKeyId: "AKIAIOSFODNN7EXAMPLE", profile: undefined });
  });

  it("doesn't look the region up when editing, and keeps the stored secret unless one is typed", async () => {
    const account = {
      id: "claude-1",
      label: "Bedrock",
      bedrock: { region: "eu-central-1", source: "keys", profile: null, keyHint: "MPLE", sessionToken: false, models: { model: "", opus: "", sonnet: "", haiku: "" }, prices: {}, usage: null },
    } as unknown as AccountView;
    const { store, draw, button } = setUp(async () => ({ ok: true, warning: null }), account);
    draw();
    expect(store.rpc).not.toHaveBeenCalled();
    expect(button("Save").props.disabled).toBe(false);
    await (button("Save").props.onPress as () => Promise<void>)();
    const [contract, sent] = store.rpc.mock.calls[0]!;
    expect(contract).toBe(updateBedrockAccount);
    expect(sent).toMatchObject({ accountId: "claude-1", source: "keys", accessKeyId: undefined, secretAccessKey: undefined });
    expect(bedrockCardDetails(account)).toBe("eu-central-1 · access key …MPLE");
  });
});
