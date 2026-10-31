import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./adapter";
import { parseUsage } from "./claude";
import { parseCredits, parseRateLimits } from "./codex";
import { buildTranscript, continuationPrompt } from "./handoff";

describe("Claude usage", () => {
  it("reads the subscription windows and model-scoped weekly limits", () => {
    const windows = parseUsage({
      five_hour: { utilization: 49, resets_at: "2026-09-23T08:00:00.599646+00:00" },
      seven_day: { utilization: 74, resets_at: "2026-09-25T10:00:00.599667+00:00" },
      seven_day_opus: null,
      limits: [{ kind: "weekly_scoped", percent: 21, resets_at: "2026-09-25T10:00:00Z", scope: { model: { display_name: "Fable" } } }],
    });
    expect(windows).toEqual([
      { id: "five_hour", label: "5-hour", usedPercent: 49, resetsAt: "2026-09-23T08:00:00.599Z" },
      { id: "seven_day", label: "Weekly", usedPercent: 74, resetsAt: "2026-09-25T10:00:00.599Z" },
      { id: "weekly_fable", label: "Weekly · Fable", usedPercent: 21, resetsAt: "2026-09-25T10:00:00.000Z" },
    ]);
  });

  it("tolerates missing or malformed data", () => {
    expect(parseUsage(null)).toEqual([]);
    expect(parseUsage({ five_hour: { utilization: null } })).toEqual([]);
  });
});

describe("Codex rate limits", () => {
  it("labels windows by their length, keeps the length and converts reset times", () => {
    expect(
      parseRateLimits({
        primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 1790150000 },
        secondary: { usedPercent: 84, windowDurationMins: 10080, resetsAt: 1790500000 },
      }),
    ).toEqual([
      { id: "primary", label: "5-hour", usedPercent: 42, resetsAt: new Date(1790150000 * 1000).toISOString(), minutes: 300 },
      { id: "secondary", label: "Weekly", usedPercent: 84, resetsAt: new Date(1790500000 * 1000).toISOString(), minutes: 10080 },
    ]);
    expect(parseRateLimits({ primary: null, secondary: { usedPercent: 5, windowDurationMins: null, resetsAt: null } })).toEqual([
      { id: "secondary", label: "Usage", usedPercent: 5, resetsAt: null, minutes: null },
    ]);
  });
});

describe("Codex credits", () => {
  it("reads the balance the plan falls back on", () => {
    expect(parseCredits({ credits: { hasCredits: true, unlimited: false, balance: "57714.9310050000" } })).toEqual({
      balance: 57714.931005,
      unlimited: false,
    });
    expect(parseCredits({ credits: { hasCredits: true, unlimited: true, balance: null } })).toEqual({ balance: null, unlimited: true });
    expect(parseCredits({ credits: { hasCredits: true, unlimited: false, balance: "0.25" } })).toEqual({ balance: 0.25, unlimited: false });
  });

  it("has none to offer when there are none, they're used up, or the spend cap is reached", () => {
    expect(parseCredits({ credits: { hasCredits: false, unlimited: false, balance: "0" } })).toBeNull();
    expect(parseCredits({ credits: { hasCredits: true, unlimited: false, balance: "0.0000000000" } })).toBeNull();
    expect(parseCredits({ credits: { hasCredits: true, unlimited: false, balance: "-12.5" } })).toBeNull();
    expect(parseCredits({ credits: null })).toBeNull();
    expect(parseCredits({ spendControlReached: true, credits: { hasCredits: true, unlimited: false, balance: "10" } })).toBeNull();
    expect(parseCredits(null)).toBeNull();
  });
});

describe("hand-off transcript", () => {
  const timeline: AgentTimelineItem[] = [
    { type: "user_message", text: "Add dark mode to the settings page." },
    { type: "reasoning", text: "private chain of thought" },
    { type: "assistant_message", text: "I'll start with the theme tokens." },
    {
      type: "tool_call",
      callId: "1",
      name: "shell",
      status: "completed",
      error: null,
      detail: { type: "shell", command: "npm test", exitCode: 1 },
    } as AgentTimelineItem,
    {
      type: "tool_call",
      callId: "2",
      name: "edit",
      status: "completed",
      error: null,
      detail: { type: "edit", filePath: "src/theme.ts" },
    } as AgentTimelineItem,
    { type: "todo", items: [{ text: "Theme tokens", completed: true }, { text: "Toggle UI", completed: false }] },
  ];

  it("keeps the conversation and actions, drops reasoning", () => {
    const transcript = buildTranscript(timeline);
    expect(transcript).toContain("User: Add dark mode to the settings page.");
    expect(transcript).toContain("Assistant: I'll start with the theme tokens.");
    expect(transcript).toContain("[ran `npm test` → exit 1]");
    expect(transcript).toContain("[edited src/theme.ts]");
    expect(transcript).toContain("- [x] Theme tokens\n- [ ] Toggle UI");
    expect(transcript).not.toContain("chain of thought");
  });

  it("keeps the original request when trimming a long history", () => {
    const long: AgentTimelineItem[] = [
      { type: "user_message", text: "The original task." },
      ...Array.from({ length: 200 }, (_, index): AgentTimelineItem => ({ type: "assistant_message", text: `step ${index} ${"x".repeat(200)}` })),
    ];
    const transcript = buildTranscript(long, 5_000);
    expect(transcript.startsWith("User (original request): The original task.")).toBe(true);
    expect(transcript).toContain("[… earlier conversation omitted …]");
    expect(transcript).toContain("step 199");
    expect(transcript.length).toBeLessThan(5_500);
  });

  it("explains why the work moved", () => {
    const prompt = continuationPrompt("User: hi", "its ChatGPT account (work) reached its usage limit");
    expect(prompt).toContain("stopped because its ChatGPT account (work) reached its usage limit");
    expect(prompt).toContain("<previous-session>\nUser: hi\n</previous-session>");
  });
});
