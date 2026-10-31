import { randomUUID } from "node:crypto";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { sameAccountIdentity } from "./account-identity";
import type { AgentTimelineItem } from "./adapter";
import { buildTranscript, CONTINUED_FROM_LABEL, continueInNewAgent, keepEnds, type Continuation } from "./handoff";
import { Mutex } from "./json-file";
import { isUsable } from "./routing";
import { findAccount, MAIN_ACCOUNT_ID, StateStore, type ContinuationChain, type StoredAccount, type StoredState } from "./state";

type PaseoApi = PluginHookContext["paseo"];
type Agent = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"];
type Member = ContinuationChain["members"][string];
type Pending = NonNullable<ContinuationChain["pending"]>;
type Mark = Member["seen"][string];
type Source = "auto" | "user";
type Update = { item: AgentTimelineItem; timestamp: string };
const MESSAGE_PREFIX = "zerosub-handoff-";
const MAX_PAGES = 100;
const MAX_INSTRUCTIONS = 60_000;
const MAX_ORIGIN = 6_000;
const OMITTED = "[… part of this message omitted to fit this update …]";

/** The same checkout. Paseo starts a workspace's new agents in its directory, not the source's subfolder. */
function samePlace(left: Agent, right: Agent): boolean {
  if (left.provider !== right.provider || left.workspaceId !== right.workspaceId) return false;
  return Boolean(left.workspaceId) || left.cwd === right.cwd;
}

function ready(agent: Agent): boolean {
  return !agent.archivedAt && !agent.providerUnavailable && !agent.activeTurn &&
    !agent.pendingPermissions?.length && (agent.status === "idle" || agent.status === "closed" || agent.status === "error");
}

function busy(agent: Agent): boolean {
  return agent.status === "running" || agent.status === "initializing" || Boolean(agent.activeTurn);
}

/** Still ready, in the same place and mode, and nobody has sent it another message. */
function untouched(before: Agent, now: Agent | undefined): boolean {
  return now !== undefined && ready(now) && samePlace(before, now) &&
    now.currentModeId === before.currentModeId && now.lastUserMessageAt === before.lastUserMessageAt;
}

/** Pinned to the account, and not already running on another one. */
function boundTo(state: StoredState, agentId: string, accountId: string): boolean {
  const session = state.sessions[agentId];
  return state.bindings[agentId]?.accountId === accountId && (!session || session.accountId === accountId);
}

/** The account still exists, can take work and is still signed in as the same person. */
function stillUsable(state: StoredState, account: StoredAccount): boolean {
  const current = findAccount(state, account.id);
  // Upkeep may add the member's email to an old workspace-only Codex key during the handoff; that's the same person.
  return current !== undefined && isUsable(current, Date.now()) &&
    (current.identity === account.identity || sameAccountIdentity(account.family, current, account)) && current.email === account.email;
}

function member(account: StoredAccount): Member {
  return { accountId: account.id, identity: account.identity, email: account.email, seen: {} };
}

function chainOf(state: StoredState, agentId: string): string | undefined {
  return Object.keys(state.continuations).find((id) => state.continuations[id]?.members[agentId]);
}

async function snapshot(paseo: PaseoApi, agentId: string): Promise<Agent | undefined> {
  return (await paseo.agents.ref(agentId).refresh())?.agent;
}

/** Commit exactly the reserved context, whether the acknowledgement arrived normally or on retry. */
function completeHandoff(chain: ContinuationChain): void {
  const pending = chain.pending!;
  chain.members[pending.agentId]!.seen = pending.seen;
  delete chain.members[pending.agentId]!.unstarted;
  chain.activeAgentId = pending.agentId;
  if (pending.replaceHistory) {
    chain.baselineMessageId = pending.messageId;
    for (const id of pending.replaceHistory) {
      delete chain.members[id];
      for (const entry of Object.values(chain.members)) delete entry.seen[id];
    }
  }
  delete chain.pending;
}

/** Where the handoff goes: an existing tab for the account, or a new (possibly reserved) one. */
interface Destination {
  targetId: string;
  /** The existing tab, when there is one. */
  agent?: Agent;
  entry?: Member;
}

/** What the destination hasn't seen yet, and the timeline marks to record once it has. */
interface Gathered {
  updates: Update[];
  seen: Record<string, Mark>;
  /** An earlier tab is gone or moved, so the source's own history stands in for the task's. */
  fallback: boolean;
  /** Members whose history the fallback replaces. */
  obsolete: string[];
}

/** Codex keeps one account-bound thread per task/account. All dispatches share the chain lock. */
export class CodexContinuations {
  private readonly locks = new Map<string, { mutex: Mutex; users: number }>();
  private readonly inFlight = new Map<string, Promise<Continuation>>();

  constructor(private readonly store: StateStore) {}

  /**
   * Automatic follow-ups (including banked resets) must not wake a parked task tab. Returns the tab
   * the task continues in when that isn't this one, else null.
   */
  async continuesElsewhere(paseo: PaseoApi, agentId: string): Promise<Continuation | null> {
    const chain = Object.values((await this.store.read()).continuations).find((entry) => entry.members[agentId]);
    if (!chain) return null;
    const { pending } = chain;
    if (pending?.stage === "sending") {
      // Only a hand-off whose prompt may have reached a live tab holds the task. A failed creation
      // sent nothing, and an archived or deleted destination has been given up.
      const target = await snapshot(paseo, pending.agentId);
      if (target && !target.archivedAt) return pending.agentId === agentId ? null : { agentId: pending.agentId, title: target.title ?? "Codex task" };
    }
    const current = await currentTab(paseo, chain, agentId);
    return current.id === agentId ? null : { agentId: current.id, title: current.agent?.title ?? "Codex task" };
  }

  continue(paseo: PaseoApi, sourceAgentId: string, target: StoredAccount, why: string, source: Source): Promise<Continuation> {
    const key = `${sourceAgentId}:${target.id}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const task = this.dispatch(paseo, sourceAgentId, target, why, source).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, task);
    return task;
  }

  private async dispatch(paseo: PaseoApi, sourceAgentId: string, target: StoredAccount, why: string, source: Source): Promise<Continuation> {
    const original = await snapshot(paseo, sourceAgentId);
    if (!original || original.archivedAt) throw new Error("The original agent is no longer available.");
    const { root, ancestors } = await findTask(paseo, await this.store.read(), original);
    return this.locked(root, async () => {
      const chain = await this.openChain(root, ancestors, sourceAgentId);
      if (!chain.members[sourceAgentId]) throw new Error("This older continuation isn't part of the active task. Switch from the task's current tab.");
      const settled = await this.settlePending(paseo, root, chain, target);
      if ("done" in settled) return settled.done;
      const { reserved } = settled;
      if (source === "auto") await checkCurrent(paseo, chain, sourceAgentId);
      const sourceAgent = await waitForSource(paseo, original, source);
      const state = await this.store.read();
      const account = findAccount(state, target.id);
      if (!account || account.family !== "codex" || !isUsable(account, Date.now())) {
        throw new Error("That ChatGPT account is no longer available. Enable it, sign in or wait for its limit to reset.");
      }
      const snapshots = await memberSnapshots(paseo, chain, sourceAgent);
      const destination = pickDestination(state, chain, snapshots, sourceAgent, account, reserved);
      const gathered = await gatherUpdates(paseo, state, chain, snapshots, sourceAgent, destination);
      const prompt = composePrompt(chain, destination, gathered, why, Boolean(reserved));
      const messageId = reserved?.messageId ?? `${MESSAGE_PREFIX}${randomUUID()}`;
      await this.confirmUnchanged(paseo, sourceAgent, destination, account);
      await this.reserve(root, sourceAgent.id, destination, gathered, account, messageId, source);
      return this.deliver(paseo, root, sourceAgent, destination, account, prompt, messageId, why);
    });
  }

  /** One dispatch per task at a time; the lock is dropped once nobody waits on it. */
  private locked<T>(root: string, section: () => Promise<T>): Promise<T> {
    let lock = this.locks.get(root);
    if (!lock) this.locks.set(root, (lock = { mutex: new Mutex(), users: 0 }));
    lock.users += 1;
    return lock.mutex.run(section).finally(() => {
      if (--lock.users === 0) this.locks.delete(root);
    });
  }

  /** The task's record, created from the discovered tabs on the first switch. */
  private async openChain(root: string, ancestors: Agent[], sourceAgentId: string): Promise<ContinuationChain> {
    const existing = (await this.store.read()).continuations[root];
    if (existing) return existing;
    const next = await this.store.update((draft) => {
      const members: ContinuationChain["members"] = {};
      for (const agent of [...ancestors].reverse()) {
        // A tab with no recorded session runs on the CLI login; pin it there so reuse stays exact.
        const account = findAccount(draft, draft.sessions[agent.id]?.accountId ?? draft.bindings[agent.id]?.accountId ?? MAIN_ACCOUNT_ID.codex);
        if (account?.family === "codex") {
          members[agent.id] = member(account);
          draft.bindings[agent.id] ??= { accountId: account.id, source: "thread", at: new Date().toISOString() };
        }
      }
      if (!members[sourceAgentId]) throw new Error("Couldn't establish this Codex thread's account. Reopen it before switching.");
      draft.continuations[root] = { activeAgentId: sourceAgentId, members };
    });
    return next.continuations[root]!;
  }

  /**
   * Resolves a handoff an earlier call reserved but didn't finish. A disconnected RPC can have
   * delivered its prompt, so never resend it or create another tab.
   */
  private async settlePending(
    paseo: PaseoApi,
    root: string,
    chain: ContinuationChain,
    target: StoredAccount,
  ): Promise<{ done: Continuation } | { reserved?: Pending }> {
    const pending = chain.pending;
    if (!pending) return {};
    const agent = await snapshot(paseo, pending.agentId);
    const release = () => this.store.update((draft) => { delete draft.continuations[root]!.pending; });
    if (pending.stage === "creating") {
      if (!agent?.archivedAt && chain.members[pending.agentId]?.accountId === target.id) {
        // No prompt is sent during creation, so retrying this same idempotent creation is safe.
        if (agent?.lastUserMessageAt) throw new Error(`The unstarted tab ${agent.id} received another message. Check it and archive it before retrying.`);
        return { reserved: pending };
      }
      // Nothing was sent, so dropping the reservation cannot duplicate work. Keep its tab for later reuse.
      await release();
      return {};
    }
    if (agent && !agent.archivedAt) {
      const history = await readUpdates(paseo, pending.agentId, undefined, pending.messageId);
      if (history.entries.some((entry) => delivered(entry, pending.messageId))) {
        await this.store.update((draft) => completeHandoff(draft.continuations[root]!));
        return { done: { agentId: agent.id, title: agent.title ?? "Codex task" } };
      }
    }
    if (!agent || agent.archivedAt) {
      // The user gave that tab up; it can't run the prompt any more. Automatic switches may carry on too.
      await release();
      return {};
    }
    if (busy(agent)) throw new Error("The previous handoff may still be starting. Wait for that tab to stop, then retry.");
    throw new Error(`The previous handoff to ${pending.agentId} could not be confirmed. Check that tab; archive it before retrying the switch.`);
  }

  /** Last look before reserving: nothing may have changed while the update was being read. */
  private async confirmUnchanged(paseo: PaseoApi, sourceAgent: Agent, destination: Destination, account: StoredAccount): Promise<void> {
    const sourceNow = await snapshot(paseo, sourceAgent.id);
    const targetNow = destination.agent && await snapshot(paseo, destination.targetId);
    const state = await this.store.read();
    const sourceOk = untouched(sourceAgent, sourceNow);
    const targetOk = !destination.agent || (untouched(destination.agent, targetNow) && boundTo(state, destination.targetId, account.id));
    if (!sourceOk || !targetOk || !stillUsable(state, account)) {
      throw new Error("The task or account changed during the handoff. Check the active tab and try again.");
    }
  }

  /** Reserve before either SDK operation: a crash or uncertain reply must not duplicate work. */
  private async reserve(
    root: string,
    sourceAgentId: string,
    destination: Destination,
    gathered: Gathered,
    account: StoredAccount,
    messageId: string,
    source: Source,
  ): Promise<void> {
    const { targetId } = destination;
    await this.store.update((draft) => {
      const current = draft.continuations[root]!;
      if (!destination.agent) current.members[targetId] = { ...member(account), unstarted: true };
      current.pending = {
        agentId: targetId,
        messageId,
        seen: gathered.seen,
        stage: destination.agent ? "sending" : "creating",
        ...(gathered.fallback ? { replaceHistory: gathered.obsolete } : {}),
      };
      if (!destination.agent) draft.bindings[targetId] = { accountId: account.id, source: source === "user" ? "user" : "thread", at: new Date().toISOString() };
    });
  }

  /** Creates the tab if needed (without a prompt), then sends the update under its reserved ID. */
  private async deliver(
    paseo: PaseoApi,
    root: string,
    sourceAgent: Agent,
    destination: Destination,
    account: StoredAccount,
    prompt: string,
    messageId: string,
    why: string,
  ): Promise<Continuation> {
    const { targetId } = destination;
    let result: Continuation;
    if (destination.agent) {
      result = { agentId: targetId, title: destination.agent.title ?? "Codex task" };
    } else {
      result = await continueInNewAgent({ paseo, sourceAgentId: sourceAgent.id, why, agentId: targetId, deferPrompt: true, bind: async () => {} });
      // Creation can take time. A user may have started another turn or disabled the account.
      const created = await waitForCreated(paseo, targetId);
      const sourceNow = await snapshot(paseo, sourceAgent.id);
      const state = await this.store.read();
      const createdOk = created !== undefined && ready(created) && samePlace(sourceAgent, created) && !created.lastUserMessageAt &&
        created.currentModeId === sourceAgent.currentModeId && boundTo(state, targetId, account.id);
      if (!untouched(sourceAgent, sourceNow) || !createdOk || !stillUsable(state, account)) {
        throw new Error("The task or account changed while its tab was being created. Check the active tab and retry the switch.");
      }
      await this.store.update((draft) => { draft.continuations[root]!.pending!.stage = "sending"; });
    }
    await paseo.agents.ref(targetId).send(prompt, { messageId });
    await this.store.update((draft) => completeHandoff(draft.continuations[root]!));
    return result;
  }
}

/**
 * Finds the task a tab belongs to. Only ancestors carrying ZeroSub's continuation label count, so
 * unrelated agents in the same workspace (even on the same account) never join this task.
 */
async function findTask(paseo: PaseoApi, state: StoredState, original: Agent): Promise<{ root: string; ancestors: Agent[] }> {
  let root = chainOf(state, original.id);
  const ancestors: Agent[] = [original];
  if (!root) {
    let parent = original.labels?.[CONTINUED_FROM_LABEL];
    while (parent && !ancestors.some((agent) => agent.id === parent)) {
      const agent = await snapshot(paseo, parent);
      if (!agent || !samePlace(original, agent)) break;
      ancestors.push(agent);
      root = chainOf(state, agent.id);
      if (root) break;
      parent = agent.labels?.[CONTINUED_FROM_LABEL];
    }
  }
  root ??= ancestors.at(-1)!.id;
  if (!state.continuations[root]) await adoptDescendants(paseo, original, ancestors);
  return { root, ancestors };
}

/**
 * Adopts existing descendants too: switching from the original tab after upgrading mustn't create
 * a second B tab just because B's label points towards A rather than the other way. This pages
 * through every agent, archived ones included, but only once per task: the record exists afterwards.
 */
async function adoptDescendants(paseo: PaseoApi, original: Agent, ancestors: Agent[]): Promise<void> {
  const related: Agent[] = [];
  let cursor: string | undefined;
  for (let page = 0; ; page += 1) {
    if (page >= MAX_PAGES) throw new Error("Couldn't find all existing continuation tabs. Check this task's tabs before retrying.");
    const result = await paseo.agents.list({ filter: { includeArchived: true }, page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    related.push(...result.entries.map(({ agent }) => agent).filter((agent) => samePlace(original, agent)));
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) break;
    cursor = result.pageInfo.nextCursor;
  }
  const known = (id: string | undefined) => ancestors.some((entry) => entry.id === id);
  for (let added = true; added;) {
    added = false;
    for (const agent of related) {
      if (!known(agent.id) && known(agent.labels?.[CONTINUED_FROM_LABEL])) {
        ancestors.unshift(agent);
        added = true;
      }
    }
  }
}

function newer(left: string | null | undefined, right: string | null | undefined): boolean {
  return left ? !right || Date.parse(left) > Date.parse(right) : false;
}

/**
 * The tab the task continues in: the last handoff's destination, unless the user has since typed
 * in another of the task's tabs. That tab has taken the task over; its new messages are part of it.
 * An archived or deleted destination doesn't hold the task: the most recently used tab left does,
 * starting from the asking tab, which is current when no other tab is left. Neither does a tab
 * moved to another workspace: it has left the task.
 */
async function currentTab(paseo: PaseoApi, chain: ContinuationChain, askingId: string): Promise<{ id: string; agent?: Agent }> {
  const asking = await snapshot(paseo, askingId);
  const active = chain.activeAgentId === askingId ? asking : await snapshot(paseo, chain.activeAgentId);
  const place = asking ?? active;
  const usable = (agent: Agent | undefined): agent is Agent => agent !== undefined && !agent.archivedAt && (!place || samePlace(place, agent));
  let current = usable(active) ? { id: chain.activeAgentId, agent: active } : usable(asking) ? { id: askingId, agent: asking } : undefined;
  for (const [id, entry] of Object.entries(chain.members)) {
    if (id === current?.id || entry.unstarted) continue;
    const agent = await snapshot(paseo, id);
    if (usable(agent) && (!current || newer(agent.lastUserMessageAt, current.agent.lastUserMessageAt))) current = { id, agent };
  }
  return current ?? { id: askingId };
}

/**
 * Automatic switches only move the task's current tab. The user may switch from any of its tabs:
 * the destination gets every other tab's updates, so nothing is lost either way.
 */
async function checkCurrent(paseo: PaseoApi, chain: ContinuationChain, sourceAgentId: string): Promise<void> {
  const current = await currentTab(paseo, chain, sourceAgentId);
  if (current.id !== sourceAgentId) {
    throw new Error(`This task now continues in “${current.agent?.title ?? current.id}”. Switch accounts from that tab.`);
  }
}

/** The source must have stopped, without a newer message than the one that asked for the switch. */
async function waitForSource(paseo: PaseoApi, original: Agent, source: Source): Promise<Agent> {
  let agent = await snapshot(paseo, original.id);
  // turn_ended can arrive just before the directory reports idle, as in the existing reopener.
  for (let attempt = 0; source === "auto" && agent && attempt < 20 && (agent.status === "running" || agent.status === "initializing"); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    agent = await snapshot(paseo, original.id);
  }
  if (!agent || !ready(agent)) throw new Error("Wait for the current agent to stop before switching accounts.");
  if (agent.lastUserMessageAt !== original.lastUserMessageAt) {
    throw new Error("The agent received another message while waiting to switch. Check the current turn before retrying.");
  }
  return agent;
}

/** A tab created without a prompt can still report initializing for a moment before it is idle. */
async function waitForCreated(paseo: PaseoApi, agentId: string): Promise<Agent | undefined> {
  let agent = await snapshot(paseo, agentId);
  for (let attempt = 0; agent?.status === "initializing" && attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    agent = await snapshot(paseo, agentId);
  }
  return agent;
}

/** Current snapshots of the task's tabs; none of them may be working while the task moves. */
async function memberSnapshots(paseo: PaseoApi, chain: ContinuationChain, sourceAgent: Agent): Promise<Map<string, Agent>> {
  const snapshots = new Map<string, Agent>();
  for (const id of Object.keys(chain.members)) {
    const agent = await snapshot(paseo, id);
    if (!agent) continue;
    snapshots.set(id, agent);
    if (samePlace(sourceAgent, agent) && !agent.archivedAt && (busy(agent) || agent.pendingPermissions?.length)) {
      throw new Error("Another tab in this task is working or waiting for permission. Finish or stop it before switching.");
    }
  }
  return snapshots;
}

/** Reuse the task's tab for this account when it's still exactly that account's, else make one. */
function pickDestination(
  state: StoredState,
  chain: ContinuationChain,
  snapshots: Map<string, Agent>,
  sourceAgent: Agent,
  account: StoredAccount,
  reserved: Pending | undefined,
): Destination {
  const candidate = Object.entries(chain.members).find(([id, entry]) => {
    const agent = snapshots.get(id);
    // A tab recorded under an old workspace-only Codex key is matched by its saved email.
    return id !== sourceAgent.id && entry.accountId === account.id && sameAccountIdentity(account.family, entry, account) &&
      entry.email === account.email && boundTo(state, id, account.id) &&
      agent !== undefined && samePlace(sourceAgent, agent) && !agent.archivedAt && !agent.providerUnavailable;
  });
  if (reserved && snapshots.has(reserved.agentId) && candidate?.[0] !== reserved.agentId) {
    throw new Error(`The reserved tab ${reserved.agentId} changed identity or location. Check it and archive it before retrying.`);
  }
  if (!candidate) return { targetId: reserved?.agentId ?? randomUUID() };
  const [targetId, entry] = candidate;
  const agent = snapshots.get(targetId)!;
  if (entry.unstarted && agent.lastUserMessageAt) {
    throw new Error(`The unstarted tab ${targetId} received another message. Check it and archive it before retrying.`);
  }
  if (!ready(agent)) throw new Error("The account's existing tab isn't ready to continue. Check it before switching.");
  if (agent.currentModeId !== sourceAgent.currentModeId) {
    throw new Error(`The existing tab ${targetId} has a different permission mode. Align its mode with the current tab before switching.`);
  }
  // Anything the user typed in this tab while it was parked is part of the task; it already knows it.
  return { targetId, agent, entry };
}

/** Reads every other tab's timeline since the destination last saw it. */
async function gatherUpdates(
  paseo: PaseoApi,
  state: StoredState,
  chain: ContinuationChain,
  snapshots: Map<string, Agent>,
  sourceAgent: Agent,
  destination: Destination,
): Promise<Gathered> {
  const { targetId } = destination;
  const known = destination.entry?.seen ?? {};
  // A deleted or moved tab must not strand the task or leak a different task's new history.
  const lost = (id: string) => {
    const agent = snapshots.get(id);
    return !agent || !samePlace(sourceAgent, agent) || state.bindings[id]?.accountId !== chain.members[id]!.accountId;
  };
  const others = Object.keys(chain.members).filter((id) => id !== targetId && !chain.members[id]!.unstarted);
  const obsolete = others.filter((id) => id !== sourceAgent.id && lost(id));
  if (others.some(lost)) {
    // The current source already received the earlier work in its last successful handoff.
    // Marks for the deltas this replaces are discarded as well.
    const history = await readUpdates(paseo, sourceAgent.id);
    return { updates: byTime(history.entries), seen: { ...known, [sourceAgent.id]: history.mark }, fallback: true, obsolete };
  }
  const seen = { ...known };
  const updates: Update[] = [];
  for (const id of others) {
    const delta = await readUpdates(paseo, id, seen[id]);
    seen[id] = delta.mark;
    updates.push(...delta.entries);
  }
  return { updates: byTime(updates), seen, fallback: false, obsolete };
}

function byTime(updates: Update[]): Update[] {
  return updates.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

/** ZeroSub's own earlier handoff prompts, which the destination mustn't receive again. */
function ownHandoff(item: Extract<AgentTimelineItem, { type: "user_message" }>, chain: ContinuationChain): boolean {
  if (chain.baselineMessageId !== undefined && item.clientMessageId === chain.baselineMessageId) return false;
  if (item.clientMessageId?.startsWith(MESSAGE_PREFIX)) return true;
  // Older releases didn't assign message IDs to their full-transcript handoffs.
  return Object.keys(chain.members).length > 1 && item.text.startsWith("This task is continuing from an earlier Codex session that stopped because");
}

/**
 * Every pending user instruction when they fit; the tool/assistant recap is clipped separately.
 * Otherwise the first one (the original request, for a new tab) and as many of the most recent as
 * fit, saying how many were left out. Pasted logs mustn't stop a task from moving on.
 */
export function fitInstructions(texts: string[], max = MAX_INSTRUCTIONS): string {
  const all = texts.join("\n\n");
  if (all.length <= max) return all;
  const [first = "", ...rest] = texts;
  if (!rest.length) return keepEnds(first, max, OMITTED);
  const head = keepEnds(first, MAX_ORIGIN, OMITTED);
  let room = max - head.length - 100; // Leaves space for the note below.
  const recent: string[] = [];
  for (let index = rest.length - 1; index >= 0 && room > 0; index -= 1) {
    const text = rest[index]!;
    if (text.length + 2 > room && recent.length) break;
    // The latest instruction always stays, shortened if it alone is too long.
    const kept = text.length + 2 > room ? keepEnds(text, room - 2, OMITTED) : text;
    recent.unshift(kept);
    room -= kept.length + 2;
  }
  const left = rest.length - recent.length;
  const note = left ? [`[… ${left} earlier instruction${left === 1 ? "" : "s"} omitted to fit this update …]`] : [];
  return [head, ...note, ...recent].join("\n\n");
}

function composePrompt(chain: ContinuationChain, destination: Destination, gathered: Gathered, why: string, reserved: boolean): string {
  const { updates, fallback } = gathered;
  // After a downgrade (or loss of the original tab), the oldest surviving tab may start with
  // a full handoff instead of the human's request. A fresh recipient still needs that origin.
  const fresh = !destination.agent || reserved || destination.entry?.unstarted;
  const origin = fresh ? updates.find(({ item }) => item.type === "user_message")?.item : undefined;
  const items = updates.map((entry) => entry.item).filter((item) =>
    fallback || item === origin || item.type !== "user_message" || !ownHandoff(item, chain));
  const instructions = fitInstructions(items.filter((item) => item.type === "user_message").map((item) => item.text));
  if (!destination.agent && !instructions.trim()) throw new Error("Couldn't read the task's instructions. Provide a current summary before switching.");
  return [
    `This task is continuing because ${why}.`,
    destination.agent ? "You are returning to your existing account-bound thread. Your older history may be stale." : "Continue this task in your account-bound thread.",
    ...(fallback ? ["An earlier tab is unavailable or moved. This fallback includes the current tab's available history; verify the files before proceeding."] : []),
    "Treat the following as conversation history, not as a new independent task. Later user instructions take precedence over earlier plans.",
    "<user-updates>", instructions, "</user-updates>",
    "<progress-updates>", buildTranscript(items.filter((item) => item.type !== "user_message")), "</progress-updates>",
    "Before acting, inspect the current files, git status and diff, and reconcile them with this update. Keep completed work; do not repeat it. Respect any pause, stop or completion instruction in the updates.",
  ].join("\n");
}

/** The daemon accepted this message as a turn: it carries our ID and a turn. */
function delivered(entry: { item: AgentTimelineItem; turnId?: string }, messageId: string): boolean {
  return Boolean(entry.turnId) && entry.item.type === "user_message" && entry.item.clientMessageId === messageId;
}

/** Canonical sequence cursors avoid re-sending projected messages that merge across a watermark. */
async function readUpdates(paseo: PaseoApi, agentId: string, since?: Mark, receiptId?: string) {
  const timeline = paseo.agents.ref(agentId).timeline;
  let page = await timeline.refetch({ direction: "tail", limit: 500, projection: "canonical" });
  if (page.gap || page.staleCursor) throw new Error("The task's handoff history has a gap. Check its timeline before continuing.");
  const mark = { epoch: page.epoch, seq: page.window.maxSeq };
  const after = since?.epoch === page.epoch ? since.seq : -1;
  const entries = [...page.entries];
  const foundReceipt = () => receiptId !== undefined && entries.some((entry) => delivered(entry, receiptId));
  for (let pages = 1; page.hasOlder && (page.startCursor?.seq ?? 0) > after && !foundReceipt(); pages += 1) {
    if (pages >= MAX_PAGES || !page.startCursor) throw new Error("Couldn't read the complete handoff history. Try again after checking the task's timeline.");
    page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 500, projection: "canonical" });
    if (page.epoch !== mark.epoch || page.staleCursor || page.gap) throw new Error("The task's history changed during the handoff. Try again.");
    entries.unshift(...page.entries);
  }
  if (page.gap) throw new Error("The task's handoff history has a gap. Check its timeline before continuing.");
  return { mark, entries: entries.filter((entry) => entry.seqEnd > after) };
}
