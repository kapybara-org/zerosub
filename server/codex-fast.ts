import { codexFastExpiresAt } from "../shared/codex-fast-date";
import { capsAccount } from "../shared/format";
import { WEEK_NEARLY_USED_PERCENT, type Usage } from "../shared/model";
import { isUsable, weeklyWindow } from "./routing";
import type { StoredAccount } from "./state";

export const CODEX_FAST_METADATA_KEY = "zerosub.codex-fast";
const MAX_READING_AGE_MS = 30 * 60_000;

type SpeedControl = {
  key?: string;
  type?: string;
  choices?: readonly { value: string; label: string }[];
};

/** The option API introduced in Paseo 0.15. Keep ZeroSub's older SDK minimum for other features. */
export interface CodexSpeedState {
  metadata?: Readonly<Record<string, unknown>> | null;
  controls?: readonly SpeedControl[];
  options?: Readonly<Record<string, unknown>>;
}

export interface CodexSpeedHandle {
  setOptions?(patch: { service_tier: "fast" | "default" }): Promise<void>;
  setMetadata?(patch: Record<string, true | null>): Promise<void>;
}

export interface CodexSpeedCatalog {
  listControls?(draft: {
    provider: string;
    cwd?: string;
    providerOptions?: Record<string, unknown>;
  }): Promise<CodexSpeedState & { error?: string | null }>;
}

/** Use account/rateLimits windows current at this instant, including any user-set quota ceiling. */
export function canUseCodexFast(account: StoredAccount | undefined, usage: Usage | undefined, now: number): boolean {
  if (!account || account.family !== "codex" || account.auth !== "subscription" || !usage || usage.error || usage.cached || !isUsable(account, now, null, usage)) return false;
  if (!(now < codexFastExpiresAt(account.codexFastUntil))) return false;
  if (!(Date.parse(usage.fetchedAt) > now - MAX_READING_AGE_MS)) return false;
  const weekly = weeklyWindow(usage);
  const windows = usage.windows.filter(capsAccount);
  return windows.length > 0 && windows.every((window) =>
    (window.resetsAt ? Date.parse(window.resetsAt) > now : window.usedPercent === 0) &&
    window.usedPercent < (window === weekly ? WEEK_NEARLY_USED_PERCENT : 100),
  );
}

export function codexFastChoice(state: CodexSpeedState): string | undefined {
  return state.controls
    ?.find((control) => control.key === "service_tier" && control.type === "select")
    ?.choices?.find((choice) => choice.value === "fast" || choice.label.toLowerCase() === "fast")?.value;
}

export function standardSpeed(state: CodexSpeedState): boolean {
  const tier = state.options?.service_tier;
  return tier == null || tier === "default";
}

/** Remember our change before writing it, so an interrupted write can still be undone. */
export async function syncCodexSpeed(agent: Required<CodexSpeedHandle>, state: CodexSpeedState, enable: boolean): Promise<void> {
  const managed = state.metadata?.[CODEX_FAST_METADATA_KEY] === true;
  const choice = codexFastChoice(state);
  if (enable && choice && standardSpeed(state)) {
    if (!managed) await agent.setMetadata({ [CODEX_FAST_METADATA_KEY]: true });
    await agent.setOptions({ service_tier: "fast" });
  } else if (!enable && managed && state.options) {
    const tier = state.options.service_tier;
    if (tier === "fast" || (choice !== undefined && tier === choice)) {
      await agent.setOptions({ service_tier: "default" });
    }
    await agent.setMetadata({ [CODEX_FAST_METADATA_KEY]: null });
  }
}
