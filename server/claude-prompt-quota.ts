import { capsAccount } from "../shared/format";
import type { Usage } from "../shared/model";
import { quotaCeilingReached } from "./routing";
import type { StoredAccount } from "./state";

export function claudePromptQuota(account: StoredAccount, usage: Usage | undefined, now: number): string | null {
  const windows = usage?.windows.filter((window) => capsAccount(window) && account.quotaCeilings?.[window.id] !== undefined);
  if (!windows?.length) return null;
  // UserPromptSubmit has no reliable active-model field, so the native hook only uses account-wide windows.
  return windows.filter((window) => quotaCeilingReached(account, window, now)).map((window) => {
    const expires = window.resetsAt ? Math.ceil(Date.parse(window.resetsAt) / 1000) : 0;
    const decision = {
      decision: "block",
      reason: `ZeroSub maximum reached for ${window.label} (${account.quotaCeilings?.[window.id]}%). Wait for the window to reset, choose another account, or raise the maximum in Accounts.`,
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
    };
    return `${expires}\n${JSON.stringify(decision)}\n`;
  }).join("");
}
