import type { PluginClientContext } from "@getpaseo/plugin/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LoginView, StateView } from "../shared/model";
import { getState, setAgentAccount } from "../shared/rpc";
import { VISIBLE_POLL_MS, createZeroSubStore, type StoreSnapshot } from "./store";

function view(overrides: Partial<StateView> = {}): StateView {
  return {
    accounts: [],
    agents: [],
    logins: [],
    providers: {},
    canReopen: false,
    browserSignIn: true,
    piLaunchers: null,
    piHomes: null,
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
