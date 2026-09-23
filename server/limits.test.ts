import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import { describe, expect, it } from "vitest";
import {
  detectClaudeLimit,
  detectClaudeSignOut,
  detectCodexLimit,
  detectCodexSignOut,
  parseClaudeReset,
  parseCodexReset,
} from "./limits";

const completed = { kind: "completed" } as const;
const failed = (message: string) => ({ kind: "failed", error: { message } }) as const;

function turn(...texts: string[]): AgentTimelineItem[] {
  return [
    { type: "user_message", text: "fix the bug" },
    ...texts.map((text): AgentTimelineItem => ({ type: "assistant_message", text })),
  ];
}

// 2026-09-23 10:00 in Asia/Kolkata (UTC+5:30).
const NOW = new Date("2026-09-23T04:30:00Z");

describe("detectClaudeLimit", () => {
  it("recognises a session limit in a completed turn", () => {
    const hit = detectClaudeLimit(
      { outcome: completed, timeline: turn("Working on it.", "You've hit your session limit · resets 3pm (Asia/Kolkata)") },
      NOW,
    );
    expect(hit?.message).toBe("You've hit your session limit · resets 3pm (Asia/Kolkata)");
    expect(hit?.resetsAt).toBe("2026-09-23T09:30:00.000Z");
  });

  it("recognises weekly and model limits with a date", () => {
    const hit = detectClaudeLimit(
      { outcome: completed, timeline: turn("You've hit your weekly limit · resets Sep 25, 3pm (America/New_York)") },
      NOW,
    );
    expect(hit?.resetsAt).toBe("2026-09-25T19:00:00.000Z");
    expect(detectClaudeLimit({ outcome: completed, timeline: turn("You've hit your Opus limit · resets 4:30am (UTC)") }, NOW)?.resetsAt).toBe(
      "2026-09-24T04:30:00.000Z",
    );
    expect(detectClaudeLimit({ outcome: completed, timeline: turn("You've reached your Fable limit.") }, NOW)).not.toBeNull();
  });

  it("recognises the legacy epoch form and failed turns", () => {
    const hit = detectClaudeLimit({ outcome: failed("Claude AI usage limit reached|1790150000"), timeline: [] }, NOW);
    expect(hit?.resetsAt).toBe(new Date(1790150000 * 1000).toISOString());
    const system = detectClaudeLimit(
      { outcome: completed, timeline: turn("[System Error] You're out of usage credits · resets 5pm (UTC)") },
      NOW,
    );
    expect(system).not.toBeNull();
  });

  it("ignores warnings, capacity errors and prose about limits", () => {
    const cases = [
      "You've used 85% of your session limit · resets 3pm (Asia/Kolkata)",
      "You're close to your usage credit limit",
      "API Error: Server is temporarily limiting requests (not your usage limit) · Retrying",
      `I added a rate limiter. ${"x".repeat(700)}\nYou've hit your session limit is what users will see.`,
    ];
    for (const text of cases) {
      expect(detectClaudeLimit({ outcome: completed, timeline: turn(text) }, NOW)).toBeNull();
    }
  });

  it("only looks at the latest turn", () => {
    const timeline: AgentTimelineItem[] = [
      ...turn("You've hit your session limit · resets 3pm (Asia/Kolkata)"),
      { type: "user_message", text: "continue" },
      { type: "assistant_message", text: "Done." },
    ];
    expect(detectClaudeLimit({ outcome: completed, timeline }, NOW)).toBeNull();
  });

  it("recognises every wording Claude Code 2.1.280 uses", () => {
    const windows = [
      "You've hit your limit · resets 3pm (Asia/Kolkata)",
      "You’ve hit your session limit · resets 3pm (Asia/Kolkata) · progress saved",
      "You've hit your Sonnet limit · resets Sep 25, 3pm (UTC)",
    ];
    for (const text of windows) {
      expect(detectClaudeLimit({ outcome: completed, timeline: turn(text) }, NOW)?.kind).toBe("window");
    }
    const budgets = [
      "You've hit your org's monthly spend limit",
      "You've hit your channel's monthly spend limit · contact your admin to increase it",
      "You've hit your channel's monthly usage limit",
      "You've hit your usage credit limit · resets Oct 1, 12am (UTC)",
      "You've hit your team's shared budget",
      "Your org is out of usage · add funds to continue",
      "Your seat type doesn't include usage credits",
    ];
    for (const text of budgets) {
      expect(detectClaudeLimit({ outcome: completed, timeline: turn(text) }, NOW)?.kind).toBe("budget");
    }
  });

  it("does not mistake ordinary replies for limits", () => {
    const replies = [
      "You've hit your GitHub API rate limit. Wait an hour and try again.",
      "You've reached your free tier limit on Vercel. Upgrade to deploy more.",
      "You've hit your session limit is what users will see after this change.",
    ];
    for (const text of replies) {
      expect(detectClaudeLimit({ outcome: completed, timeline: turn(text) }, NOW)).toBeNull();
    }
  });

  it("ignores limit wording earlier in a turn than the final replies", () => {
    const timeline = turn("You've hit your session limit · resets 3pm (UTC)", "Retried with a backoff.", "All done.");
    expect(detectClaudeLimit({ outcome: completed, timeline }, NOW)).toBeNull();
  });
});

describe("detectCodexLimit", () => {
  it("recognises the ChatGPT plan limit with a typographic apostrophe", () => {
    const hit = detectCodexLimit(
      {
        outcome: failed(
          "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 3:45 PM.",
        ),
        timeline: [],
      },
      new Date(2026, 8, 23, 10, 0),
    );
    expect(hit).not.toBeNull();
    expect(hit?.resetsAt).toBe(new Date(2026, 8, 23, 15, 45).toISOString());
  });

  it("recognises workspace credit exhaustion as a budget limit", () => {
    const hit = detectCodexLimit({ outcome: failed("Your workspace is out of credits. Ask your admin."), timeline: [] }, NOW);
    expect(hit?.kind).toBe("budget");
  });

  it("reads Paseo's system error rows", () => {
    const timeline = turn("[System Error] You’ve hit your usage limit. Try again at 3:45 PM.");
    expect(detectCodexLimit({ outcome: completed, timeline }, NOW)?.kind).toBe("window");
  });

  it("ignores unrelated failures and anything the model itself wrote", () => {
    expect(detectCodexLimit({ outcome: failed("stream disconnected before completion"), timeline: [] }, NOW)).toBeNull();
    expect(detectCodexLimit({ outcome: completed, timeline: turn("All tests pass.") }, NOW)).toBeNull();
    for (const reply of [
      "I added a retry branch for `usage_limit_reached` responses.",
      "Handled the usageLimitExceeded case in the client.",
      "You’ve hit your usage limit is the message users now see.",
    ]) {
      expect(detectCodexLimit({ outcome: completed, timeline: turn(reply) }, NOW)).toBeNull();
    }
  });
});

describe("reset parsing", () => {
  it("rolls a time that already passed today over to tomorrow", () => {
    expect(parseClaudeReset("resets 9am (Asia/Kolkata)", NOW)).toBe("2026-09-24T03:30:00.000Z");
    expect(parseCodexReset("try again at 9:00 AM.", new Date(2026, 8, 23, 10, 0))).toBe(new Date(2026, 8, 24, 9, 0).toISOString());
  });

  it("reads an explicit date and year from Codex", () => {
    expect(parseCodexReset("try again at Sep 29, 2026 3:45 PM.", NOW)).toBe(new Date(2026, 8, 29, 15, 45).toISOString());
  });

  it("returns null when there is no time", () => {
    expect(parseClaudeReset("You've hit your session limit · contact your admin to increase it", NOW)).toBeNull();
    expect(parseCodexReset("You’ve hit your usage limit.", NOW)).toBeNull();
  });
});

describe("sign-in failures", () => {
  it("recognises expired Claude logins", () => {
    expect(detectClaudeSignOut({ outcome: completed, timeline: turn("Not logged in · Please run /login") })).not.toBeNull();
    expect(
      detectClaudeSignOut({ outcome: completed, timeline: turn("Failed to authenticate. API Error: 401 OAuth access token is invalid.") }),
    ).not.toBeNull();
    expect(detectClaudeSignOut({ outcome: completed, timeline: turn("The login form now validates emails.") })).toBeNull();
  });

  it("recognises a revoked Codex refresh token", () => {
    const message =
      "Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.";
    expect(detectCodexSignOut({ outcome: failed(message), timeline: [] })).not.toBeNull();
    expect(detectCodexSignOut({ outcome: failed("stream disconnected"), timeline: [] })).toBeNull();
  });
});
