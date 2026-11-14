// The nesting, tag-pairing and cut-off cases are adapted from liloli's tests in #14.
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./adapter";
import { buildTranscript, continuationPrompt, continueInNewAgent, keepEnds, shortenEarlierHandOff } from "./handoff";

const OPEN = "<previous-session>";
const CLOSE = "</previous-session>";

function user(text: string): AgentTimelineItem {
  return { type: "user_message", text } as AgentTimelineItem;
}

function agentPrompt(
  text: string,
  options: { event?: string; id?: string; title?: string; legacy?: boolean } = {},
): AgentTimelineItem {
  const { event = "message", id = "lead", title, legacy = false } = options;
  return {
    type: "tool_call",
    callId: "paseo-agent-message:msg-1",
    name: "agent_message",
    status: "completed",
    error: null,
    ...(!legacy
      ? {
          agentMessage: {
            event,
            sender: { id, ...(title ? { title } : {}) },
            text,
          },
        }
      : {}),
    detail: { type: "plain_text", text, icon: "bot" },
  } as AgentTimelineItem;
}

function heartbeatPrompt(text: string): AgentTimelineItem {
  return {
    type: "tool_call",
    callId: "paseo-system:schedule-run-1",
    name: "heartbeat",
    status: "completed",
    error: null,
    detail: { type: "plain_text", text, icon: "sparkles" },
  } as AgentTimelineItem;
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

describe("prompts from other agents and schedules", () => {
  it("writes an agent's or schedule's prompt into the transcript, and keeps the opening one when trimming", () => {
    const longAgent: AgentTimelineItem[] = [
      agentPrompt("Write the parser for the new format.", { id: "lead", title: "Lead the release" }),
      ...Array.from({ length: 120 }, (_, index): AgentTimelineItem => ({ type: "assistant_message", text: `step ${index} ${"x".repeat(100)}` })),
      agentPrompt("Only run the unit tests.", { legacy: true }),
    ];
    const trimmed = buildTranscript(longAgent, 4_000);
    expect(trimmed.startsWith("From Lead the release (lead) (original request): Write the parser for the new format.")).toBe(true);
    expect(trimmed).toContain("[… earlier conversation omitted …]");
    expect(trimmed).toContain("Agent: Only run the unit tests.");
    expect(trimmed).not.toContain("[agent_message]");

    const scheduled: AgentTimelineItem[] = [
      heartbeatPrompt("Run the nightly verification suite."),
      ...Array.from({ length: 80 }, (_, index): AgentTimelineItem => ({ type: "assistant_message", text: `check ${index} ${"y".repeat(100)}` })),
    ];
    const scheduledTranscript = buildTranscript(scheduled, 3_000);
    expect(scheduledTranscript.startsWith("Scheduled (original request): Run the nightly verification suite.")).toBe(true);
    expect(scheduledTranscript).not.toContain("[heartbeat]");
  });

  it("keeps a child finish notification's body without mistaking it for the opening request", () => {
    const timeline: AgentTimelineItem[] = [
      agentPrompt("Agent sub-1 (Write tests) finished.\n\n<agent-response>\nAdded 12 parser tests.\n</agent-response>", {
        event: "finished",
        id: "sub-1",
        title: "Write tests",
      }),
      user("Ship the release once the parser tests are merged."),
      ...Array.from({ length: 100 }, (_, index): AgentTimelineItem => ({ type: "assistant_message", text: `progress ${index} ${"z".repeat(100)}` })),
    ];
    const full = buildTranscript(timeline.slice(0, 2));
    expect(full).toContain("[agent_message: finished from Write tests (sub-1)]\nAgent sub-1 (Write tests) finished.");
    expect(full).toContain("Added 12 parser tests.");

    const trimmed = buildTranscript(timeline, 3_500);
    expect(trimmed.startsWith("User (original request): Ship the release once the parser tests are merged.")).toBe(true);
  });

  it("neutralises quoted session tags inside agent messages and finish notifications", () => {
    const quoted = continuationPrompt("From lead: ORIGINAL", "limit");
    const prompt = continuationPrompt(
      buildTranscript([
        agentPrompt(quoted, { id: "lead", title: "Lead" }),
        agentPrompt(`Child echoed ${OPEN}inner${CLOSE}`, { event: "finished", id: "sub", title: "Sub" }),
      ]),
      "limit",
    );
    expect(count(prompt, OPEN)).toBe(1);
    expect(count(prompt, CLOSE)).toBe(1);
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
    const paseo = {
      providers: { listModels: async () => ({ models: [{ id: "gpt-test", isDefault: true }] }) },
      workspaces: { ref: () => ({ agents: { create: async (request: Record<string, unknown>) => void created.push({ via: "workspace", request }) } }) },
      agents: {
        create: async (request: Record<string, unknown>) => void created.push({ via: "folder", request }),
        ref: () => ({
          refresh: async () => ({ agent: source }),
          timeline: { refetch: async () => ({ entries: [{ item: user("Write the parser for the new format.") }] }) },
        }),
      },
    } as unknown as PluginHookContext["paseo"];
    return { paseo, created };
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

  it("carries an orchestrator's agent_message instructions into the new agent's prompt", async () => {
    const { paseo, created } = fake("ws-1");
    paseo.agents.ref = (() => ({
      refresh: async () => ({
        agent: {
          id: "sub",
          provider: "codex",
          model: "gpt-test",
          title: "Write the parser",
          cwd: "/repo/packages/parser",
          workspaceId: "ws-1",
          currentModeId: "auto",
          labels: { "paseo.parent-agent-id": "lead" },
        },
      }),
      timeline: {
        refetch: async () => ({
          entries: [{ item: agentPrompt("Write the parser for the new format.", { id: "lead", title: "Lead" }) }],
        }),
      },
    })) as unknown as typeof paseo.agents.ref;
    await continueInNewAgent({ paseo, sourceAgentId: "sub", why: "its account reached its limit", parentId: "lead", bind: async () => {} });
    expect(created[0]!.request.prompt).toContain("From Lead (lead): Write the parser for the new format.");
    expect(created[0]!.request.prompt).not.toContain("[agent_message]");
  });
});
