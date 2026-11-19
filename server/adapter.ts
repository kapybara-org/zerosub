import type { PluginLifecycleEvents, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { ApiSummary, Family, LoginMethod, LoginStep, Usage } from "../shared/model";
import type { RedeemOutcome } from "../shared/rpc";
import type { ApiConfig } from "./homes";
import { providerEnv } from "./provider-env";

/**
 * One timeline entry. Taken from the SDK rather than `@getpaseo/protocol`: Paseo only supplies
 * `@getpaseo/plugin` to plugins, and an npm install has no devDependencies to resolve it from.
 */
export type AgentTimelineItem = PluginLifecycleEvents["agent.turn_ended"]["timeline"][number];

/** A provider's answer to a redeem request. */
export interface RedeemReply {
  outcome: RedeemOutcome;
  message: string;
  left: number | null;
}

export interface Identity {
  signedIn: boolean;
  email: string | null;
  plan: string | null;
  organization: string | null;
  /** Key for spotting the same account twice (org + email, or ChatGPT workspace + member email). */
  identity: string | null;
}

/**
 * `window`: a rolling usage window (5-hour, weekly, per-model) that usage readings track.
 * `budget`: a spend cap, credit balance or org budget, invisible in usage windows.
 */
export type LimitKind = "window" | "budget";

/**
 * A usage reading, plus when to ask again if the provider said to slow down. An adapter may leave
 * `credits` out; the reading is stored with `null` then.
 */
export type UsageRead = Omit<Usage, "credits"> & { credits?: Usage["credits"]; retryAt?: number };

export interface LimitHit {
  kind: LimitKind;
  /** When the limit lifts, if the provider said. */
  resetsAt: string | null;
  message: string;
  /**
   * The lowercase model name a limit is scoped to ("fable", "opus"): the limit of that model's own
   * window, which leaves the account usable for other models. Null for a limit of the whole account.
   */
  scope?: string | null;
}

/** A finished turn, as Paseo reports it. */
export interface TurnEvent {
  outcome: PluginTurnOutcome;
  timeline: readonly AgentTimelineItem[];
  /** Paseo's id for the turn; `null` when the turn failed before it started. */
  turnId?: string | null;
}

export interface LoginProgress {
  step: LoginStep;
  /** Link that finishes by itself when opened on the daemon machine (localhost callback), or the device-code page. */
  url: string | null;
  /** Link whose page shows a code to paste back — works from any device. */
  codeUrl: string | null;
  userCode: string | null;
  message: string | null;
}

export interface LoginHandle {
  readonly progress: LoginProgress;
  onProgress(listener: (progress: LoginProgress) => void): void;
  submitCode(code: string): Promise<void>;
  cancel(): void;
  /** Settles when the flow ends. */
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
}

/** Where an account's CLI gets its proxy (see `FamilyAdapter.proxyState`). */
export interface ProxyState {
  /** Its own proxy, or null when it uses whatever it inherits. */
  own: string | null;
  /** The user's file its own proxy is kept in, where setting one changes it; null when that's ZeroSub's own. */
  file: string | null;
  /** The proxy it goes through without one of its own, and where that's set; null when that's direct. */
  inherited: { proxy: string; from: string } | null;
  /** Why one can't be set here just now; null when it can. */
  blocked?: string | null;
}

/**
 * Launch-environment changes for a session. `null` means "inherit the daemon's value": the key is
 * dropped from the per-session override map, and left untouched for processes ZeroSub spawns.
 */
export type EnvPatch = Record<string, string | null>;

/** Everything provider-specific. The service only talks to accounts through this. */
export interface FamilyAdapter {
  readonly family: Family;
  /** A live conversation can reopen on another account of this provider. */
  readonly portable: boolean;
  /** Shortest gap between usage checks for one account, even when a refresh is forced. */
  readonly usageSpacingMs: number;
  available(): Promise<{ ok: boolean; detail: string | null }>;
  /**
   * Creates or refreshes a managed home: isolated credentials, everything else shared with main.
   * `wanted`, if given, is asked once nothing else works on the home; false leaves it untouched.
   */
  prepareHome(home: string, wanted?: () => Promise<boolean>): Promise<void>;
  /**
   * `home === null` is the CLI's own login. `session`, when the patch is for a session Paseo opens:
   * the folder it runs in.
   */
  env(home: string | null, session?: { cwd: string }): Promise<EnvPatch>;
  identity(home: string | null, options?: { livePlan?: boolean }): Promise<Identity>;
  /**
   * Usage windows and banked resets. `renewLogin` lets the adapter have the CLI refresh an expired
   * sign-in first (slow, so only for explicit requests, and at most every 30 minutes in the background).
   */
  usage(home: string | null, options?: { renewLogin?: boolean }): Promise<UsageRead>;
  /** Spends one banked reset. Only called for an explicit user request or the opt-in auto setting. */
  /**
   * Spends one banked reset. With `onlyAtLimit` (automatic use) it spends one only while the
   * provider still sees the account at a limit, so two hosts sharing an account can't spend two
   * resets on the same limit.
   */
  redeemReset(home: string | null, options?: { onlyAtLimit?: boolean }): Promise<RedeemReply>;
  login(home: string | null, method: LoginMethod): Promise<LoginHandle>;
  logout(home: string): Promise<void>;
  /**
   * An API account's key (reduced to a hint), base URL and, for Claude, its key kind and traffic
   * switches; null for a subscription login. `home === null` (the CLI login) only where `mainApi` says so.
   */
  api?(home: string | null): Promise<ApiSummary | null>;
  /** The CLI login's Anthropic key and base URL can be set here too. */
  readonly mainApi?: boolean;
  /**
   * Stores an API account's key (`null` keeps the current one), base URL and, for Claude, key kind
   * and traffic switches. `wanted`, if given, is asked once nothing else works on the home; false
   * throws and writes nothing.
   */
  setApi?(home: string | null, config: ApiConfig, wanted?: () => Promise<boolean>): Promise<void>;
  /**
   * The proxy an added account's requests to `baseUrl` would cross as plain http:// (`through`: as
   * if it were that one), which could read its key; null when none would. For providers whose API
   * accounts keep their key in the home's settings (Claude's; Pi checks its own when it writes).
   */
  clearTextProxy?(home: string, baseUrl: string | null, through?: string): Promise<string | null>;
  /**
   * Where an account's CLI (`home === null`: the CLI's own login) gets its proxy, for providers that
   * let ZeroSub set one per account (Claude's and Pi's).
   */
  proxyState?(home: string | null): Promise<ProxyState>;
  /** Sets (or clears, with `null`) an account's proxy, for processes started afterwards. `wanted` as for `setApi`. */
  setProxy?(home: string | null, proxy: string | null, wanted?: () => Promise<boolean>): Promise<void>;
  /** The address Anthropic sees the account's requests come from; null when they go somewhere else first. */
  egress?(home: string | null): Promise<{ ip: string; country: string | null } | null>;
  /**
   * Which of `homes` a process of the provider's CLI runs on right now, so a home isn't moved under
   * it (see `Service.placeHomes`). Providers that have it keep added accounts' homes outside `homes/`.
   */
  homesInUse?(homes: readonly string[]): Promise<Set<string>>;
  /**
   * Whether `home` holds an account's sign-in or key: what a folder made again by a sync, or by the
   * CLI started on it, lacks. Tells which of two folders an interrupted move left is the account.
   */
  holdsAccount?(home: string): Promise<boolean>;
  /**
   * Before a home's folder moves from `from` to `to`: copies what the CLI keeps for it outside the
   * folder (Claude's Keychain entry on macOS) to where it looks for `to`'s, and checks the copy.
   * Nothing to do where the sign-in lives in the folder. Repeating it after it worked does nothing.
   */
  copyCredentials?(from: string, to: string): Promise<void>;
  /**
   * Undoes `copyCredentials` for a move that didn't happen: removes `to`'s copy, but only while it's
   * the same as `from`'s, so an entry that was there before is never touched.
   */
  dropCopiedCredentials?(from: string, to: string): Promise<void>;
  /**
   * Once the account's home is saved as `to`: removes `from`'s copy, but only while `to` holds a
   * sign-in of its own, so the account's login is never left nowhere. False when it left `from`'s.
   */
  dropOldCredentials?(from: string, to: string): Promise<boolean>;
  /** Looks for a subscription usage-limit failure in a finished turn. */
  detectLimit(event: TurnEvent): LimitHit | null;
  /** Looks for a turn that failed because the account's login is no longer valid. */
  detectSignOut(event: TurnEvent): string | null;
}

/**
 * Stands in for a family the service was given no adapter for: never available, so it never shows
 * and nothing is routed to it.
 */
export function missingAdapter(family: Family): FamilyAdapter {
  const none = async (): Promise<never> => {
    throw new Error(`${family} isn't set up here.`);
  };
  return {
    family,
    portable: true,
    usageSpacingMs: 60_000,
    available: async () => ({ ok: false, detail: null }),
    prepareHome: none,
    env: async () => ({}),
    identity: none,
    usage: none,
    redeemReset: none,
    login: none,
    logout: none,
    detectLimit: () => null,
    detectSignOut: () => null,
  };
}

/**
 * The environment for a process ZeroSub spawns against `patch`: what Paseo gives a session of the
 * family's provider, the daemon's environment with the provider's configured `env` over it.
 */
export function spawnEnv(patch: EnvPatch, family: Family): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...providerEnv(family) };
  for (const [key, value] of Object.entries(patch)) if (value !== null) env[key] = value;
  return env;
}

/** Applies `patch` to a session's launch override map. */
export function applyEnv(patch: EnvPatch, requestEnv: Record<string, string>): Record<string, string> {
  const env = { ...requestEnv };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Shared helper for login handles: progress state plus listeners. */
export class ProgressEmitter {
  progress: LoginProgress = { step: "starting", url: null, codeUrl: null, userCode: null, message: null };
  private readonly listeners = new Set<(progress: LoginProgress) => void>();

  onProgress(listener: (progress: LoginProgress) => void): void {
    this.listeners.add(listener);
  }

  update(patch: Partial<LoginProgress>): void {
    this.progress = { ...this.progress, ...patch };
    for (const listener of this.listeners) listener(this.progress);
  }
}
