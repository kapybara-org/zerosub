import type { PluginRpcContract } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import { useSyncExternalStore } from "react";
import type { StateView } from "../shared/model";
import { getState } from "../shared/rpc";

const IDLE_POLL_MS = 20_000;
/** While the Accounts screen is open, so usage moves as agents use it. */
export const VISIBLE_POLL_MS = 4_000;
const ACTIVE_POLL_MS = 1_500;

export interface StoreSnapshot {
  state: StateView | null;
  error: string | null;
}

/**
 * One poller per installation feeds the surface, composer pills and commands.
 * Polling is cheap: the daemon answers from memory and refreshes usage on its own schedule.
 */
export interface ZeroSubStore {
  readonly current: StoreSnapshot;
  start(): void;
  stop(): void;
  rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    input: ZodInput<InputSchema>,
  ): Promise<ZodOutput<OutputSchema>>;
  subscribe(listener: () => void): () => void;
  getSnapshot(): StoreSnapshot;
  watch(intervalMs: number): () => void;
  watchClosely(): () => void;
  refresh(options?: { refreshUsage?: boolean; fresh?: boolean }): Promise<void>;
}

/**
 * A closure, not a class: Hermes in React Native 0.81 has no class support in eval'd code. This bundle is
 * large enough to be compiled lazily, so a class silently becomes undefined and `new` throws reading `.prototype`.
 */
export function createZeroSubStore(client: PluginClientContext): ZeroSubStore {
  let snapshot: StoreSnapshot = { state: null, error: null };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let issued = 0;
  let published = 0;
  let stopped = false;
  /** Poll intervals wanted by open views; the shortest wins. */
  const watchers: number[] = [];

  function start(): void {
    void refresh();
  }

  function stop(): void {
    stopped = true;
    if (timer) clearTimeout(timer);
    listeners.clear();
  }

  /** Calls a daemon handler, then refreshes state so every view sees the result. */
  async function rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    input: ZodInput<InputSchema>,
  ): Promise<ZodOutput<OutputSchema>> {
    try {
      return await client.rpc(contract, input);
    } finally {
      // A poll already in flight started before this action, so ask again once it lands.
      void refresh({ fresh: true });
    }
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  const getSnapshot = (): StoreSnapshot => snapshot;

  /** Poll at least this often until the returned function is called. */
  function watch(intervalMs: number): () => void {
    watchers.push(intervalMs);
    schedule();
    let watching = true;
    return () => {
      if (!watching) return;
      watching = false;
      const index = watchers.indexOf(intervalMs);
      if (index >= 0) watchers.splice(index, 1);
      schedule();
    };
  }

  /** Poll quickly while something (a sign-in flow) is waiting on the daemon. */
  function watchClosely(): () => void {
    return watch(ACTIVE_POLL_MS);
  }

  function refresh(options: { refreshUsage?: boolean; fresh?: boolean } = {}): Promise<void> {
    if (inFlight && !options.refreshUsage) {
      if (!options.fresh) return inFlight;
      return inFlight.then(() => refresh({ refreshUsage: options.refreshUsage }));
    }
    const sequence = ++issued;
    const run = client
      .rpc(getState, { refreshUsage: options.refreshUsage })
      .then((state) => {
        // An older, slower answer must not overwrite a newer one.
        if (sequence >= published) {
          published = sequence;
          publish({ state, error: null });
        }
      })
      .catch((error: unknown) => {
        if (sequence >= published) publish({ state: snapshot.state, error: describe(error) });
      })
      .finally(() => {
        if (inFlight === run) inFlight = null;
        schedule();
      });
    inFlight = run;
    return run;
  }

  function publish(next: StoreSnapshot): void {
    if (stopped) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  }

  function schedule(): void {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    const loginActive = snapshot.state?.logins.some((login) => isOpen(login.step)) ?? false;
    const delay = Math.min(IDLE_POLL_MS, loginActive ? ACTIVE_POLL_MS : IDLE_POLL_MS, ...watchers);
    timer = setTimeout(() => void refresh(), delay);
  }

  return {
    get current() {
      return snapshot;
    },
    start,
    stop,
    rpc,
    subscribe,
    getSnapshot,
    watch,
    watchClosely,
    refresh,
  };
}

function isOpen(step: string): boolean {
  return step === "starting" || step === "waiting" || step === "verifying";
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Paseo stopped waiting for the daemon's answer. The plugin doesn't stop with it, so what was asked
 * for may still be under way, or done: say that rather than that it failed.
 */
export function stoppedWaiting(error: unknown): boolean {
  return /Plugin RPC timed out|Timeout waiting for message/i.test(describe(error));
}

export function useStore(store: ZeroSubStore): StoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
