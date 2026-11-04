import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginView, StateView } from "../shared/model";
import { getState, setAgentAccount } from "../shared/rpc";
import { VISIBLE_POLL_MS, createZeroSubStore, describe as describeError, type StoreSnapshot } from "./store";

function view(overrides: Partial<StateView> = {}): StateView {
  return {
    accounts: [],
    agents: [],
    logins: [],
    providers: {},
    canReopen: false,
    browserSignIn: true,
    showComposerPill: false,
    warnings: [],
    ...overrides,
  };
}

function fakeClient() {
  return { rpc: vi.fn() };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createStore() {
  const client = fakeClient();
  const store = createZeroSubStore(client as unknown as PluginClientContext);
  return { client, store };
}

describe("createZeroSubStore", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("supports detached subscribe/getSnapshot callbacks for useSyncExternalStore", async () => {
    const { client, store } = createStore();
    const state = view();
    client.rpc.mockResolvedValue(state);
    const { subscribe, getSnapshot } = store;
    expect(getSnapshot()).toBe(store.current);
    const seen: StoreSnapshot[] = [];
    const unsubscribe = subscribe(() => seen.push(getSnapshot()));
    await store.refresh();
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(store.current);
    expect(getSnapshot().state).toBe(state);
    unsubscribe();
    await store.refresh();
    expect(seen).toHaveLength(1);
  });

  it("shares parallel refresh calls", async () => {
    const { client, store } = createStore();
    const gate = deferred<StateView>();
    client.rpc.mockReturnValue(gate.promise);
    const first = store.refresh();
    const second = store.refresh();
    expect(second).toBe(first);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    gate.resolve(view());
    await first;
    await second;
  });

  it("runs a fresh refresh after the in-flight query lands", async () => {
    const { client, store } = createStore();
    const stale = deferred<StateView>();
    const latest = deferred<StateView>();
    client.rpc.mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
    const first = store.refresh();
    const fresh = store.refresh({ fresh: true });
    expect(client.rpc).toHaveBeenCalledTimes(1);
    stale.resolve(view());
    await first;
    expect(client.rpc).toHaveBeenCalledTimes(2);
    const state = view({ warnings: ["new"] });
    latest.resolve(state);
    await fresh;
    expect(store.current.state).toBe(state);
  });

  it("never lets a stale answer overwrite a newer one", async () => {
    const { client, store } = createStore();
    const slow = deferred<StateView>();
    const fast = deferred<StateView>();
    client.rpc.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const slowCall = store.refresh();
    const fastCall = store.refresh({ refreshUsage: true });
    expect(client.rpc).toHaveBeenCalledTimes(2);
    expect(client.rpc).toHaveBeenCalledWith(getState, { refreshUsage: true });
    const newer = view({ warnings: ["new"] });
    fast.resolve(newer);
    await fastCall;
    expect(store.current.state).toBe(newer);
    slow.resolve(view({ warnings: ["old"] }));
    await slowCall;
    expect(store.current.state).toBe(newer);
  });

  it("stop prevents further polls and notifications", async () => {
    const { client, store } = createStore();
    const state = view();
    const gate = deferred<StateView>();
    client.rpc.mockResolvedValueOnce(state).mockReturnValueOnce(gate.promise);
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.current.state).toBe(state);
    const listener = vi.fn();
    store.subscribe(listener);
    const pending = store.refresh();
    expect(client.rpc).toHaveBeenCalledTimes(2);
    store.stop();
    gate.resolve(view({ warnings: ["late"] }));
    await pending;
    expect(listener).not.toHaveBeenCalled();
    expect(store.current.state).toBe(state);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it("polls watched views faster until unwatch", async () => {
    const { client, store } = createStore();
    client.rpc.mockResolvedValue(view());
    store.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    const unwatch = store.watch(VISIBLE_POLL_MS);
    await vi.advanceTimersByTimeAsync(VISIBLE_POLL_MS);
    expect(client.rpc).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(VISIBLE_POLL_MS);
    expect(client.rpc).toHaveBeenCalledTimes(3);
    unwatch();
    await vi.advanceTimersByTimeAsync(VISIBLE_POLL_MS);
    expect(client.rpc).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20_000 - VISIBLE_POLL_MS);
    expect(client.rpc).toHaveBeenCalledTimes(4);
  });

  it("works with methods taken off the store", async () => {
    const { client, store } = createStore();
    client.rpc.mockResolvedValue(view());
    const { start, stop, rpc, refresh, watch, watchClosely, subscribe, getSnapshot } = store;
    const listener = vi.fn();
    subscribe(listener);
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(listener).toHaveBeenCalledTimes(1);
    const unwatch = watch(VISIBLE_POLL_MS);
    await vi.advanceTimersByTimeAsync(VISIBLE_POLL_MS);
    expect(client.rpc).toHaveBeenCalledTimes(2);
    unwatch();
    watchClosely()();
    await refresh({ refreshUsage: true });
    await rpc(setAgentAccount, { agentId: "agent-1", accountId: null });
    // start, the watched poll, refresh, the action, and the refresh after the action.
    expect(client.rpc).toHaveBeenCalledTimes(5);
    expect(getSnapshot()).toBe(store.current);
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.rpc).toHaveBeenCalledTimes(5);
  });

  it("asks for fresh state after an action, even while a poll is in flight", async () => {
    const { client, store } = createStore();
    const poll = deferred<StateView>();
    client.rpc.mockReturnValueOnce(poll.promise).mockResolvedValue(view());
    const polling = store.refresh();
    await store.rpc(setAgentAccount, { agentId: "agent-1", accountId: null });
    expect(client.rpc).toHaveBeenCalledTimes(2);
    poll.resolve(view());
    await polling;
    await vi.advanceTimersByTimeAsync(0);
    expect(client.rpc).toHaveBeenCalledTimes(3);
    expect(client.rpc).toHaveBeenLastCalledWith(getState, { refreshUsage: undefined });
  });

  it("polls quickly while a sign-in is open", async () => {
    const { client, store } = createStore();
    const login: LoginView = {
      id: "login-1",
      family: "claude",
      method: "code",
      accountId: null,
      step: "waiting",
      url: null,
      codeUrl: null,
      userCode: null,
      message: null,
      startedAt: "2026-10-18T00:00:00Z",
    };
    client.rpc.mockResolvedValueOnce(view({ logins: [login] })).mockResolvedValue(view());
    store.start();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(client.rpc).toHaveBeenCalledTimes(2);
    // The sign-in finished, so polling drops back to the idle interval.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(client.rpc).toHaveBeenCalledTimes(2);
  });

  it("keeps the last state and reports the error when a refresh fails", async () => {
    const { client, store } = createStore();
    const state = view();
    client.rpc.mockResolvedValueOnce(state).mockRejectedValueOnce(new Error("daemon unreachable")).mockResolvedValue(view());
    await store.refresh();
    await store.refresh();
    expect(store.current.state).toBe(state);
    expect(store.current.error).toBe("daemon unreachable");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(client.rpc).toHaveBeenCalledTimes(3);
    expect(store.current.error).toBeNull();
  });
});

describe("createZeroSubStore with a usage refresh under way", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("answers other refreshes, and the one after an action, without waiting for it", async () => {
    const { client, store } = createStore();
    const usage = deferred<StateView>();
    const latest = view({ warnings: ["after the action"] });
    client.rpc.mockReturnValueOnce(usage.promise).mockResolvedValue(latest);
    const refreshing = store.refresh({ refreshUsage: true });
    // A poll, and an action with the refresh it asks for and the one its caller awaits.
    await store.refresh();
    await store.rpc(setAgentAccount, { agentId: "agent-1", accountId: null });
    await store.refresh();
    expect(store.current.state).toBe(latest);
    expect(client.rpc).toHaveBeenCalledWith(getState, { refreshUsage: true });
    expect(client.rpc).toHaveBeenLastCalledWith(getState, { refreshUsage: undefined });
    const calls = client.rpc.mock.calls.length;
    usage.resolve(view({ warnings: ["usage"] }));
    await refreshing;
    // Its answer is older than the ones shown since, so the store asks again for the newest.
    expect(client.rpc).toHaveBeenCalledTimes(calls + 1);
    expect(store.current.state).toBe(latest);
  });

  it("shows the usage answer when nothing newer came in meanwhile", async () => {
    const { client, store } = createStore();
    const fresh = view({ warnings: ["fresh usage"] });
    client.rpc.mockResolvedValueOnce(fresh);
    await store.refresh({ refreshUsage: true });
    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(store.current.state).toBe(fresh);
  });

  it("shares a second usage refresh with the one under way", async () => {
    const { client, store } = createStore();
    const usage = deferred<StateView>();
    client.rpc.mockReturnValueOnce(usage.promise);
    const first = store.refresh({ refreshUsage: true });
    const second = store.refresh({ refreshUsage: true });
    expect(second).toBe(first);
    expect(client.rpc).toHaveBeenCalledTimes(1);
    usage.resolve(view());
    await first;
  });

  it("remembers when the state shown arrived, and keeps that time while refreshes fail", async () => {
    const { client, store } = createStore();
    vi.setSystemTime(new Date("2026-10-28T10:00:00Z"));
    client.rpc.mockResolvedValueOnce(view()).mockRejectedValueOnce(new Error("Plugin is not available"));
    expect(store.current.updatedAt).toBeNull();
    await store.refresh();
    const arrived = Date.parse("2026-10-28T10:00:00Z");
    expect(store.current.updatedAt).toBe(arrived);
    vi.setSystemTime(new Date("2026-10-28T10:03:00Z"));
    await store.refresh();
    expect(store.current.error).toBe("Plugin is not available");
    expect(store.current.updatedAt).toBe(arrived);
  });
});

describe("describe", () => {
  it("words Zod's input errors for the user", async () => {
    const { z } = await import("zod");
    const schema = z.object({ label: z.string().trim().min(1).max(40), key: z.string().trim().min(1) });
    const failure = schema.safeParse({ label: "x".repeat(41), key: " " }).error;
    expect(describeError(failure)).toBe("Name can be at most 40 characters. Key can't be empty.");
    // The same error once only its message is left, as after crossing an RPC.
    expect(describeError(new Error(failure?.message))).toBe("Name can be at most 40 characters. Key can't be empty.");
  });

  it("drops what Paseo wraps a plugin handler's error in", () => {
    const wrapped = (inner: string) => new Error(`Request failed: ${inner} requestType=plugin.rpc.invoke.request code=handler_error`);
    expect(describeError(wrapped("Pick a folder of their own for the accounts, not ~ itself."))).toBe(
      "Pick a folder of their own for the accounts, not ~ itself.",
    );
    expect(describeError(new Error("Plugin is not available requestType=plugin.rpc.invoke.request"))).toBe("Plugin is not available");
    const issues = '[{"code":"too_big","maximum":40,"type":"string","inclusive":true,"path":["label"],"message":"x"}]';
    expect(describeError(wrapped(issues))).toBe("Name can be at most 40 characters.");
  });

  it("leaves other errors as they are", () => {
    expect(describeError(new Error("Plugin RPC timed out"))).toBe("Plugin RPC timed out");
    expect(describeError(new Error("[ZeroSub] not JSON"))).toBe("[ZeroSub] not JSON");
    expect(describeError("plain")).toBe("plain");
  });
});
