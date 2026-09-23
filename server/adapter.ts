import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { Family, LoginMethod, LoginStep, Usage } from "../shared/model";
import type { RedeemOutcome } from "../shared/rpc";

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
  /** Stable key for spotting the same account twice (org + email, or the ChatGPT account ID). */
  identity: string | null;
}

/**
 * `window`: a rolling usage window (5-hour, weekly, per-model) that usage readings track.
 * `budget`: a spend cap, credit balance or org budget, invisible in usage windows.
 */
export type LimitKind = "window" | "budget";

/** A usage reading, plus when to ask again if the provider said to slow down. */
export type UsageRead = Usage & { retryAt?: number };

export interface LimitHit {
  kind: LimitKind;
  /** When the limit lifts, if the provider said. */
  resetsAt: string | null;
  message: string;
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
  /** Creates or refreshes a managed home: isolated credentials, everything else shared with main. */
  prepareHome(home: string): Promise<void>;
  /** `home === null` is the CLI's own login. */
  env(home: string | null): Promise<EnvPatch>;
  identity(home: string | null): Promise<Identity>;
  /**
   * Usage windows and banked resets. `renewLogin` lets the adapter have the CLI refresh an expired
   * sign-in first (slow, so only for explicit requests, never background polls).
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
  /** Looks for a subscription usage-limit failure in a finished turn. */
  detectLimit(event: { outcome: PluginTurnOutcome; timeline: readonly AgentTimelineItem[] }): LimitHit | null;
  /** Looks for a turn that failed because the account's login is no longer valid. */
  detectSignOut(event: { outcome: PluginTurnOutcome; timeline: readonly AgentTimelineItem[] }): string | null;
}

/** The environment for a process ZeroSub spawns against `patch`. */
export function spawnEnv(patch: EnvPatch): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
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
