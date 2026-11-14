// The nesting, tag-pairing and cut-off cases are adapted from liloli's tests in #14.
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./adapter";
import { buildTranscript, continuationPrompt, continueInNewAgent, keepEnds, shortenEarlierHandOff, updatePrompt } from "./handoff";

const OPEN = "<previous-session>";
const CLOSE = "</previous-session>";

function user(text: string): AgentTimelineItem {
  return { type: "user_message", text } as AgentTimelineItem;
}

function count(text: string, tag: string): number {
  return text.split(tag).length - 1;
}

describe("keeping both ends of a long text", () => {
  it("leaves a short text alone", () => {
    expect(keepEnds("short", 10)).toBe("short");
  });

  it("keeps the start and a larger end within the budget, marking the cut", () => {
    const kept = keepEnds(`START${"a".repeat(5_000)}${"b".repeat(5_000)}END`, 3_000, "[cut]");
    expect(kept.length).toBeLessThanOrEqual(3_000);
    expect(kept).toMatch(/^STARTa+\n\n\[cut\]\n\nb+END$/);
    expect(kept.split("b").length).toBeGreaterThan(kept.split("a").length);
  });
});

describe("quoting an earlier hand-off", () => {
  it("leaves a message without one alone", () => {
    expect(shortenEarlierHandOff("Fix the build")).toBe("Fix the build");
  });

  it("keeps the earlier session's original request and where it left off", () => {
    const earlier = continuationPrompt(buildTranscript([user("ORIGINAL: fix the build"), user(`${"x".repeat(30_000)} LEFT OFF HERE`)]), "limit");
    const shortened = shortenEarlierHandOff(earlier);
    expect(shortened).toContain("ORIGINAL: fix the build");
    expect(shortened).toContain("LEFT OFF HERE");
    expect(shortened).toContain("[… middle of that earlier session omitted …]");
    expect(shortened.length).toBeLessThan(7_000);
  });

  it("keeps the original request but not every earlier session nested inside the next", () => {
    let prompt = continuationPrompt(buildTranscript([user("ORIGINAL: fix the build"), user("x".repeat(30_000))]), "limit");
    for (let hop = 0; hop < 4; hop += 1) {
      prompt = continuationPrompt(buildTranscript([user(prompt), user(`hop ${hop} ${"y".repeat(30_000)} end of hop ${hop}`)]), "limit");
    }
    expect(prompt).toContain("ORIGINAL: fix the build");
    expect(prompt).toContain("hop 3");
    // Where the previous session left off survives too.
    expect(prompt).toContain("end of hop 2");
    expect(prompt.length).toBeLessThan(45_000);
    expect(count(prompt, OPEN)).toBe(1);
    expect(count(prompt, CLOSE)).toBe(1);
  });

  it("keeps its tags paired however deep the nesting and wherever the cut falls", () => {
    for (const filler of [10, 1_000, 1_990, 2_500, 5_990, 7_000]) {
      // Older releases quoted earlier sessions with their tags intact.
      let prompt = continuationPrompt("User: ORIGINAL", "limit");
      for (let hop = 0; hop < 5; hop += 1) {
        prompt = continuationPrompt(`User: ${"f".repeat(filler)}\n${prompt}`, "limit");
      }
      const shortened = shortenEarlierHandOff(prompt);
      expect(count(shortened, OPEN)).toBe(1);
      expect(count(shortened, CLOSE)).toBe(1);
      // Inside the outer block, nothing can close it early.
      const body = shortened.slice(shortened.indexOf(OPEN) + OPEN.length, shortened.lastIndexOf(CLOSE));
      expect(body).not.toMatch(/<\/?previous-session>/);
      expect(shortened).toContain("ORIGINAL");
    }
  });

  it("copes with an earlier hand-off that was cut off before its end", () => {
    const shortened = shortenEarlierHandOff(`Carry on.\n${OPEN}\nUser: ORIGINAL\n${"z".repeat(10_000)} LAST`);
    expect(shortened).toContain("User: ORIGINAL");
    expect(shortened).toContain("LAST");
    expect(shortened).toContain(CLOSE);
    expect(shortened.length).toBeLessThan(6_200);
  });

  it("never leaves a quoted tag that the outer prompt's pair would trip over", () => {
    const quoted = continuationPrompt(buildTranscript([user("ORIGINAL"), user("z".repeat(50_000))]), "limit");
    const transcript = buildTranscript([user(quoted), user("y".repeat(50_000))], 10_000);
    expect(transcript).not.toMatch(/<\/?previous-session>/);
  });
});

describe("clipping a transcript", () => {
  it("keeps the latest stop instruction last, after the omitted progress", () => {
    const transcript = buildTranscript([
      user("Fix the build"),
      user("STOP, DO NOT MODIFY ANYTHING"),
      { type: "assistant_message", text: "a".repeat(50_000) },
    ]);
    expect(transcript).toContain("User (original request): Fix the build");
    expect(transcript).toContain("User (latest instruction): STOP, DO NOT MODIFY ANYTHING");
    expect(transcript).toContain("[… earlier conversation omitted …]");
    expect(transcript.indexOf("STOP, DO NOT MODIFY ANYTHING")).toBeGreaterThan(
      transcript.indexOf("[… earlier conversation omitted …]"),
    );
    // The summary reorders older progress around the latest instruction, so it can't claim a
    // strictly oldest-first reading.
    expect(continuationPrompt(transcript, "a limit")).not.toContain("oldest first");
  });

  it("keeps both ends of a long latest instruction", () => {
    const transcript = buildTranscript([
      user("Fix the build"),
      { type: "assistant_message", text: "a".repeat(50_000) },
      user(`${"Check each step. ".repeat(600)}STOP, DO NOT MODIFY ANYTHING`),
    ]);
    const latest = transcript.slice(transcript.indexOf("User (latest instruction):"));
    expect(latest).toContain("STOP, DO NOT MODIFY ANYTHING");
    expect(latest).toContain("[… omitted …]");
    expect(latest.length).toBeLessThan(6_200);
  });

  it("keeps the latest stop instruction after the older instructions and the todo snapshot", () => {
    const transcript = buildTranscript([
      user("Fix the build"),
      { type: "assistant_message", text: "a".repeat(50_000) },
      user("CONTINUE EVERYTHING"),
      { type: "todo", items: [{ text: "Ship it", completed: false }] },
      user("STOP, DO NOT MODIFY ANYTHING"),
    ]);
    expect(transcript).toContain("User: CONTINUE EVERYTHING");
    expect(transcript.indexOf("CONTINUE EVERYTHING")).toBeLessThan(transcript.indexOf("User (latest instruction): STOP"));
    expect(transcript.indexOf("Task list at the time it stopped:")).toBeLessThan(
      transcript.indexOf("User (latest instruction): STOP"),
    );
  });

  it("keeps a terminal stop when the only user message is the latest one, after the todo snapshot", () => {
    const transcript = buildTranscript([
      user(`${"Please do the work. ".repeat(400)}STOP, DO NOT MODIFY ANYTHING`),
      { type: "todo", items: [{ text: "Ship it", completed: false }] },
      { type: "assistant_message", text: "a".repeat(50_000) },
    ]);
    expect(transcript).toMatch(/User \(original request and latest instruction\):[\s\S]*STOP, DO NOT MODIFY ANYTHING$/);
    expect(transcript).toContain("[… omitted …]");
    expect(transcript.indexOf("Task list at the time it stopped:")).toBeLessThan(transcript.indexOf("STOP, DO NOT MODIFY ANYTHING"));
    expect(transcript.match(/Please do the work\./g)!.length).toBeLessThan(400);
  });
});

describe("ordering and bounds", () => {
  it("puts a short latest STOP after an older todo snapshot", () => {
    const transcript = buildTranscript([
      user("Fix the build"),
      { type: "todo", items: [{ text: "Ship it", completed: false }] },
      user("STOP"),
    ]);
    expect(transcript.indexOf("Task list at the time it stopped:")).toBeLessThan(transcript.indexOf("STOP"));
    expect(transcript).toMatch(/STOP$/);
    expect(transcript).toContain("User: Fix the build");
  });

  it("leaves a short transcript without todos in conversation order", () => {
    expect(buildTranscript([user("Fix the build"), { type: "assistant_message", text: "Done." }])).toBe("User: Fix the build\n\nAssistant: Done.");
  });

  it("tells the new agent to follow a stop or pause instruction instead of resuming", () => {
    expect(continuationPrompt("User: STOP", "a limit")).toMatch(/stop or pause/);
  });

  it("keeps an oversized todo inside the transcript budget", () => {
    const transcript = buildTranscript([
      user("Fix the build"),
      { type: "todo", items: [{ text: "t".repeat(200_000), completed: false }] },
      user("STOP, DO NOT MODIFY ANYTHING"),
    ]);
    expect(transcript.length).toBeLessThanOrEqual(40_000);
    expect(transcript).toContain("[… omitted …]");
    expect(transcript).toMatch(/STOP, DO NOT MODIFY ANYTHING$/);
  });

  it("keeps a long history with an oversized todo inside the budget", () => {
    const transcript = buildTranscript([
      user("Fix the build"),
      { type: "assistant_message", text: "a".repeat(50_000) },
      { type: "todo", items: [{ text: "t".repeat(200_000), completed: false }] },
      user("STOP, DO NOT MODIFY ANYTHING"),
    ]);
    expect(transcript.length).toBeLessThanOrEqual(40_000);
    expect(transcript).toMatch(/User \(latest instruction\): STOP, DO NOT MODIFY ANYTHING$/);
  });
});

describe("an update for an existing fork", () => {
  it("puts the user's instructions after the older progress", () => {
    const prompt = updatePrompt("User: STOP", "Assistant: Continuing.\n\nTask list at the time it stopped:\n- [ ] Ship it", "Claude Code", "zerosub transfer m1");
    expect(prompt.indexOf("<progress-updates>")).toBeLessThan(prompt.indexOf("<user-updates>"));
    expect(prompt.indexOf("- [ ] Ship it")).toBeLessThan(prompt.indexOf("User: STOP"));
    expect(prompt.endsWith("zerosub transfer m1")).toBe(true);
  });
});

describe("starting the new agent", () => {
  /** A source agent, a sub-agent of `lead`, and the creates Paseo receives for its continuation. */
  function fake(workspaceId?: string) {
    const source = {
      id: "sub", provider: "codex", model: "gpt-test", title: "Write the parser", cwd: "/repo/packages/parser",
      ...(workspaceId ? { workspaceId } : {}), currentModeId: "auto", labels: { "paseo.parent-agent-id": "lead" },
    };
    const created: Array<{ via: "workspace" | "folder"; request: Record<string, unknown> }> = [];
    let modelLookups = 0;
    const paseo = {
      providers: {
        listModels: async () => {
          modelLookups += 1;
          return { models: [{ id: "gpt-test", isDefault: true }] };
        },
      },
      workspaces: { ref: () => ({ agents: { create: async (request: Record<string, unknown>) => void created.push({ via: "workspace", request }) } }) },
      agents: {
        create: async (request: Record<string, unknown>) => void created.push({ via: "folder", request }),
        ref: () => ({
          refresh: async () => ({ agent: source }),
          timeline: { refetch: async () => ({ entries: [{ item: user("Write the parser for the new format.") }] }) },
        }),
      },
    } as unknown as PluginHookContext["paseo"];
    return { paseo, created, modelLookups: () => modelLookups };
  }

  it("makes it a sub-agent of the given parent by label, and still hands over in its own prompt", async () => {
    const { paseo, created } = fake("ws-1");
    await continueInNewAgent({ paseo, sourceAgentId: "sub", why: "its account reached its limit", parentId: "lead", bind: async () => {} });
    expect(created).toHaveLength(1);
    expect(created[0]!.via).toBe("workspace");
    expect(created[0]!.request.labels).toEqual({ "zerosub.continued-from": "sub", "paseo.parent-agent-id": "lead" });
    // `parent` would send the prompt as a message from the lead agent instead.
    expect(created[0]!.request).not.toHaveProperty("parent");
    expect(created[0]!.request.prompt).toContain("Write the parser for the new format.");
  });

  it("does the same for an agent outside a workspace, in its own folder", async () => {
    const { paseo, created } = fake();
    await continueInNewAgent({ paseo, sourceAgentId: "sub", why: "a limit", deferPrompt: true, parentId: "lead", bind: async () => {} });
    expect(created).toHaveLength(1);
    expect(created[0]!.via).toBe("folder");
    expect(created[0]!.request.cwd).toBe("/repo/packages/parser");
    expect(created[0]!.request.labels).toEqual({ "zerosub.continued-from": "sub", "paseo.parent-agent-id": "lead" });
    expect(created[0]!.request).not.toHaveProperty("parent");
    expect(created[0]!.request).not.toHaveProperty("prompt");
  });

  it("labels it only as a continuation when there's no parent to give it", async () => {
    const { paseo, created } = fake("ws-1");
    await continueInNewAgent({ paseo, sourceAgentId: "sub", why: "a limit", deferPrompt: true, bind: async () => {} });
    expect(created[0]!.request.labels).toEqual({ "zerosub.continued-from": "sub" });
  });

  it("uses the target's model and thinking option when a fork picks them", async () => {
    const { paseo, created, modelLookups } = fake("ws-1");
    await continueInNewAgent({
      paseo,
      sourceAgentId: "sub",
      why: "a limit",
      bind: async () => {},
      target: { provider: "opencode", label: "OpenCode", modeId: "build", model: "opencode/glm-5p3-flash", thinkingOptionId: "high" },
    });
    expect(created[0]!.request.config).toEqual({
      provider: "opencode/opencode/glm-5p3-flash",
      modeId: "build",
      thinkingOptionId: "high",
    });
    expect(modelLookups()).toBe(0); // a catalog model was picked: no default lookup
    expect(created[0]!.request.title).toBe("Write the parser (continued on OpenCode)");
  });

  it("falls back to the provider's default model when the target picks none", async () => {
    const { paseo, created } = fake("ws-1");
    await continueInNewAgent({
      paseo,
      sourceAgentId: "sub",
      why: "a limit",
      bind: async () => {},
      target: { provider: "codex", label: "ChatGPT", modeId: "auto" },
    });
    expect(created[0]!.request.config).toEqual({ provider: "codex/gpt-test", modeId: "auto" });
  });
});
