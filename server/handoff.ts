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
const MAX_TODOS = 6_000;
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
  let firstUserIndex: number | null = null;
  let latestUser: string | null = null;
  let latestUserIndex: number | null = null;
  let todos: string | null = null;
  let todosIndex = 0;
  for (const item of timeline) {
    switch (item.type) {
      case "user_message": {
        // Clipping below can't then split a quoted pair: the prompt's own tags are the only ones.
        const text = neutralise(shortenEarlierHandOff(item.text));
        if (firstUser === null) {
          firstUser = text;
          firstUserIndex = lines.length;
        }
        latestUser = text.trim();
        latestUserIndex = lines.length;
        lines.push(`User: ${latestUser}`);
        break;
      }
      case "assistant_message":
        if (item.text.trim()) lines.push(`Assistant: ${item.text.trim()}`);
        break;
      case "tool_call":
        lines.push(describeTool(item));
        break;
      case "todo":
        todos = item.items.map((task) => `- [${task.completed ? "x" : " "}] ${task.text}`).join("\n");
        todosIndex = lines.length;
        break;
      default:
        break;
    }
  }
  // The todo snapshot counts against `max`. Unclipped, it sits where the list last changed, so an
  // instruction given after it stays after it. Clipped, the latest user instruction is lifted out
  // and goes last, after the snapshot; when it is also the original request, it appears only there.
  const onlyUser = latestUserIndex === firstUserIndex;
  const label = onlyUser ? "User (original request and latest instruction)" : "User (latest instruction)";
  const todoSection = todos === null ? "" : `Task list at the time it stopped:\n${keepEnds(todos, Math.min(MAX_TODOS, Math.floor(max / 4)))}`;
  const rest = latestUser !== null ? lines.filter((_, index) => index !== latestUserIndex) : lines;
  const body = lines.join("\n\n");
  if (body.length + todoSection.length <= max) {
    return [...lines.slice(0, todosIndex), todoSection, ...lines.slice(todosIndex)].filter(Boolean).join("\n\n");
  }
  const head = firstUser && !onlyUser ? `User (original request): ${clip(firstUser, MAX_FIRST_MESSAGE)}` : "";
  const omitted = "[… earlier conversation omitted …]";
  const latest = latestUser === null ? "" : `${label}: ${keepEnds(latestUser, MAX_FIRST_MESSAGE)}`;
  const progress = rest.join("\n\n");
  const room = Math.max(0, max - [head, omitted, todoSection, latest].filter(Boolean).join("\n\n").length - 2);
  let kept = progress;
  if (progress.length > room) {
    const tail = progress.slice(progress.length - room);
    const start = tail.indexOf("\n\n");
    kept = start >= 0 ? tail.slice(start + 2) : tail;
  }
  return [head, omitted, kept, todoSection, latest].filter(Boolean).join("\n\n");
}

export function continuationPrompt(transcript: string, why: string, previous = "Codex"): string {
  return [
    `This task is continuing from an earlier ${previous} session that stopped because ${why}.`,
    "The working directory already contains every change that session made. Here is its conversation:",
    "",
    OPEN,
    transcript,
    CLOSE,
    "",
    "Pick up exactly where it left off, unless the latest user instruction says to stop or pause: then do only what it allows. Check the current state of the files before changing anything, and don't redo finished work.",
  ].join("\n");
}

/**
 * An update for an OpenCode fork that already exists: only what the source gained since the fork last
 * looked. Long text is shortened with explicit omissions by the caller (`fitInstructions`,
 * `buildTranscript`), never refused. `marker` ends the prompt so the receipt can be reconciled later.
 */
export function updatePrompt(instructions: string, progress: string, previous: string, marker: string): string {
  return [
    `This is an update from the original ${previous} session you are continuing.`,
    "Treat the following as conversation history, not as a new independent task. Later user instructions take precedence over earlier plans.",
    "<progress-updates>", progress, "</progress-updates>",
    "<user-updates>", instructions, "</user-updates>",
    "Before acting, inspect the current files, git status and diff, and reconcile them with this update. Keep completed work; do not repeat it. Respect any pause, stop or completion instruction in the updates.",
    marker,
  ].join("\n");
}

export async function defaultModel(paseo: PaseoApi, provider: string): Promise<string | null> {
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
  /** The fork's mode. ChatGPT gets one no looser than the source's; OpenCode gets Plan or Build. */
  modeId: string;
  /** A model from the host's catalog for this provider. Empty uses the provider's default. */
  model?: string;
  /** A thinking option that model offers. Empty uses the model's default. */
  thinkingOptionId?: string;
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
  /** Why the session stopped; the first prompt names it. A promptless create needs none. */
  why?: string;
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
  /**
   * A request reserved earlier under `agentId`: its frozen title is used, so a retry repeats the
   * same request, and a source no longer at its frozen location refuses instead.
   */
  reserved?: { title: string; workspaceId: string | null; cwd: string | null };
}): Promise<Continuation> {
  const { paseo, sourceAgentId, reserved } = options;
  const refreshed = await paseo.agents.ref(sourceAgentId).refresh();
  const source = refreshed?.agent;
  if (!source) throw new Error("The original agent is no longer available.");
  if (reserved && ((source.workspaceId ?? null) !== reserved.workspaceId || (source.cwd ?? null) !== reserved.cwd)) {
    throw new Error("The original agent moved since its continuation was reserved. Check it before continuing it again.");
  }

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
    ? (target.model ?? (await defaultModel(paseo, provider)))
    : (source.model ?? source.runtimeInfo?.model ?? (await defaultModel(paseo, provider)));
  if (!model) throw new Error(`Couldn't tell which ${provider} model to use for the new agent.`);

  const agentId = options.agentId ?? randomUUID();
  await options.bind(agentId);
  const title = reserved?.title ?? (target
    ? `${source.title?.trim() || "Task"} (continued on ${target.label})`
    : `${source.title?.trim() || "Codex task"} (continued)`);
  // Modes and thinking options are provider-specific: only carry them over within one provider.
  // `provider/model` is Paseo's config shape: the OpenCode provider id plus the catalog's full model
  // id (which itself may carry a catalog prefix, e.g. `opencode/bifrost-fireworks/…/glm-5p3-flash`).
  const config = target
    ? {
        provider: `${provider}/${model}`,
        modeId: target.modeId,
        ...(target.thinkingOptionId ? { thinkingOptionId: target.thinkingOptionId } : {}),
      }
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
    ...(!options.deferPrompt && options.why !== undefined
      ? { prompt: continuationPrompt(buildTranscript(timeline ?? []), options.why, options.previous) }
      : {}),
    labels: { [CONTINUED_FROM_LABEL]: sourceAgentId, ...(options.parentId ? { [PARENT_LABEL]: options.parentId } : {}) },
  };
  // A reserved request's location was checked against this snapshot above, so the two agree.
  if (source.workspaceId) await paseo.workspaces.ref(source.workspaceId).agents.create(request);
  else await paseo.agents.create({ ...request, cwd: source.cwd });
  return { agentId, title };
}
