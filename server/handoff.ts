import { randomUUID } from "node:crypto";
import type { AgentTimelineItem } from "@getpaseo/protocol/agent-types";
import type { PluginHookContext } from "@getpaseo/plugin/server";

type PaseoApi = PluginHookContext["paseo"];

/** Label on a continuation agent naming the agent it carries on from. */
export const CONTINUED_FROM_LABEL = "zerosub.continued-from";

const MAX_TRANSCRIPT = 40_000;
const MAX_FIRST_MESSAGE = 6_000;

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

function describeTool(item: Extract<AgentTimelineItem, { type: "tool_call" }>): string {
  const detail = item.detail;
  const failed = item.status === "failed" ? " (failed)" : "";
  switch (detail.type) {
    case "shell": {
      const exit = detail.exitCode === undefined || detail.exitCode === null ? "" : ` → exit ${detail.exitCode}`;
      return `[ran \`${clip(detail.command, 200)}\`${exit}]`;
    }
    case "read":
      return `[read ${detail.filePath}]`;
    case "edit":
      return `[edited ${detail.filePath}${failed}]`;
    case "write":
      return `[wrote ${detail.filePath}${failed}]`;
    case "search":
      return `[searched: ${clip(detail.query, 120)}]`;
    case "plan":
      return `[plan]\n${clip(detail.text, 2_000)}`;
    default:
      return `[${item.name}${failed}]`;
  }
}

/**
 * A readable account of what happened in a conversation, for a fresh agent to pick up from.
 * Keeps the opening request and the most recent history; drops reasoning and tool output.
 */
export function buildTranscript(timeline: readonly AgentTimelineItem[], max = MAX_TRANSCRIPT): string {
  const lines: string[] = [];
  let firstUser: string | null = null;
  let todos: string | null = null;
  for (const item of timeline) {
    switch (item.type) {
      case "user_message":
        if (firstUser === null) firstUser = clip(item.text, MAX_FIRST_MESSAGE);
        lines.push(`User: ${item.text.trim()}`);
        break;
      case "assistant_message":
        if (item.text.trim()) lines.push(`Assistant: ${item.text.trim()}`);
        break;
      case "tool_call":
        lines.push(describeTool(item));
        break;
      case "todo":
        todos = item.items.map((task) => `- [${task.completed ? "x" : " "}] ${task.text}`).join("\n");
        break;
      default:
        break;
    }
  }
  let body = lines.join("\n\n");
  if (body.length > max) {
    const tail = body.slice(body.length - max);
    const start = tail.indexOf("\n\n");
    body = `${firstUser ? `User (original request): ${firstUser}\n\n` : ""}[… earlier conversation omitted …]\n\n${
      start >= 0 ? tail.slice(start + 2) : tail
    }`;
  }
  return todos ? `${body}\n\nTask list at the time it stopped:\n${todos}` : body;
}

export function continuationPrompt(transcript: string, why: string, previous = "Codex"): string {
  return [
    `This task is continuing from an earlier ${previous} session that stopped because ${why}.`,
    "The working directory already contains every change that session made. Here is its conversation, oldest first:",
    "",
    "<previous-session>",
    transcript,
    "</previous-session>",
    "",
    "Pick up exactly where it left off. Check the current state of the files before changing anything, and don't redo finished work.",
  ].join("\n");
}

async function defaultModel(paseo: PaseoApi, provider: string): Promise<string | null> {
  try {
    const { models } = await paseo.providers.listModels(provider);
    return (models?.find((entry) => entry.isDefault) ?? models?.[0])?.id ?? null;
  } catch {
    return null;
  }
}

export interface Continuation {
  agentId: string;
  title: string;
}

/** Another provider to continue on, instead of the source agent's own. */
export interface ContinuationTarget {
  /** Paseo provider ID, e.g. `codex`. */
  provider: string;
  /** Its name for people, used in the new agent's title, e.g. `ChatGPT`. */
  label: string;
  /** A mode no more permissive than the source agent's. */
  modeId: string;
}

/**
 * Starts a new agent in the same workspace, pre-bound to another account, and hands it the
 * conversation so far. Used where a thread cannot move between accounts (Codex encrypts its
 * reasoning per ChatGPT account, so the old thread would be rejected by the new one), and to carry
 * work over to the other provider when every account of one is out.
 */
export async function continueInNewAgent(options: {
  paseo: PaseoApi;
  sourceAgentId: string;
  timeline?: readonly AgentTimelineItem[];
  why: string;
  bind(agentId: string): Promise<void>;
  target?: ContinuationTarget;
  /** What to call the session that stopped, e.g. `Claude Code`. */
  previous?: string;
}): Promise<Continuation> {
  const { paseo, sourceAgentId } = options;
  const refreshed = await paseo.agents.ref(sourceAgentId).refresh();
  const source = refreshed?.agent;
  if (!source) throw new Error("The original agent is no longer available.");

  let timeline = options.timeline;
  if (!timeline) {
    const page = await paseo.agents.ref(sourceAgentId).timeline.refetch({ direction: "tail", limit: 500 });
    timeline = page.entries.map((entry) => entry.item);
  }

  // The SDK needs "provider/model"; an agent created with the provider default may not record one.
  // Another provider's agent starts on that provider's default model.
  const { target } = options;
  const provider = target?.provider ?? source.provider;
  const model = target
    ? await defaultModel(paseo, provider)
    : (source.model ?? source.runtimeInfo?.model ?? (await defaultModel(paseo, provider)));
  if (!model) throw new Error(`Couldn't tell which ${provider} model to use for the new agent.`);

  const agentId = randomUUID();
  await options.bind(agentId);
  const title = target
    ? `${source.title?.trim() || "Task"} (continued on ${target.label})`
    : `${source.title?.trim() || "Codex task"} (continued)`;
  // Modes and thinking options are provider-specific: only carry them over within one provider.
  const config = target
    ? { provider: `${provider}/${model}`, modeId: target.modeId }
    : {
        provider: `${provider}/${model}`,
        ...(source.currentModeId ? { modeId: source.currentModeId } : {}),
        ...(source.thinkingOptionId ? { thinkingOptionId: source.thinkingOptionId } : {}),
      };
  const request = {
    agentId,
    config,
    title,
    prompt: continuationPrompt(buildTranscript(timeline), options.why, options.previous),
    labels: { [CONTINUED_FROM_LABEL]: sourceAgentId },
  };
  if (source.workspaceId) await paseo.workspaces.ref(source.workspaceId).agents.create(request);
  else await paseo.agents.create({ ...request, cwd: source.cwd });
  return { agentId, title };
}
