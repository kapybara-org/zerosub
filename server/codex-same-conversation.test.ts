import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SwitchRowSchema } from "../shared/timeline";
import type { AgentTimelineItem } from "./adapter";
import { codexHandoffMode, encryptedResumeFailure, sameWorkspace, turnFailedText, workspaceOutOfCredits } from "./codex-same-conversation";

const WS = "chatgpt|ws|a@example.com";
const SAME = "chatgpt|ws|b@example.com";
const OTHER = "chatgpt|other|b@example.com";
const EMAIL = "chatgpt-email|a@example.com|ws";

describe("sameWorkspace", () => {
  it("matches two members of one workspace and nothing else", () => {
    expect(sameWorkspace(WS, SAME)).toBe(true);
    expect(sameWorkspace(WS, OTHER)).toBe(false);
    expect(sameWorkspace(WS, EMAIL)).toBe(false);
    expect(sameWorkspace(EMAIL, "chatgpt-email|b@example.com|ws")).toBe(false);
    expect(sameWorkspace("chatgpt|ws", "chatgpt|ws|b@example.com")).toBe(false);
    expect(sameWorkspace(null, SAME)).toBe(false);
    expect(sameWorkspace(WS, WS)).toBe(true);
  });
});

describe("codexHandoffMode", () => {
  const ready = { enabled: true, sameWorkspace: true, sessionsShared: true, limitMessage: "You've hit your usage limit." };

  it("reloads the same agent only when every gate passes", () => {
    expect(codexHandoffMode(ready)).toBe("same-agent");
  });

  it.each([
    ["the option is off", { enabled: false }],
    ["the workspace differs", { sameWorkspace: false }],
    ["sessions are not shared", { sessionsShared: false }],
    ["the workspace is out of credits", { limitMessage: "Your workspace is out of credits. Add credits to continue." }],
  ])("opens a new tab when %s", (_name, patch) => {
    expect(codexHandoffMode({ ...ready, ...patch })).toBe("new-tab");
  });

  it("recognises the workspace credit limit and a failed encrypted resume", () => {
    expect(workspaceOutOfCredits("Your workspace is out of credits")).toBe(true);
    expect(workspaceOutOfCredits("You've hit your usage limit.")).toBe(false);
    expect(encryptedResumeFailure("invalid_encrypted_content")).toBe(true);
    expect(encryptedResumeFailure("organization_id mismatch")).toBe(true);
    expect(encryptedResumeFailure("Native account resume selected a different thread or provider")).toBe(true);
    expect(encryptedResumeFailure("could not decrypt the reasoning")).toBe(true);
    expect(encryptedResumeFailure("You've hit your usage limit.")).toBe(false);
    expect(encryptedResumeFailure("HistoryError: Transfer stopped: the recorded turn error cannot be classified safely")).toBe(false);
    expect(encryptedResumeFailure("failed to verify the config")).toBe(false);
  });

  it("reads the failure from the turn, not from an earlier reply", () => {
    const text = turnFailedText({
      outcome: { kind: "failed", error: { message: "invalid_encrypted_content" } },
      timeline: [
        { type: "assistant_message", text: "The last turn finished." },
        { type: "error", message: "organization_id mismatch" },
      ],
    });
    expect(encryptedResumeFailure(text)).toBe(true);
    expect(text).not.toContain("last turn");
  });

  it("reads back to this turn's prompt, and only the failure of a turn that never started", () => {
    const timeline: AgentTimelineItem[] = [
      { type: "user_message", text: "Repair the build." },
      { type: "assistant_message", text: "[System Error] invalid_encrypted_content" },
      { type: "user_message", text: "Carry on." },
      { type: "assistant_message", text: "The parser has been repaired." },
    ];
    expect(turnFailedText({ outcome: { kind: "completed" }, timeline, turnId: "turn-2" })).toBe("");
    const failed = { kind: "failed", error: { message: "connection reset" } };
    expect(turnFailedText({ outcome: failed, timeline: timeline.slice(0, 2), turnId: null })).toBe("connection reset");
  });
});

describe("switch row compatibility", () => {
  const row = {
    family: "codex" as const,
    from: "A",
    to: "B",
    reason: "limit" as const,
    resetsAt: null,
    continued: true,
    continuedIn: null,
    toFamily: null,
    outcome: "switched" as const,
    detail: null,
    at: "2026-11-15T00:00:00.000Z",
  };
  const older = z.object({
    family: z.string(),
    from: z.string().nullable(),
    to: z.string(),
    reason: z.string(),
    outcome: z.string(),
    at: z.string(),
  });

  it("keeps the same-conversation mark optional for older clients", () => {
    expect(SwitchRowSchema.parse(row).sameConversation).toBeUndefined();
    expect(SwitchRowSchema.parse({ ...row, sameConversation: true }).sameConversation).toBe(true);
    expect(older.safeParse({ ...row, sameConversation: true }).success).toBe(true);
  });
});
