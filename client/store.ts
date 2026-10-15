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
export function createZeroSubStore(client: PluginClientContext) {
  // Hermes evaluates plugin bundles at runtime; keep the store free of native class syntax.
  const store = {
    client,
    snapshot: { state: null, error: null } as StoreSnapshot,
    listeners: new Set<() => void>(),
    timer: null as ReturnType<typeof setTimeout> | null,
    inFlight: null as Promise<void> | null,
    issued: 0,
    published: 0,
    stopped: false,
    /** Poll intervals wanted by open views; the shortest wins. */
    watchers: [] as number[],

    start(): void {
      void this.refresh();
    },

    stop(): void {
      this.stopped = true;
      if (this.timer) clearTimeout(this.timer);
      this.listeners.clear();
    },

    /** Calls a daemon handler, then refreshes state so every view sees the result. */
    async rpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
      contract: PluginRpcContract<InputSchema, OutputSchema>,
      input: ZodInput<InputSchema>,
    ): Promise<ZodOutput<OutputSchema>> {
      try {
        return await this.client.rpc(contract, input);
      } finally {
        // A poll already in flight started before this action, so ask again once it lands.
        void this.refresh({ fresh: true });
      }
    },

    get current(): StoreSnapshot {
      return this.snapshot;
    },

    subscribe: (listener: () => void): (() => void) => {
      store.listeners.add(listener);
      return () => store.listeners.delete(listener);
    },

    getSnapshot: (): StoreSnapshot => store.snapshot,

    /** Poll at least this often until the returned function is called. */
    watch(intervalMs: number): () => void {
      this.watchers.push(intervalMs);
      this.schedule();
      let watching = true;
      return () => {
        if (!watching) return;
        watching = false;
        const index = this.watchers.indexOf(intervalMs);
        if (index >= 0) this.watchers.splice(index, 1);
        this.schedule();
      };
    },

    /** Poll quickly while something (a sign-in flow) is waiting on the daemon. */
    watchClosely(): () => void {
      return this.watch(ACTIVE_POLL_MS);
    },

    refresh(options: { refreshUsage?: boolean; fresh?: boolean } = {}): Promise<void> {
      if (this.inFlight && !options.refreshUsage) {
        if (!options.fresh) return this.inFlight;
        return this.inFlight.then(() => this.refresh({ refreshUsage: options.refreshUsage }));
      }
      const sequence = ++this.issued;
      const run = this.client
        .rpc(getState, { refreshUsage: options.refreshUsage })
        .then((state) => {
          // An older, slower answer must not overwrite a newer one.
          if (sequence >= this.published) {
            this.published = sequence;
            this.publish({ state, error: null });
          }
        })
        .catch((error: unknown) => {
          if (sequence >= this.published) this.publish({ state: this.snapshot.state, error: describe(error) });
        })
        .finally(() => {
          if (this.inFlight === run) this.inFlight = null;
          this.schedule();
        });
      this.inFlight = run;
      return run;
    },

    publish(next: StoreSnapshot): void {
      if (this.stopped) return;
      this.snapshot = next;
      for (const listener of [...this.listeners]) listener();
    },

    schedule(): void {
      if (this.stopped) return;
      if (this.timer) clearTimeout(this.timer);
      const loginActive = this.snapshot.state?.logins.some((login) => isOpen(login.step)) ?? false;
      const delay = Math.min(IDLE_POLL_MS, loginActive ? ACTIVE_POLL_MS : IDLE_POLL_MS, ...this.watchers);
      this.timer = setTimeout(() => void this.refresh(), delay);
    },
  };
  return store;
}

export type ZeroSubStore = ReturnType<typeof createZeroSubStore>;

function isOpen(step: string): boolean {
  return step === "starting" || step === "waiting" || step === "verifying";
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useStore(store: ZeroSubStore): StoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
