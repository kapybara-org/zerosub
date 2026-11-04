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
  /** When `state` arrived (ms since the epoch), so a view can say how old it is while refreshes fail. */
  updatedAt: number | null;
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
  /** `refreshUsage` reads every account's usage first. */
  refresh(options?: { refreshUsage?: boolean; fresh?: boolean }): Promise<void>;
}

/**
 * A closure, not a class: Hermes in React Native 0.81 has no class support in eval'd code. This bundle is
 * large enough to be compiled lazily, so a class silently becomes undefined and `new` throws reading `.prototype`.
 */
export function createZeroSubStore(client: PluginClientContext): ZeroSubStore {
  let snapshot: StoreSnapshot = { state: null, error: null, updatedAt: null };
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** The plain state query under way; polls and the refresh after an action share it. */
  let inFlight: Promise<void> | null = null;
  /**
   * An explicit usage refresh under way. The daemon can take a while over one (it may renew sign-ins),
   * so it runs beside the plain queries instead of holding them (and every action waiting on one) up.
   */
  let usageInFlight: Promise<void> | null = null;
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
    if (options.refreshUsage) return refreshUsage();
    if (inFlight) {
      if (!options.fresh) return inFlight;
      return inFlight.then(() => refresh());
    }
    const run = query(false).then(() => undefined);
    inFlight = run;
    void run.finally(() => {
      if (inFlight === run) inFlight = null;
    });
    return run;
  }

  /** Asks the daemon to read every account's usage now, then shows the result. */
  function refreshUsage(): Promise<void> {
    if (usageInFlight) return usageInFlight;
    const run = query(true).then((shown) => {
      // A poll that started while usage was being read answered first, maybe with older readings.
      // The daemon has the new ones now, so ask once more rather than leave them unshown.
      if (!shown) return refresh({ fresh: true });
      return undefined;
    });
    usageInFlight = run;
    void run.finally(() => {
      if (usageInFlight === run) usageInFlight = null;
    });
    return run;
  }

  /** One state query. Resolves to whether its answer was shown: an older, slower answer never replaces a newer one. */
  function query(withUsage: boolean): Promise<boolean> {
    const sequence = ++issued;
    return client
      .rpc(getState, { refreshUsage: withUsage ? true : undefined })
      .then((state) => {
        if (sequence < published) return false;
        published = sequence;
        publish({ state, error: null, updatedAt: Date.now() });
        return true;
      })
      .catch((error: unknown) => {
        if (sequence < published) return false;
        publish({ ...snapshot, error: describe(error) });
        return true;
      })
      .finally(schedule);
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

/** An error in words for the user. Paseo checks RPC input against its schema first, and Zod's error is a JSON list. */
export function describe(error: unknown): string {
  const issues = zodIssues(error);
  if (issues) return issues.map(describeIssue).join(" ");
  return messageOf(error);
}

/**
 * An error's message without what Paseo wraps a plugin handler's error in: `Request failed: `
 * before it, ` requestType=… code=…` after.
 */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const unwrapped = message.replace(/\s+requestType=\S+(?:\s+code=\S+)?\s*$/, "").replace(/^Request failed: /, "");
  return unwrapped.trim() ? unwrapped : message;
}

/** Field names as the forms show them. */
const FIELD_NAMES: Record<string, string> = {
  label: "Name",
  key: "Key",
  baseUrl: "Base URL",
  proxy: "Proxy",
  code: "Code",
};

/** What Zod 3 and 4 put in an issue, as far as wording it goes. */
interface Issue {
  code?: string;
  path: unknown[];
  message: string;
  /** Zod 4. */
  origin?: string;
  /** Zod 3. */
  type?: string;
  maximum?: number | bigint;
  minimum?: number | bigint;
}

/** Zod's issues, from the error itself or from its message, the form they keep once they've crossed an RPC. */
function zodIssues(error: unknown): Issue[] | null {
  const own = typeof error === "object" && error !== null ? (error as { issues?: unknown }).issues : undefined;
  if (isIssueList(own)) return own;
  const message = error instanceof Error || typeof error === "string" ? messageOf(error) : null;
  if (!message?.trimStart().startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    return isIssueList(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isIssueList(value: unknown): value is Issue[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (issue: unknown) =>
        typeof issue === "object" &&
        issue !== null &&
        typeof (issue as Issue).message === "string" &&
        Array.isArray((issue as Issue).path),
    )
  );
}

function describeIssue(issue: Issue): string {
  const key = issue.path.at(-1);
  const field = typeof key === "string" ? (FIELD_NAMES[key] ?? key) : null;
  if (field && (issue.origin ?? issue.type) === "string") {
    if (issue.code === "too_big" && issue.maximum !== undefined) return `${field} can be at most ${issue.maximum} characters.`;
    if (issue.code === "too_small" && Number(issue.minimum) <= 1) return `${field} can't be empty.`;
    if (issue.code === "too_small" && issue.minimum !== undefined) return `${field} needs at least ${issue.minimum} characters.`;
  }
  return field ? `${field}: ${issue.message}` : issue.message;
}

export function useStore(store: ZeroSubStore): StoreSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
