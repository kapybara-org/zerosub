/*
 * Double-hand-off protection, driven through the real Paseo client SDK.
 *
 * Real: `DaemonClient` (@getpaseo/client/internal/daemon-client) wrapped by `createPaseoApi`, so
 * every call ZeroSub makes goes through the SDK's own request building, creation lifecycle
 * (idempotency keys, caller-selected IDs, reconnect recovery), waiters and response validation.
 * Wire frames are JSON text envelopes, as the SDK sends them: `hello`, `ping`/`pong`, and
 * `{ type: "session", message }`. The fake parses every inbound frame with the protocol's
 * `WSInboundMessageSchema` and checks every outbound frame against `WSOutboundMessageSchema`.
 * The client also validates what it receives, so a wrong field name fails the test.
 *
 * Modelled: the daemon itself. No daemon, server or in-process harness ships in node_modules.
 * @getpaseo/{client,plugin,protocol,relay} hold only the SDK, the plugin contracts, the schemas
 * and relay encryption. So this file models the daemon behaviour ZeroSub relies on:
 * - server_info advertises the features of a current (0.9.x) daemon, including creationLifecycle,
 *   agentRequestReceipts, ownedSubscriptions, canonicalSubmittedPrompts and agentTurnIdentity.
 *   Without creationLifecycle the SDK refuses caller-selected agent IDs.
 * - agent.create.request with an idempotencyKey it has already seen replays the first creation:
 *   same agentId, no second agent. creation.subscribe returns the recorded snapshot.
 * - send_agent_message_request: the messageId comes back as `clientMessageId` on the canonical
 *   user_message entry, and an accepted prompt gets a `turnId` on that entry. A messageId already
 *   seen for that agent is acknowledged without starting a second turn (the protocol documents
 *   messageId as "Client-provided ID for deduplication"). The provider contract supports the
 *   receipt: a prompt's clientMessageId is echoed on its user_message item and linked to a turnId
 *   by session.prompt_result (@getpaseo/plugin/dist/server/provider.d.ts). That the daemon then
 *   stamps the turnId on the canonical entry is assumed, as server/continuations.ts assumes it.
 * - canonical timeline pages: one seq per entry, with epoch, window.minSeq/maxSeq/nextSeq,
 *   seqStart/seqEnd, start/end cursors and hasOlder/hasNewer. The "before" cursor is exclusive.
 *   gap and staleCursor are false unless the cursor's epoch is stale. "projected" is served as
 *   canonical (ZeroSub's continuation path never asks for it).
 * - fetch_agent returns `agent: null` and `error: null` for an unknown ID, and matches only the
 *   full ID (the real daemon also resolves prefixes and titles).
 * - a turn runs briefly and then goes idle with a short assistant reply.
 * Lost replies are modelled by dropping the connection after the daemon-side effect. The SDK's
 * request timeouts are fixed at 60s or more (and creation has none), so a dropped socket is
 * the fast and realistic way to lose an acknowledgement.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient, type DaemonClientConfig } from "@getpaseo/client/internal/daemon-client";
import type { DaemonTransport, DaemonTransportFactory } from "@getpaseo/client/internal/daemon-client-transport-types";
import {
  AgentSnapshotPayloadSchema,
  AgentTimelineEntryPayloadSchema,
  AgentTimelineItemPayloadSchema,
  CreationSnapshotSchema,
  SessionOutboundMessageSchema,
  WSInboundMessageSchema,
  WSOutboundMessageSchema,
  type SessionInboundMessage,
} from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { input, output } from "zod";
import { CodexContinuations } from "./continuations";
import { StateStore, StoredAccountSchema, type StoredAccount } from "./state";

type Outbound = input<typeof SessionOutboundMessageSchema>;
type Snapshot = input<typeof AgentSnapshotPayloadSchema>;
// The item union's zod *input* type collapses to unknown; its parsed form is the same JSON shape.
type Item = output<typeof AgentTimelineItemPayloadSchema>;
type Entry = Omit<input<typeof AgentTimelineEntryPayloadSchema>, "item"> & { item: Item };
type Creation = input<typeof CreationSnapshotSchema>;
type Inbound<T extends SessionInboundMessage["type"]> = Extract<SessionInboundMessage, { type: T }>;

const ROOT = "6f1c2a52-8a43-4e0b-9a49-0d6f3f1b7a01";
const WORKSPACE_ID = "workspace-1";
const BASE_TIME = Date.parse("2026-10-01T00:00:00Z");

interface FakeAgent { snapshot: Snapshot; epoch: string; entries: Entry[]; messageIds: Set<string> }
interface Connection { deliver(message: Outbound): void; drop(reason: string): void }

/** A minimal in-memory Paseo daemon speaking the real wire protocol. */
class FakeDaemon {
  readonly agents = new Map<string, FakeAgent>();
  readonly wire: SessionInboundMessage[] = [];
  readonly violations: string[] = [];
  private readonly creations = new Map<string, Creation>();
  private readonly faults = new Map<string, () => void>();
  private readonly turns = new Set<Promise<void>>();
  private clock = 0;
  private serial = 0;

  constructor(readonly cwd: string) {}

  readonly transportFactory: DaemonTransportFactory = () => this.open();

  private now(): string { return new Date(BASE_TIME + this.clock++ * 1000).toISOString(); }

  requests<T extends SessionInboundMessage["type"]>(type: T): Inbound<T>[] {
    return this.wire.filter((message): message is Inbound<T> => message.type === type);
  }

  /** Canonical user_message entries carrying a client message ID (the delivery receipt). */
  receipts(agentId: string, clientMessageId: string): Entry[] {
    return (this.agents.get(agentId)?.entries ?? []).filter(({ item }) => item.type === "user_message" && item.clientMessageId === clientMessageId);
  }

  /** Performs the next request of this type daemon-side, then drops the socket instead of replying. */
  dropReplyTo(type: SessionInboundMessage["type"]): Promise<void> {
    return new Promise((resolve) => this.faults.set(type, resolve));
  }

  async idle(): Promise<void> { while (this.turns.size) await Promise.all([...this.turns]); }

  addAgent(id: string, values: Partial<Snapshot> = {}): FakeAgent {
    const at = this.now();
    const agent: FakeAgent = {
      snapshot: {
        id, provider: "codex", cwd: this.cwd, workspaceId: WORKSPACE_ID, model: "synthetic-model",
        features: [{ type: "toggle", id: "fast_mode", label: "Fast", value: true }], thinkingOptionId: "high",
        createdAt: at, updatedAt: at, lastUserMessageAt: null, status: "idle", activeTurn: null,
        capabilities: {
          supportsStreaming: true, supportsSessionPersistence: true, supportsDynamicModes: true, supportsMcpServers: true,
          supportsReasoningStream: true, supportsToolInvocations: true,
        },
        currentModeId: "full-access", availableModes: [{ id: "full-access", label: "Full access" }, { id: "auto", label: "Auto" }],
        pendingPermissions: [], persistence: null, title: "Fix the build", labels: {}, archivedAt: null, ...values,
      },
      epoch: `epoch-${id.slice(0, 8)}`, entries: [], messageIds: new Set(),
    };
    this.agents.set(id, agent);
    return agent;
  }

  private append(agent: FakeAgent, item: Item, turnId?: string): Entry {
    const seq = (agent.entries.at(-1)?.seqEnd ?? 0) + 1;
    const entry: Entry = {
      provider: agent.snapshot.provider, item, timestamp: this.now(), seqStart: seq, seqEnd: seq,
      sourceSeqRanges: [{ startSeq: seq, endSeq: seq }], collapsed: [], ...(turnId ? { turnId } : {}),
    };
    agent.entries.push(entry);
    agent.snapshot.updatedAt = entry.timestamp;
    if (item.type === "user_message") agent.snapshot.lastUserMessageAt = entry.timestamp;
    return entry;
  }

  /** What the person does in the app: a typed prompt and the agent's answer, outside ZeroSub. */
  userTurn(agentId: string, text: string, answer: string): void {
    const agent = this.agents.get(agentId)!;
    const turnId = `turn-${++this.serial}`;
    this.append(agent, { type: "user_message", text, clientMessageId: randomUUID() }, turnId);
    this.append(agent, { type: "assistant_message", text: answer }, turnId);
  }

  /** Daemon-side prompt admission: receipt on the user message, then a short running turn. */
  private admit(agent: FakeAgent, text: string, clientMessageId: string): void {
    agent.messageIds.add(clientMessageId);
    const turnId = `turn-${++this.serial}`;
    const entry = this.append(agent, { type: "user_message", text, clientMessageId }, turnId);
    agent.snapshot.status = "running";
    agent.snapshot.activeTurn = { turnId, startedAt: entry.timestamp };
    const turn = new Promise<void>((resolve) => setTimeout(() => {
      this.append(agent, { type: "assistant_message", text: "Checked the files; continuing from the update." }, turnId);
      agent.snapshot.status = "idle";
      agent.snapshot.activeTurn = null;
      resolve();
    }, 5)).finally(() => this.turns.delete(turn));
    this.turns.add(turn);
  }

  private open(): DaemonTransport {
    const listeners = {
      message: new Set<(data: unknown, isBinary: boolean) => void>(),
      open: new Set<() => void>(),
      close: new Set<(event?: unknown) => void>(),
      error: new Set<(event?: unknown) => void>(),
    };
    let closed = false;
    const frame = (envelope: unknown) => {
      const checked = WSOutboundMessageSchema.safeParse(envelope);
      if (!checked.success) this.violations.push(`outbound ${JSON.stringify(envelope).slice(0, 200)}: ${checked.error.message}`);
      const text = JSON.stringify(envelope);
      setTimeout(() => { if (!closed) for (const listener of listeners.message) listener(text, false); }, 0);
    };
    const connection: Connection = {
      deliver: (message) => frame({ type: "session", message }),
      drop: (reason) => {
        if (closed) return;
        closed = true;
        setTimeout(() => { for (const listener of listeners.close) listener({ code: 1006, reason }); }, 0);
      },
    };
    setTimeout(() => { if (!closed) for (const listener of listeners.open) listener(); }, 0);
    const on = <T>(set: Set<T>) => (listener: T) => { set.add(listener); return () => { set.delete(listener); }; };
    return {
      send: (data) => {
        if (closed) throw new Error("socket closed");
        const text = typeof data === "string" ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data).toString("utf8");
        queueMicrotask(() => { if (!closed) this.receive(connection, frame, text); });
      },
      close: () => { closed = true; },
      onMessage: on(listeners.message),
      onOpen: on(listeners.open),
      onClose: on(listeners.close),
      onError: on(listeners.error),
    };
  }

  private receive(connection: Connection, frame: (envelope: unknown) => void, text: string): void {
    const parsed = WSInboundMessageSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      this.violations.push(`inbound ${text.slice(0, 200)}: ${parsed.error.message}`);
      return;
    }
    const message = parsed.data;
    if (message.type === "ping") return frame({ type: "pong" });
    if (message.type === "hello") {
      return connection.deliver({
        type: "status",
        payload: {
          status: "server_info", serverId: "fake-daemon", hostname: "fake-host", version: "0.9.1",
          features: {
            creationLifecycle: true, agentRequestReceipts: true, workspaceRequestReceipts: true, ownedSubscriptions: true,
            explicitEventSubscriptions: true, selectiveAgentTimeline: true, canonicalSubmittedPrompts: true, agentTurnIdentity: true,
            providersSnapshot: true, providersSnapshotCwd: true, pluginTimelineItems: true, stableProjectIdentity: true,
          },
        },
      });
    }
    if (message.type !== "session") return;
    const request = message.message;
    this.wire.push(request);
    const fault = this.faults.get(request.type);
    if (fault) this.faults.delete(request.type);
    const reply = this.handle(request);
    if (fault) {
      connection.drop("connection reset after the daemon handled the request");
      fault();
    } else if (reply) {
      connection.deliver(reply);
    }
  }

  private handle(request: SessionInboundMessage): Outbound | null {
    switch (request.type) {
      case "fetch_agent_request": {
        const agent = this.agents.get(request.agentId);
        return { type: "fetch_agent_response", payload: { requestId: request.requestId, agent: agent ? structuredClone(agent.snapshot) : null, project: agent ? this.placement() : null, error: null } };
      }
      case "fetch_agents_request": {
        const all = [...this.agents.values()].filter(({ snapshot }) => request.filter?.includeArchived || !snapshot.archivedAt);
        const start = request.page?.cursor ? Number(request.page.cursor) : 0;
        const limit = request.page?.limit ?? 200;
        const page = all.slice(start, start + limit);
        const more = start + limit < all.length;
        return {
          type: "fetch_agents_response",
          payload: {
            requestId: request.requestId, entries: page.map(({ snapshot }) => ({ agent: structuredClone(snapshot), project: this.placement() })),
            pageInfo: { nextCursor: more ? String(start + limit) : null, prevCursor: start ? String(Math.max(0, start - limit)) : null, hasMore: more },
          },
        };
      }
      case "fetch_workspaces_request":
        return {
          type: "fetch_workspaces_response",
          payload: {
            requestId: request.requestId, emptyProjects: [], pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
            entries: [{
              id: WORKSPACE_ID, projectId: "project-1", projectDisplayName: "repo", projectRootPath: this.cwd, workspaceDirectory: this.cwd,
              projectKind: "directory", workspaceKind: "directory", name: "repo", status: "done", activityAt: null, scripts: [],
              gitRuntime: null, githubRuntime: null,
            }],
          },
        };
      case "list_provider_models_request":
        return {
          type: "list_provider_models_response",
          payload: { requestId: request.requestId, provider: request.provider, models: [{ provider: request.provider, id: "synthetic-model", label: "Synthetic", isDefault: true }], error: null, fetchedAt: this.now() },
        };
      case "agent.create.request": return this.create(request);
      case "creation.subscribe.request": {
        const snapshot = this.creations.get(request.idempotencyKey) ?? null;
        return { type: "creation.subscribe.response", payload: { requestId: request.requestId, subscriptionId: `creation-${++this.serial}`, snapshot, error: null } };
      }
      case "subscription.release.request":
        return { type: "subscription.release.response", payload: { requestId: request.requestId, subscriptionId: request.subscriptionId } };
      case "send_agent_message_request": {
        const agent = this.agents.get(request.agentId);
        const respond = (accepted: boolean, error: string | null): Outbound => ({ type: "send_agent_message_response", payload: { requestId: request.requestId, agentId: request.agentId, accepted, error } });
        if (!agent || agent.snapshot.archivedAt) return respond(false, "Agent not found");
        const clientMessageId = request.messageId ?? randomUUID();
        // A repeated client message ID is a retry of the same prompt: acknowledge it, start nothing.
        if (!agent.messageIds.has(clientMessageId)) this.admit(agent, request.text, clientMessageId);
        return respond(true, null);
      }
      case "fetch_agent_timeline_request": return this.timeline(request);
      default:
        this.violations.push(`unsupported request ${request.type}`);
        return "requestId" in request && typeof request.requestId === "string"
          ? { type: "rpc_error", payload: { requestId: request.requestId, requestType: request.type, error: "Not modelled by the fake daemon", code: "unsupported" } }
          : null;
    }
  }

  private placement() {
    return {
      projectKey: "project-1", projectName: "repo",
      checkout: { cwd: this.cwd, isGit: false as const, currentBranch: null, remoteUrl: null, isPaseoOwnedWorktree: false as const, mainRepoRoot: null },
    };
  }

  private create(request: Inbound<"agent.create.request">): Outbound {
    const respond = (creation: Creation): Outbound => ({
      type: "agent.create.response",
      payload: { requestId: request.requestId, agent: structuredClone(this.agents.get(creation.agentId!)!.snapshot), error: null, creation },
    });
    const key = request.idempotencyKey ?? request.requestId;
    const replay = this.creations.get(key);
    if (replay) {
      if (request.agentId && request.agentId !== replay.agentId) {
        return { type: "agent.create.response", payload: { requestId: request.requestId, agent: null, error: "agent_request_key_conflict" } };
      }
      return respond(replay);
    }
    const agentId = request.agentId ?? randomUUID();
    if (this.agents.has(agentId)) return { type: "agent.create.response", payload: { requestId: request.requestId, agent: null, error: `Agent ${agentId} already exists` } };
    const { config } = request;
    const agent = this.addAgent(agentId, {
      provider: config.provider, cwd: config.cwd, workspaceId: request.workspaceId, model: config.model ?? null,
      thinkingOptionId: config.thinkingOptionId ?? null, currentModeId: config.modeId ?? null, title: config.title ?? null, labels: request.labels,
      features: Object.entries(config.featureValues ?? {}).flatMap(([id, value]) => typeof value === "boolean" ? [{ type: "toggle" as const, id, label: id, value }] : []),
    });
    if (request.initialPrompt) this.admit(agent, request.initialPrompt, request.clientMessageId ?? randomUUID());
    const creation: Creation = {
      kind: "agent", idempotencyKey: key, revision: 1, phase: "completed", workspaceId: request.workspaceId ?? null, agentId,
      agent: structuredClone(agent.snapshot), error: null,
    };
    this.creations.set(key, creation);
    return respond(creation);
  }

  private timeline(request: Inbound<"fetch_agent_timeline_request">): Outbound {
    const agent = this.agents.get(request.agentId);
    const direction = request.direction ?? "tail";
    const projection = request.projection ?? "projected";
    const all = agent?.entries ?? [];
    const epoch = agent?.epoch ?? "missing";
    const stale = Boolean(request.cursor && request.cursor.epoch !== epoch);
    const limit = request.limit === 0 ? Number.POSITIVE_INFINITY : request.limit ?? 500;
    let entries: Entry[] = [];
    if (!stale && direction === "tail") entries = all.slice(-limit);
    else if (!stale && direction === "before") entries = all.filter((entry) => entry.seqEnd < request.cursor!.seq).slice(-limit);
    else if (!stale) entries = all.filter((entry) => entry.seqStart > request.cursor!.seq).slice(0, limit);
    const first = entries[0];
    const last = entries.at(-1);
    const maxSeq = all.at(-1)?.seqEnd ?? 0;
    return {
      type: "fetch_agent_timeline_response",
      payload: {
        requestId: request.requestId, agentId: request.agentId, agent: agent ? structuredClone(agent.snapshot) : null, direction, projection, epoch,
        reset: false, staleCursor: stale, gap: false, window: { minSeq: all[0]?.seqStart ?? 0, maxSeq, nextSeq: maxSeq + 1 },
        startCursor: first ? { epoch, seq: first.seqStart } : null, endCursor: last ? { epoch, seq: last.seqEnd } : null,
        hasOlder: Boolean(first && all[0]!.seqStart < first.seqStart), hasNewer: Boolean(last && maxSeq > last.seqEnd),
        entries: structuredClone(entries), error: agent ? null : "Agent not found",
      },
    };
  }
}

let dir: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "zerosub-continuations-sdk-")); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await rm(dir, { recursive: true, force: true });
});

async function setup() {
  const path = join(dir, "state.json");
  const store = new StateStore(path);
  const accounts = ["a", "b"].map((id) => StoredAccountSchema.parse({
    id, family: "codex", label: id.toUpperCase(), kind: "managed", home: join(dir, id),
    identity: `chatgpt|${id}`, email: `${id}@example.invalid`, createdAt: "2026-10-01T00:00:00Z",
  }));
  await store.update((draft) => {
    draft.accounts = accounts;
    draft.defaults.codex = "a";
    draft.bindings[ROOT] = { accountId: "a", source: "thread", at: "now" };
    draft.sessions[ROOT] = { accountId: "a", family: "codex", openedAt: "now" };
  });
  const daemon = new FakeDaemon(dir);
  daemon.addAgent(ROOT);
  daemon.userTurn(ROOT, "Repair the build; preserve the public API.", "The parser has been repaired; tests still need work.");
  const account = (id: string): StoredAccount => accounts.find((entry) => entry.id === id)!;

  /** One plugin process: its own SDK client over a fresh socket to the shared daemon. */
  async function plugin(options: { reconnect?: boolean } = {}) {
    const problems: string[] = [];
    const logger: NonNullable<DaemonClientConfig["logger"]> = {
      debug: () => {}, info: () => {},
      warn: (obj, msg) => problems.push(`${msg ?? ""} ${JSON.stringify(obj)}`),
      error: (obj, msg) => problems.push(`${msg ?? ""} ${JSON.stringify(obj)}`),
    };
    const client = new DaemonClient({
      url: "ws://fake-daemon.invalid/ws", clientId: `zerosub-test-${randomUUID()}`, clientType: "cli", logger,
      transportFactory: daemon.transportFactory, connectTimeoutMs: 1_000,
      reconnect: { enabled: options.reconnect ?? true, baseDelayMs: 5, maxDelayMs: 20 },
    });
    await client.connect();
    const paseo = createPaseoApi(client);
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      await paseo.dispose();
      await client.close();
    };
    cleanups.push(close);
    return { client, paseo, problems, close, manager: new CodexContinuations(new StateStore(path)) };
  }

  /** Every frame matched the real schemas and nothing unmodelled was asked for. */
  function expectCleanWire(...plugins: Array<{ problems: string[] }>) {
    expect(daemon.violations).toEqual([]);
    for (const entry of plugins) expect(entry.problems.filter((problem) => /validation|invalid|Subscription failed/i.test(problem))).toEqual([]);
  }

  // Read state through a fresh StateStore: each plugin process owns its own store instance.
  return { path, daemon, account, plugin, expectCleanWire };
}

const why = "you switched accounts";

describe("Codex continuations through the Paseo SDK", () => {
  it("round-trips A→B→A→B with one created tab and ID-carrying sends", async () => {
    const t = await setup();
    const p = await t.plugin();
    const b = await p.manager.continue(p.paseo, ROOT, t.account("b"), why, "user");
    await t.daemon.idle();
    t.daemon.userTurn(b.agentId, "Only change the test now. Keep the parser.", "Added the regression test; it passes.");
    expect((await p.manager.continue(p.paseo, b.agentId, t.account("a"), why, "user")).agentId).toBe(ROOT);
    await t.daemon.idle();
    t.daemon.userTurn(ROOT, "Commit it.", "Committed the tested change.");
    expect((await p.manager.continue(p.paseo, ROOT, t.account("b"), why, "user")).agentId).toBe(b.agentId);
    await t.daemon.idle();

    const creates = t.daemon.requests("agent.create.request");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ agentId: b.agentId, idempotencyKey: b.agentId, workspaceId: WORKSPACE_ID, labels: { "zerosub.continued-from": ROOT } });
    expect(creates[0]!.initialPrompt).toBeUndefined();
    expect(t.daemon.agents.size).toBe(2);

    const sends = t.daemon.requests("send_agent_message_request");
    expect(sends.map((send) => send.agentId)).toEqual([b.agentId, ROOT, b.agentId]);
    for (const send of sends) {
      expect(send.messageId).toMatch(/^zerosub-handoff-/);
      const receipts = t.daemon.receipts(send.agentId, send.messageId!);
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.turnId).toBeTruthy();
    }
    const toRoot = t.daemon.receipts(ROOT, sends[1]!.messageId!)[0]!.item;
    expect(toRoot.type === "user_message" && toRoot.text).toContain("Only change the test now");
    expect(toRoot.type === "user_message" && toRoot.text).not.toContain("Repair the build");
    const backToB = t.daemon.receipts(b.agentId, sends[2]!.messageId!)[0]!.item;
    expect(backToB.type === "user_message" && backToB.text).toContain("Committed the tested change");
    expect(backToB.type === "user_message" && backToB.text).not.toContain("Added the regression test");

    expect(t.daemon.requests("fetch_agent_timeline_request").every((request) => request.projection === "canonical")).toBe(true);
    const chain = (await new StateStore(t.path).read()).continuations[ROOT]!;
    expect(chain.pending).toBeUndefined();
    expect(chain.activeAgentId).toBe(b.agentId);
    t.expectCleanWire(p);
  });

  it("creates a sub-agent's tab under its parent with Paseo's parent label rather than `parent`", async () => {
    const t = await setup();
    const lead = "0d8f6a1e-3b7c-4f2a-9e55-7c1b2a9d4e10";
    t.daemon.addAgent(lead, { title: "Lead the release" });
    t.daemon.agents.get(ROOT)!.snapshot.labels = { "paseo.parent-agent-id": lead };
    const p = await t.plugin();
    const b = await p.manager.continue(p.paseo, ROOT, t.account("b"), why, "user");
    await t.daemon.idle();

    const creates = t.daemon.requests("agent.create.request");
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatchObject({ agentId: b.agentId, workspaceId: WORKSPACE_ID, labels: { "zerosub.continued-from": ROOT, "paseo.parent-agent-id": lead } });
    // `parent` would go out as callerAgentId, which Paseo also uses to place the agent and attribute its prompts.
    expect(creates[0]!.callerAgentId).toBeUndefined();
    expect(creates[0]!.initialPrompt).toBeUndefined();
    expect(t.daemon.agents.get(b.agentId)!.snapshot.labels).toEqual({ "zerosub.continued-from": ROOT, "paseo.parent-agent-id": lead });
    expect(t.daemon.requests("send_agent_message_request").map((send) => send.agentId)).toEqual([b.agentId]);
    t.expectCleanWire(p);
  });

  it("recovers a delivered handoff whose acknowledgement was lost with the connection, without a second send", async () => {
    const t = await setup();
    const p = await t.plugin();
    const b = await p.manager.continue(p.paseo, ROOT, t.account("b"), why, "user");
    await t.daemon.idle();
    t.daemon.userTurn(b.agentId, "Use the compatibility API.", "Compatibility checks are green.");

    const dropped = t.daemon.dropReplyTo("send_agent_message_request");
    await expect(p.manager.continue(p.paseo, b.agentId, t.account("a"), why, "user")).rejects.toThrow(/connection reset|Connection lost|Transport closed/i);
    await dropped;
    const lost = t.daemon.requests("send_agent_message_request").at(-1)!;
    expect(lost.agentId).toBe(ROOT);
    expect(t.daemon.receipts(ROOT, lost.messageId!)).toHaveLength(1); // Delivered daemon-side.
    expect((await new StateStore(t.path).read()).continuations[ROOT]!.pending).toMatchObject({ agentId: ROOT, messageId: lost.messageId, stage: "sending" });

    await p.client.connect(); // The SDK reconnects on its own; wait until it has.
    await t.daemon.idle();
    expect((await p.manager.continue(p.paseo, b.agentId, t.account("a"), why, "user")).agentId).toBe(ROOT);

    // Count on the wire, not just the timeline: the fake's dedup must not hide a resend.
    expect(t.daemon.requests("send_agent_message_request").filter((send) => send.messageId === lost.messageId)).toHaveLength(1);
    expect(t.daemon.requests("send_agent_message_request")).toHaveLength(2);
    expect(t.daemon.receipts(ROOT, lost.messageId!)).toHaveLength(1);
    expect(t.daemon.agents.size).toBe(2);
    const chain = (await new StateStore(t.path).read()).continuations[ROOT]!;
    expect(chain.pending).toBeUndefined();
    expect(chain.activeAgentId).toBe(ROOT);
    t.expectCleanWire(p);
  });

  it("finishes a creation whose reply was lost with the connection, via the SDK's reconnect recovery", async () => {
    const t = await setup();
    const p = await t.plugin();
    const dropped = t.daemon.dropReplyTo("agent.create.request");
    const b = await p.manager.continue(p.paseo, ROOT, t.account("b"), why, "user");
    await dropped;
    await t.daemon.idle();

    expect(t.daemon.requests("agent.create.request")).toHaveLength(1);
    expect(t.daemon.requests("creation.subscribe.request")).toMatchObject([{ kind: "agent", idempotencyKey: b.agentId }]);
    expect(t.daemon.agents.size).toBe(2);
    const sends = t.daemon.requests("send_agent_message_request");
    expect(sends.map((send) => send.agentId)).toEqual([b.agentId]);
    expect(t.daemon.receipts(b.agentId, sends[0]!.messageId!)).toHaveLength(1);
    expect((await new StateStore(t.path).read()).continuations[ROOT]!.pending).toBeUndefined();
    t.expectCleanWire(p);
  });

  it("reuses the reserved ID after the plugin restarts during creation, so no second tab appears", async () => {
    const t = await setup();
    const first = await t.plugin({ reconnect: false });
    const dropped = t.daemon.dropReplyTo("agent.create.request");
    const attempt = first.manager.continue(first.paseo, ROOT, t.account("b"), why, "user");
    await dropped;
    await first.close(); // The plugin process goes away with the creation unacknowledged.
    await expect(attempt).rejects.toThrow(/closed/i);
    const reserved = (await new StateStore(t.path).read()).continuations[ROOT]!.pending!;
    expect(reserved.stage).toBe("creating");
    expect(t.daemon.agents.has(reserved.agentId)).toBe(true); // Created daemon-side anyway.

    const second = await t.plugin();
    expect((await second.manager.continue(second.paseo, ROOT, t.account("b"), why, "user")).agentId).toBe(reserved.agentId);
    await t.daemon.idle();

    const creates = t.daemon.requests("agent.create.request");
    expect(creates.length).toBeGreaterThanOrEqual(1);
    for (const create of creates) expect(create).toMatchObject({ agentId: reserved.agentId, idempotencyKey: reserved.agentId });
    expect(t.daemon.agents.size).toBe(2);
    const sends = t.daemon.requests("send_agent_message_request");
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ agentId: reserved.agentId, messageId: reserved.messageId });
    expect(t.daemon.receipts(reserved.agentId, reserved.messageId)).toHaveLength(1);
    expect((await new StateStore(t.path).read()).continuations[ROOT]!.pending).toBeUndefined();
    t.expectCleanWire(first, second);
  });
});
