/**
 * Opt-in handoff for two ChatGPT members of one workspace. `sameAccountIdentity` stays exact:
 * different emails in one workspace are different accounts. This only asks whether the workspace
 * id is the same, and only for keys shaped `chatgpt|<workspace>|<email>`.
 */

/** `chatgpt|<workspace>|<email>`. An email-only key, or a workspace id with no member, is not one. */
const WORKSPACE_MEMBER = /^chatgpt\|([^|]+)\|([^|]+)$/;
const WORKSPACE_CREDITS = /^Your workspace is out of credits\b/i;
const RESUME_FAILURE =
  /invalid_encrypted_content|organization[_ ]id mismatch|unable to decrypt|could not decrypt|can(?:no|')t decrypt|decryption failed|failed to decrypt|failed to verify (?:the )?encrypted|Native account resume selected a different thread or provider|Native resume selected a different provider/i;

export type CodexHandoff = "same-agent" | "new-tab";

export function sameWorkspace(left: string | null | undefined, right: string | null | undefined): boolean {
  const a = left ? WORKSPACE_MEMBER.exec(left) : null;
  const b = right ? WORKSPACE_MEMBER.exec(right) : null;
  if (!a?.[1] || !b?.[1]) return false;
  return a[1] === b[1];
}

export function workspaceOutOfCredits(message: string): boolean {
  return WORKSPACE_CREDITS.test(message.trim());
}

/**
 * Same-agent only when the option is on, both accounts are members of one workspace, the
 * destination home really shares `sessions/`, and the limit is not the workspace credit pool.
 * Anything else keeps today's new tab.
 */
export function codexHandoffMode(input: {
  enabled: boolean;
  sameWorkspace: boolean;
  sessionsShared: boolean;
  limitMessage: string;
}): CodexHandoff {
  if (!input.enabled || !input.sameWorkspace || !input.sessionsShared) return "new-tab";
  if (workspaceOutOfCredits(input.limitMessage)) return "new-tab";
  return "same-agent";
}

/** Text Codex or a native resume shows when the other account cannot read this thread. */
export function encryptedResumeFailure(text: string): boolean {
  return RESUME_FAILURE.test(text);
}

/** The failure notices of one turn, not its ordinary replies. */
export function turnFailedText(event: {
  outcome: { kind: string; error?: { message?: string } | null };
  timeline?: ReadonlyArray<{ type: string; message?: string; text?: string }>;
}): string {
  const parts: string[] = [];
  if (event.outcome.kind === "failed" && event.outcome.error?.message) parts.push(event.outcome.error.message);
  for (const item of event.timeline ?? []) {
    if (item.type === "error" && item.message) parts.push(item.message);
    else if (item.type === "assistant_message" && item.text && /^\[System Error\]/.test(item.text)) parts.push(item.text);
  }
  return parts.join("\n");
}
