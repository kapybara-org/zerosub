import { randomUUID } from "node:crypto";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import type { AgentTimelineItem } from "./adapter";

type PaseoApi = PluginHookContext["paseo"];

/** Label on a continuation agent naming the agent it carries on from. */
export const CONTINUED_FROM_LABEL = "zerosub.continued-from";
/** Paseo's label naming the agent a sub-agent was created by (`PARENT_AGENT_ID_LABEL`). */
export const PARENT_LABEL = "paseo.parent-agent-id";

const MAX_TRANSCRIPT = 40_000;
const MAX_FIRST_MESSAGE = 6_000;
const MAX_EARLIER_HANDOFF = 6_000;

const OPEN = "<previous-session>";
const CLOSE = "</previous-session>";

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max)}…`;
}

/**
 * Fits a long text into `max` characters by keeping its start (where the request usually is) and
 * its end (the most recent context), with a marker where the middle was cut. The end gets more room.
 */
export function keepEnds(text: string, max: number, marker = "[… omitted …]"): string {
  if (text.length <= max) return text;
  const room = Math.max(0, max - marker.length - 4);
  const head = Math.floor(room / 3);
  return `${text.slice(0, head).trimEnd()}\n\n${marker}\n\n${text.slice(text.length - (room - head)).trimStart()}`;
}

/** Tags become plain words, so a quote can't open or close the block around it. */
function neutralise(text: string): string {
  return text.replaceAll(OPEN, "[earlier session:").replaceAll(CLOSE, "]");
}

/**
 * A continuation's first message quotes the session before it. Quoting that again would nest every
 * earlier hand-off inside the next, so keep only the start of the earlier session (its original
 * request) and its end (where it left off), and say what was cut. Based on liloli's version in #14.
 */
export function shortenEarlierHandOff(text: string): string {
  const open = text.indexOf(OPEN);
  if (open < 0) return text;
  const close = text.lastIndexOf(CLOSE);
  const end = close > open ? close : text.length;
  const inner = neutralise(shortenEarlierHandOff(text.slice(open + OPEN.length, end))).trim();
  const kept = keepEnds(inner, MAX_EARLIER_HANDOFF, "[… middle of that earlier session omitted …]");
  const after = close > open ? text.slice(close + CLOSE.length) : "";
  return `${neutralise(text.slice(0, open))}${OPEN}\n${kept}\n${CLOSE}${neutralise(after)}`;
}

type ToolCallItem = Extract<AgentTimelineItem, { type: "tool_call" }>;

interface ParsedAgentMessage {
  event: string;
  sender: string | null;
  text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatSender(sender: unknown): string | null {
  if (!isRecord(sender) || typeof sender.id !== "string" || !sender.id.trim()) return null;
  const id = sender.id.trim();
  const title = typeof sender.title === "string" ? sender.title.trim() : "";
  return title && title !== id ? `${title} (${id})` : id;
}

/**
 * Since Paseo 0.11.1, a prompt or finish notification from another agent is projected as an
 * `agent_message` tool call (`paseo-agent-message:…`) rather than a `user_message`.
 */
function readAgentMessage(item: ToolCallItem): ParsedAgentMessage | null {
  if (isRecord(item.agentMessage) && typeof item.agentMessage.event === "string" && typeof item.agentMessage.text === "string") {
    return {
      event: item.agentMessage.event,
      sender: formatSender(item.agentMessage.sender),
      text: item.agentMessage.text,
    };
  }
  if (
    item.name === "agent_message" &&
    item.callId.startsWith("paseo-agent-message:") &&
    item.detail.type === "plain_text" &&
    typeof item.detail.text === "string"
  ) {
    return { event: "message", sender: null, text: item.detail.text };
  }
  return null;
}

/** Paseo projects a schedule or heartbeat fire (`<paseo-system>…</paseo-system>`) as a `heartbeat` tool call. */
function readHeartbeatPrompt(item: ToolCallItem): string | null {
  if (
    item.name === "heartbeat" &&
    item.callId.startsWith("paseo-system:") &&
    item.detail.type === "plain_text" &&
    typeof item.detail.text === "string"
  ) {
    return item.detail.text;
  }
  return null;
}

/** Whether `item` is a prompt row that starts or steers a turn (human, another agent, or a schedule). */
export function isTurnPrompt(item: AgentTimelineItem): boolean {
  if (item.type === "user_message") return true;
  if (item.type !== "tool_call") return false;
  return readAgentMessage(item) !== null || readHeartbeatPrompt(item) !== null;
}

/**
 * Task instructions sent into the conversation: a human message, a prompt from another agent
 * (`create_agent` / `send_agent_prompt`), or a scheduled prompt. Child lifecycle notifications
 * (`event !== "message"`) return `null` so they stay in progress updates rather than instructions.
 */
export function promptInstruction(item: AgentTimelineItem): string | null {
  if (item.type === "user_message") return item.text;
  if (item.type !== "tool_call") return null;
  const agentMsg = readAgentMessage(item);
  if (agentMsg) {
    if (agentMsg.event !== "message") return null;
    if (!agentMsg.text.trim()) return "";
    return agentMsg.sender ? `From ${agentMsg.sender}:\n${agentMsg.text}` : agentMsg.text;
  }
  return readHeartbeatPrompt(item);
}

function describeTool(item: ToolCallItem): string {
  const agentMsg = readAgentMessage(item);
  if (agentMsg) {
    const head = `[agent_message: ${agentMsg.event}${agentMsg.sender ? ` from ${agentMsg.sender}` : ""}]`;
    const body = clip(neutralise(agentMsg.text), 2_000);
    return body ? `${head}\n${body}` : head;
  }
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
  let firstRequest: string | null = null;
  let todos: string | null = null;
  const recordPrompt = (speaker: string, rawText: string) => {
    // Clipping below can't then split a quoted pair: the prompt's own tags are the only ones.
    const text = neutralise(shortenEarlierHandOff(rawText));
    const clipped = clip(text, MAX_FIRST_MESSAGE);
    if (firstRequest === null && clipped) firstRequest = `${speaker} (original request): ${clipped}`;
    lines.push(`${speaker}: ${text.trim()}`);
  };
  for (const item of timeline) {
    switch (item.type) {
      case "user_message":
        recordPrompt("User", item.text);
        break;
      case "assistant_message":
        if (item.text.trim()) lines.push(`Assistant: ${item.text.trim()}`);
        break;
      case "tool_call": {
        const agentMsg = readAgentMessage(item);
        if (agentMsg?.event === "message") {
          if (agentMsg.text.trim()) recordPrompt(agentMsg.sender ? `From ${agentMsg.sender}` : "Agent", agentMsg.text);
          break;
        }
        const heartbeat = readHeartbeatPrompt(item);
        if (heartbeat !== null) {
          if (heartbeat.trim()) recordPrompt("Scheduled", heartbeat);
          break;
        }
        lines.push(describeTool(item));
        break;
      }
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
    body = `${firstRequest ? `${firstRequest}\n\n` : ""}[… earlier conversation omitted …]\n\n${
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
    OPEN,
    transcript,
    CLOSE,
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
  agentId?: string;
  /** Create the pre-bound tab first; the caller delivers its handoff separately. */
  deferPrompt?: boolean;
  /**
   * Make the new agent a sub-agent of this one, as the source was of its parent. This sets Paseo's
   * parent label rather than `parent`: on a create, `parent` would also turn the first prompt into
   * a message from the parent agent, move an agent made outside a workspace into the parent's, and
   * fail outright once the parent has been closed.
   */
  parentId?: string;
}): Promise<Continuation> {
  const { paseo, sourceAgentId } = options;
  const refreshed = await paseo.agents.ref(sourceAgentId).refresh();
  const source = refreshed?.agent;
  if (!source) throw new Error("The original agent is no longer available.");

  let timeline = options.timeline;
  if (!timeline && !options.deferPrompt) {
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

  const agentId = options.agentId ?? randomUUID();
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
        ...(source.features ? { featureValues: Object.fromEntries(source.features.map((feature) => [feature.id, feature.value])) } : {}),
      };
  const request = {
    agentId,
    ...(options.agentId ? { idempotencyKey: options.agentId } : {}),
    config,
    title,
    ...(!options.deferPrompt ? { prompt: continuationPrompt(buildTranscript(timeline ?? []), options.why, options.previous) } : {}),
    labels: { [CONTINUED_FROM_LABEL]: sourceAgentId, ...(options.parentId ? { [PARENT_LABEL]: options.parentId } : {}) },
  };
  if (source.workspaceId) await paseo.workspaces.ref(source.workspaceId).agents.create(request);
  else await paseo.agents.create({ ...request, cwd: source.cwd });
  return { agentId, title };
}
