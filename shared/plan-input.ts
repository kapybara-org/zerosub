import { capsAccount } from "./format";
import { kindOf, scopeOf } from "./glance";
import type { AccountView, ModelLimit, Usage, UsageWindow } from "./model";
import type { PlanAccount, PlanLimit, PlanModel, PlanWindow } from "./planner";

const HOUR_MS = 3_600_000;

/** What the planner needs to know about an account, whether the server or the screen asks. */
export interface PlanSource {
  id: string;
  name: string;
  signedIn: boolean;
  disabled: boolean;
  limitedUntil: string | null;
  limitKind: "window" | "budget" | null;
  modelLimits?: readonly ModelLimit[];
  usage: Usage | null | undefined;
  /** Agents running a turn on it now. */
  load?: number;
  /** % of its week per hour, learned from its readings. */
  extRate?: number;
}

function tokens(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Fable needs its own room, so it's planned apart; every other model shares the account's. */
export function modelClass(model: string | null | undefined): PlanModel {
  return model && tokens(model).includes("fable") ? "fable" : "other";
}

/** "Fable 5.2", "Opus 4.7": the model's name in a sentence, from its id. */
export function modelName(model: string | null | undefined): string | null {
  if (!model) return null;
  const parts = tokens(model).filter((part) => part !== "claude" && !/^\d{8}$/.test(part));
  const name = parts.find((part) => /[a-z]/.test(part));
  if (!name) return null;
  const version = parts.filter((part) => /^\d+$/.test(part)).slice(0, 2).join(".");
  const title = name.charAt(0).toUpperCase() + name.slice(1);
  return version ? `${title} ${version}` : title;
}

/** Whether a limit on one model (`fable`, `opus`) holds back an agent running `model`. */
export function limitHolds(limit: ModelLimit, model: string | null | undefined): boolean {
  if (!model) return false;
  const have = new Set(tokens(model));
  return tokens(limit.scope).every((token) => have.has(token));
}

function hoursUntil(at: string | null | undefined, now: number): number | null {
  const time = at ? Date.parse(at) : Number.NaN;
  return Number.isFinite(time) ? (time - now) / HOUR_MS : null;
}

function windowOf(window: UsageWindow | undefined, now: number): PlanWindow | null {
  if (!window || !Number.isFinite(window.usedPercent)) return null;
  return { used: Math.max(0, Math.min(100, window.usedPercent)), reset: hoursUntil(window.resetsAt, now) };
}

function scopeHas(window: UsageWindow, token: string): boolean {
  const scope = scopeOf(window);
  return scope ? tokens(scope).includes(token) : false;
}

/** The planner's view of each account for an agent running `model` (null: not known yet). */
export function planAccounts(sources: readonly PlanSource[], model: string | null | undefined, now: number): PlanAccount[] {
  const fable = modelClass(model) === "fable";
  const modelTokens = new Set(model ? tokens(model) : []);
  return sources.map((source) => {
    const windows = source.usage?.windows ?? [];
    const own = windows.filter(capsAccount);
    const scoped = windows.filter((window) => !capsAccount(window));
    const s = own.find((window) => kindOf(window) === "session");
    const w = own.find((window) => kindOf(window) === "weekly");
    const f = scoped.find((window) => scopeHas(window, "fable"));
    // The asking model's own window, such as "Weekly · Opus" for an Opus agent.
    const m = fable
      ? undefined
      : scoped.find((window) => {
          const scope = scopeOf(window);
          return !!scope && !scopeHas(window, "fable") && tokens(scope).every((token) => modelTokens.has(token));
        });
    const limits: PlanLimit[] = [];
    const until = hoursUntil(source.limitedUntil, now);
    if (until !== null && until > 0) limits.push({ scope: "account", untilH: until, kind: source.limitKind ?? "window" });
    for (const limit of source.modelLimits ?? []) {
      const left = hoursUntil(limit.until, now);
      if (left === null || left <= 0) continue;
      if (limit.scope === "fable") limits.push({ scope: "fable", untilH: left, kind: limit.kind });
      else if (!fable && limitHolds(limit, model)) limits.push({ scope: "model", untilH: left, kind: limit.kind });
    }
    const fetched = source.usage ? Date.parse(source.usage.fetchedAt) : Number.NaN;
    return {
      id: source.id,
      name: source.name,
      status: !source.signedIn ? "signed_out" : source.disabled ? "disabled" : "ready",
      s: windowOf(s, now),
      w: windowOf(w, now),
      f: windowOf(f, now),
      m: windowOf(m, now),
      mName: m ? scopeOf(m) : null,
      ageH: Number.isFinite(fetched) ? Math.max(0, (now - fetched) / HOUR_MS) : 0,
      limits,
      load: source.load ?? 0,
      extRate: source.extRate ?? 0,
      extFable: 0,
      noReading: windows.length === 0,
    };
  });
}

/** An account as the screen sees it, for the planner. */
export function sourceOfView(account: AccountView): PlanSource {
  return {
    id: account.id,
    name: account.label,
    signedIn: account.status !== "signed_out",
    disabled: account.status === "disabled",
    limitedUntil: account.limitedUntil,
    limitKind: account.limitKind ?? null,
    modelLimits: account.modelLimits ?? [],
    usage: account.usage,
    load: account.load ?? 0,
    extRate: account.paceH ?? 0,
  };
}
