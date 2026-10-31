import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTimelineItem, FamilyAdapter } from "./adapter";
import { CodexContinuations, fitInstructions } from "./continuations";
import { Service } from "./service";
import { StateStore, StoredAccountSchema, salvageState } from "./state";
import type { FamilyResolver } from "./families";
import { preferences } from "../shared/preferences";
import type { SwitchRow } from "../shared/timeline";

type PaseoApi = PluginHookContext["paseo"];
type Create = Parameters<ReturnType<PaseoApi["workspaces"]["ref"]>["agents"]["create"]>[0];
type Snapshot = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"];
type Entry = { item: AgentTimelineItem; timestamp: string; seqStart: number; seqEnd: number; turnId?: string };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "zerosub-continuations-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function setup() {
  const path = join(dir, "state.json");
  let store = new StateStore(path);
  const accounts = ["a", "b", "c"].map((id) => StoredAccountSchema.parse({
    id, family: "codex", label: id.toUpperCase(), kind: "managed", home: join(dir, id),
    identity: `chatgpt|${id}`, email: `${id}@example.invalid`, createdAt: "2026-10-01T00:00:00Z",
  }));
  await store.update((draft) => {
    draft.accounts = accounts;
    draft.defaults.codex = "a";
    draft.bindings.root = { accountId: "a", source: "thread", at: "now" };
    draft.sessions.root = { accountId: "a", family: "codex", openedAt: "now" };
  });
  const agents = new Map<string, Snapshot>();
  const timelines = new Map<string, Entry[]>();
  const epochs = new Map<string, string>();
  let clock = 0;
  function addAgent(id: string, values: Partial<Snapshot> = {}) {
    const agent = {
      id, provider: "codex", model: "synthetic-model", title: "Fix the build", cwd: dir, workspaceId: "workspace-1",
      status: "idle", currentModeId: "full-access", thinkingOptionId: "high", labels: {},
      features: [{ type: "toggle", id: "fast_mode", value: true, label: "Fast" }],
      archivedAt: null, lastUserMessageAt: "2026-10-01T00:00:00Z", pendingPermissions: [], ...values,
    } as Snapshot;
    agents.set(id, agent);
    timelines.set(id, []);
    epochs.set(id, "epoch-1");
    return agent;
  }
  function add(id: string, item: AgentTimelineItem) {
    const entries = timelines.get(id)!;
    const seq = entries.length + 1;
    entries.push({ item, timestamp: new Date(1_700_000_000_000 + clock++ * 1000).toISOString(), seqStart: seq, seqEnd: seq, turnId: "accepted-turn" });
    if (item.type === "user_message") agents.get(id)!.lastUserMessageAt = entries.at(-1)!.timestamp;
  }
  addAgent("root");
  add("root", { type: "user_message", text: "Repair the build; preserve the public API." });
  add("root", { type: "assistant_message", text: "The parser has been repaired; tests still need work." });
  const created: Create[] = [];
  const sent: Array<{ id: string; text: string }> = [];
  const notes: Array<{ agentId: string; row: SwitchRow }> = [];
  const create = vi.fn(async (request: Create) => {
    created.push(request);
    const binding = (await store.read()).bindings[request.agentId!]!;
    // Assert the real routing prerequisite: pre-binding exists before create can open a session.
    expect(binding.accountId).toBeTruthy();
    addAgent(request.agentId!, { labels: request.labels, title: request.title, currentModeId: request.config.modeId ?? null, lastUserMessageAt: null });
    await store.update((draft) => { draft.sessions[request.agentId!] = { accountId: binding.accountId, family: "codex", openedAt: "now" }; });
    if (request.prompt) add(request.agentId!, { type: "user_message", text: request.prompt, clientMessageId: request.clientMessageId });
  });
  const send = vi.fn(async (id: string, text: string, options?: { messageId?: string }) => {
    sent.push({ id, text });
    add(id, { type: "user_message", text, clientMessageId: options?.messageId });
  });
  const refetch = vi.fn(async (id: string, options: { direction?: string; cursor?: { epoch: string; seq: number }; limit?: number }) => {
    const all = timelines.get(id);
    if (!all) throw new Error("missing timeline");
    const eligible = all.filter((entry) => options.direction !== "before" || entry.seqEnd < options.cursor!.seq);
    const entries = eligible.slice(-(options.limit ?? 500));
    const epoch = epochs.get(id)!;
    return {
      epoch, window: { minSeq: 1, maxSeq: all.length, nextSeq: all.length + 1 }, entries,
      startCursor: entries.length ? { epoch, seq: entries[0]!.seqStart } : null,
      endCursor: entries.length ? { epoch, seq: entries.at(-1)!.seqEnd } : null,
      hasOlder: eligible.length > entries.length, gap: false, staleCursor: false,
    };
  });
  const paseo = {
    providers: { listModels: async () => ({ models: [{ id: "synthetic-model", isDefault: true }] }) },
    workspaces: { ref: () => ({ agents: { create } }) },
    agents: {
      create,
      list: async () => ({ entries: [...agents.values()].map((agent) => ({ agent })), pageInfo: { hasMore: false } }),
      ref: (id: string) => ({
        refresh: async () => agents.has(id) ? { agent: structuredClone(agents.get(id)) } : null,
        send: (text: string, options?: { messageId?: string }) => send(id, text, options),
        timeline: { refetch: (options: Parameters<typeof refetch>[1]) => refetch(id, options), append: async (item: { data: SwitchRow }) => { notes.push({ agentId: id, row: item.data }); } },
      }),
    },
  } as unknown as PaseoApi;
  const manager = new CodexContinuations(store);
  const switchTo = (id: string, account: string, runner = manager) => runner.continue(paseo, id, accounts.find((a) => a.id === account)!, "you switched accounts", "user");
  const adapter = {
    family: "codex", portable: false, usageSpacingMs: 0, detectLimit: () => ({ kind: "budget", resetsAt: new Date(Date.now() + 60_000).toISOString(), message: "limit" }),
    detectSignOut: () => null, env: async (home: string) => ({ CODEX_HOME: home }), prepareHome: async () => {},
    redeemReset: async () => ({ outcome: "reset", message: "Synthetic reset", left: 0 }),
  } as unknown as FamilyAdapter;
  const service = () => new Service({ codex: adapter, claude: adapter }, store, { resolve: async () => ({ codex: "codex" }) } as unknown as FamilyResolver);
  const restart = () => { store = new StateStore(path); return new CodexContinuations(store); };
  return { path, get store() { return store; }, accounts, agents, addAgent, timelines, epochs, add, created, sent, notes, create, send, refetch, paseo, switchTo, manager, service, restart };
}

describe("Codex account continuations", () => {
  it("reuses A/B/A/B tabs and sends current instructions and progress without recursive transcripts", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    expect(t.created[0]!.config).toEqual({ provider: "codex/synthetic-model", modeId: "full-access", thinkingOptionId: "high", featureValues: { fast_mode: true } });
    t.add(b.agentId, { type: "user_message", text: "Only change the test now. Keep the parser." });
    t.add(b.agentId, { type: "assistant_message", text: "Added the regression test; it passes." });
    expect((await t.switchTo(b.agentId, "a")).agentId).toBe("root");
    const updateA = t.sent.at(-1)!.text;
    expect(updateA).toContain("Only change the test now");
    expect(updateA).toContain("Added the regression test");
    expect(updateA).toContain("git status and diff");
    expect(updateA).not.toContain("Repair the build");
    t.add("root", { type: "assistant_message", text: "Committed the tested change." });
    expect((await t.switchTo("root", "b")).agentId).toBe(b.agentId);
    expect(t.created).toHaveLength(1);
    expect(t.sent.at(-1)!.text).toContain("Committed the tested change");
    expect(t.sent.at(-1)!.text).not.toContain("The parser has been repaired");
    expect(t.sent.at(-1)!.text).not.toContain("Added the regression test");
    expect(t.sent.at(-1)!.text.length).toBeLessThan(updateA.length + 100);
    const persisted = await readFile(t.path, "utf8");
    expect(persisted).not.toContain("Repair the build");
    expect(persisted).not.toContain("regression test");
    expect((await t.store.read()).bindings.root?.accountId).toBe("a");
    expect((await t.store.read()).bindings[b.agentId]?.source).toBe("user");
  });

  it("reuses tabs for an agent in a workspace subfolder", async () => {
    const t = await setup();
    t.agents.get("root")!.cwd = join(dir, "packages", "app");
    // As in the SDK, a workspace's new agent starts in the workspace's own directory.
    const b = await t.switchTo("root", "b");
    expect(t.agents.get(b.agentId)!.cwd).toBe(dir);
    expect((await t.switchTo(b.agentId, "a")).agentId).toBe("root");
    expect((await t.switchTo("root", "b")).agentId).toBe(b.agentId);
    expect(t.created).toHaveLength(1);
  });

  it("keeps an intermediate account's instructions across a three-account round trip", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.add(b.agentId, { type: "user_message", text: "Use the compatibility API." });
    const c = await t.switchTo(b.agentId, "c");
    t.add(c.agentId, { type: "assistant_message", text: "Compatibility checks are green." });
    expect((await t.switchTo(c.agentId, "a")).agentId).toBe("root");
    expect(t.sent.at(-1)!.text).toContain("Use the compatibility API");
    expect(t.sent.at(-1)!.text).toContain("Compatibility checks are green");
    expect(t.created).toHaveLength(2);
  });

  it("persists reuse and watermarks across a plugin restart", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.add(b.agentId, { type: "assistant_message", text: "Latest work after restart." });
    const restarted = t.restart();
    expect((await t.switchTo(b.agentId, "a", restarted)).agentId).toBe("root");
    expect(t.created).toHaveLength(1);
    expect(t.sent.at(-1)!.text).toContain("Latest work after restart");
  });

  it("isolates independent tasks in the same workspace and account", async () => {
    const t = await setup();
    const first = await t.switchTo("root", "b");
    t.addAgent("independent");
    t.add("independent", { type: "user_message", text: "A different task." });
    await t.store.update((draft) => { draft.bindings.independent = { accountId: "a", source: "thread", at: "now" }; });
    const second = await t.switchTo("independent", "b");
    expect(second.agentId).not.toBe(first.agentId);
    expect(t.sent.at(-1)!.text).not.toContain("Repair the build");
  });

  it("deduplicates concurrent manual and automatic switch requests", async () => {
    const t = await setup();
    const target = t.accounts[1]!;
    const [a, b] = await Promise.all([
      t.switchTo("root", "b"),
      t.manager.continue(t.paseo, "root", target, "its account reached a limit", "auto"),
    ]);
    expect(a.agentId).toBe(b.agentId);
    expect(t.created).toHaveLength(1);
    // As in the daemon, an accepted message starts a turn in its tab.
    const send = t.send.getMockImplementation()!;
    t.send.mockImplementation(async (id, text, options) => { await send(id, text, options); t.agents.get(id)!.status = "running"; });
    const results = await Promise.allSettled([t.switchTo(a.agentId, "a"), t.switchTo(a.agentId, "c")]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(t.sent).toHaveLength(2);
    expect(t.created).toHaveLength(1);
  });

  it.each(["archived", "deleted", "workspace", "provider", "identity", "member", "binding"])("creates a replacement for a %s target without moving its old thread", async (reason) => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    const original = t.agents.get("root")!;
    if (reason === "archived") original.archivedAt = "2026-10-01T00:00:00Z";
    if (reason === "deleted") t.agents.delete("root");
    if (reason === "workspace") original.workspaceId = "another-workspace";
    if (reason === "provider") original.provider = "another-codex-provider";
    if (reason === "identity") await t.store.update((draft) => { draft.accounts[0]!.identity = "chatgpt|replacement"; });
    // Another member of the same ChatGPT workspace.
    if (reason === "member") await t.store.update((draft) => { draft.accounts[0]!.identity = "chatgpt|a|someone-else@example.invalid"; });
    if (reason === "binding") await t.store.update((draft) => { draft.bindings.root!.accountId = "c"; });
    if (reason === "deleted") {
      // History can still be read from the persisted timeline after the tab disappears.
      t.agents.delete("root");
    }
    const result = await t.switchTo(b.agentId, "a");
    expect(result.agentId).not.toBe("root");
    expect(t.created).toHaveLength(2);
    expect(t.agents.get("root")?.archivedAt).toBe(reason === "deleted" ? undefined : original.archivedAt);
  });

  it.each(["before", "during"])("reuses a tab recorded under the workspace-only key when the account's key gains its email %s the switch", async (when) => {
    const t = await setup();
    // As on 1.4.0, the task's record keeps the workspace-only key chatgpt|a.
    const b = await t.switchTo("root", "b");
    const upgrade = () => t.store.update((draft) => { draft.accounts[0]!.identity = "chatgpt|a|a@example.invalid"; });
    if (when === "before") await upgrade();
    else {
      const read = t.refetch.getMockImplementation()!;
      t.refetch.mockImplementationOnce(async (...args) => { await upgrade(); return read(...args); });
    }
    expect((await t.switchTo(b.agentId, "a")).agentId).toBe("root");
    expect(t.created).toHaveLength(1);
  });

  it.each(["running", "initializing", "permission"])("does not start another copy while the destination is %s", async (status) => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    if (status === "permission") t.agents.get("root")!.pendingPermissions = [{}] as never;
    else t.agents.get("root")!.status = status as Snapshot["status"];
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/working|permission/);
    expect(t.created).toHaveLength(1);
    expect(t.sent).toHaveLength(1);
  });

  it.each(["disabled", "signedOut", "limited", "removed"])("rejects a destination account that becomes %s", async (reason) => {
    const t = await setup();
    await t.store.update((draft) => {
      if (reason === "disabled") draft.accounts[1]!.disabled = true;
      if (reason === "signedOut") draft.accounts[1]!.signedIn = false;
      if (reason === "limited") draft.accounts[1]!.limitedUntil = new Date(Date.now() + 60_000).toISOString();
      if (reason === "removed") draft.accounts.splice(1, 1);
    });
    await expect(t.switchTo("root", "b")).rejects.toThrow(/no longer available/);
    expect(t.created).toHaveLength(0);
  });

  it("does not auto-resume canceled turns or switch when automatic continuation is disabled", async () => {
    const t = await setup();
    const service = t.service();
    const event = { agent: t.agents.get("root"), turnId: "turn-1", outcome: { kind: "canceled" }, timeline: [] };
    await service.onTurnEnded(event as never, { paseo: t.paseo } as never);
    expect(t.created).toHaveLength(0);
    service.setPreferences(preferences.schema.parse({ autoContinue: false }));
    await service.onTurnEnded({ ...event, outcome: { kind: "failed" } } as never, { paseo: t.paseo } as never);
    expect(t.created).toHaveLength(0);
  });

  it("uses the same path for manual selection and limit failover", async () => {
    const t = await setup();
    const service = t.service();
    const b = (await service.setAgentAccount(t.paseo, "root", "b")).continuedIn!;
    t.add(b.agentId, { type: "user_message", text: "Current user correction before the limit." });
    await service.onTurnEnded({ agent: t.agents.get(b.agentId), turnId: "limit-turn", outcome: { kind: "failed" }, timeline: [] } as never, { paseo: t.paseo } as never);
    expect(t.created).toHaveLength(1);
    expect(t.sent.at(-1)?.id).toBe("root");
    expect(t.sent.at(-1)?.text).toContain("Current user correction before the limit");
  });

  it("continues an account-limit turn in error status into an available account's existing error-status tab", async () => {
    const t = await setup();
    const service = t.service();
    const b = (await service.setAgentAccount(t.paseo, "root", "b")).continuedIn!;
    t.agents.get("root")!.status = "error";
    t.agents.get(b.agentId)!.status = "error";
    await service.onTurnEnded({ agent: t.agents.get(b.agentId), turnId: "failed-turn", outcome: { kind: "failed" }, timeline: [] } as never, { paseo: t.paseo } as never);
    expect(t.sent.at(-1)?.id).toBe("root");
    expect(t.created).toHaveLength(1);
  });

  it("deduplicates public manual switching against cross-provider and automatic triggers", async () => {
    const t = await setup();
    const service = t.service();
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const create = t.create.getMockImplementation()!;
    t.create.mockImplementationOnce(async (request) => { started(); await gate; await create(request); });
    const switching = service.setAgentAccount(t.paseo, "root", "b");
    await entered;
    await expect(service.forkAgent(t.paseo, "root")).rejects.toThrow(/already switching/);
    await service.onTurnEnded({ agent: t.agents.get("root"), turnId: "limit-turn", outcome: { kind: "failed" }, timeline: [] } as never, { paseo: t.paseo } as never);
    release();
    await switching;
    expect(t.created).toHaveLength(1);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect((await t.store.read()).accounts.find((account) => account.id === "a")!.limitedUntil).not.toBeNull();
    expect((await t.store.read()).accounts.find((account) => account.id === "b")!.limitedUntil).toBeNull();
  });

  it("does not send a snapshot made before a newer source instruction", async () => {
    const t = await setup();
    const read = t.refetch.getMockImplementation()!;
    t.refetch.mockImplementationOnce(async (...args) => {
      const page = await read(...args);
      t.add("root", { type: "user_message", text: "Pause this task." });
      return page;
    });
    await expect(t.switchTo("root", "b")).rejects.toThrow(/changed during the handoff/);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.created).toHaveLength(0);
  });

  it("does not advance discarded watermarks when falling back to the source handoff", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    const c = await t.switchTo(b.agentId, "c");
    const before = (await t.store.read()).continuations.root!.members[b.agentId]!.seen.root;
    t.add("root", { type: "assistant_message", text: "A late parked-tab update." });
    await t.store.update((draft) => {
      draft.continuations.root!.members.deleted = { accountId: "a", identity: null, email: null, seen: {} };
    });
    await t.switchTo(c.agentId, "b");
    expect((await t.store.read()).continuations.root!.members[b.agentId]!.seen.root).toEqual(before);
    expect(t.sent.at(-1)!.text).toContain("An earlier tab is unavailable or moved");
  });

  it("returns to deltas after replacing deleted history, without losing the task for a new account", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.agents.delete("root");
    t.timelines.delete("root");
    const a = await t.switchTo(b.agentId, "a");
    await t.switchTo(a.agentId, "b");
    t.add(b.agentId, { type: "assistant_message", text: "Only this progress is new now." });
    await t.switchTo(b.agentId, "a");
    expect(t.sent.at(-1)!.text).toContain("Only this progress is new now");
    expect(t.sent.at(-1)!.text).not.toContain("Repair the build");
    expect(t.sent.at(-1)!.text).not.toContain("An earlier tab is unavailable or moved");
    await t.switchTo(a.agentId, "c");
    expect(t.sent.at(-1)!.text).toContain("Repair the build");
    expect(t.created).toHaveLength(3); // B, replacement A and first C.
  });

  it("retains the inherited original task after a downgrade discarded reuse metadata and the original tab is gone", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.agents.delete("root");
    t.timelines.delete("root");
    await t.store.update((draft) => { draft.continuations = {}; });
    const restarted = t.restart();
    const a = await t.switchTo(b.agentId, "a", restarted);
    expect(t.sent.at(-1)!.text).toContain("Repair the build");
    await t.switchTo(a.agentId, "b", restarted);
    t.add(b.agentId, { type: "assistant_message", text: "New progress after re-upgrading." });
    await t.switchTo(b.agentId, "a", restarted);
    expect(t.sent.at(-1)!.text).toContain("New progress after re-upgrading");
    expect(t.sent.at(-1)!.text).not.toContain("Repair the build");
  });

  it("recovers a delivered handoff after its acknowledgement is lost, without sending twice", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.send.mockImplementationOnce(async (id, text, options) => {
      t.add(id, { type: "user_message", text, clientMessageId: options?.messageId });
      throw new Error("connection lost after delivery");
    });
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/connection lost/);
    const restarted = t.restart();
    expect((await t.switchTo(b.agentId, "a", restarted)).agentId).toBe("root");
    expect(t.send).toHaveBeenCalledTimes(2);
    expect((await new StateStore(t.path).read()).continuations.root?.pending).toBeUndefined();
  });

  it("blocks uncertain failed dispatches until the user archives the destination", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.send.mockRejectedValueOnce(new Error("disconnected"));
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/disconnected/);
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/could not be confirmed/);
    expect(t.send).toHaveBeenCalledTimes(2);
    t.agents.get("root")!.archivedAt = "2026-10-01T00:00:00Z";
    expect((await t.switchTo(b.agentId, "a")).agentId).not.toBe("root");
  });

  it("stops when timeline reading fails instead of starting with stale context", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.refetch.mockRejectedValueOnce(new Error("timeline unavailable"));
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/timeline unavailable/);
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it("does not create a continuation with missing task instructions", async () => {
    const t = await setup();
    t.timelines.set("root", []);
    await expect(t.switchTo("root", "b")).rejects.toThrow(/instructions/);
    expect(t.created).toHaveLength(0);
    expect(t.send).not.toHaveBeenCalled();
  });

  it("shortens very long instructions instead of refusing the handoff", async () => {
    const t = await setup();
    for (let i = 0; i < 30; i++) t.add("root", { type: "user_message", text: `Pasted log ${i}: ${"x".repeat(5_000)}` });
    t.add("root", { type: "user_message", text: "Latest: only fix the flaky test." });
    const b = await t.switchTo("root", "b");
    const prompt = t.sent.at(-1)!.text;
    expect(t.sent.at(-1)!.id).toBe(b.agentId);
    expect(prompt).toContain("Repair the build; preserve the public API.");
    expect(prompt).toContain("Latest: only fix the flaky test.");
    expect(prompt).toMatch(/\[… \d+ earlier instructions omitted to fit this update …\]/);
    expect(prompt.length).toBeLessThan(70_000);
  });

  it("reopens a closed destination through the same SDK send without changing its pin", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.agents.get("root")!.status = "closed";
    expect((await t.switchTo(b.agentId, "a")).agentId).toBe("root");
    expect((await t.store.read()).bindings.root?.accountId).toBe("a");
    expect(t.created).toHaveLength(1);
  });

  it("does not continue in a tab with a different permission mode", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.agents.get(b.agentId)!.currentModeId = "auto";
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/different permission mode/);
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it("switches back to a parked tab the user typed in, sending only the other tab's updates", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.add(b.agentId, { type: "assistant_message", text: "B finished the parser." });
    t.add("root", { type: "user_message", text: "Also update the changelog." });
    expect((await t.switchTo(b.agentId, "a")).agentId).toBe("root");
    expect(t.sent.at(-1)!.text).toContain("B finished the parser");
    expect(t.sent.at(-1)!.text).not.toContain("Also update the changelog");
    expect(t.created).toHaveLength(1);
  });

  it("lets a parked tab the user typed in take the task over", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.add(b.agentId, { type: "assistant_message", text: "B finished the parser." });
    t.add("root", { type: "user_message", text: "Also update the changelog." });
    expect(await t.manager.continuesElsewhere(t.paseo, "root")).toBeNull();
    expect((await t.manager.continuesElsewhere(t.paseo, b.agentId))?.agentId).toBe("root");
    expect((await t.switchTo("root", "b")).agentId).toBe(b.agentId);
    expect(t.sent.at(-1)!.text).toContain("Also update the changelog");
    expect(t.sent.at(-1)!.text).not.toContain("B finished the parser");
    expect(t.created).toHaveLength(1);
  });

  it("doesn't let a tab moved to another workspace take the task over", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.agents.get("root")!.workspaceId = "another-workspace";
    t.add("root", { type: "user_message", text: "Work on something else here." });
    expect(await t.manager.continuesElsewhere(t.paseo, b.agentId)).toBeNull();
    const c = await t.manager.continue(t.paseo, b.agentId, t.accounts[2]!, "a limit", "auto");
    expect(t.sent.at(-1)!.id).toBe(c.agentId);
    expect(t.sent.at(-1)!.text).not.toContain("Work on something else here");
  });

  it("fails over automatically from a parked tab the user typed in", async () => {
    const t = await setup();
    const service = t.service();
    const b = (await service.setAgentAccount(t.paseo, "root", "b")).continuedIn!;
    t.add("root", { type: "user_message", text: "Also update the changelog." });
    await service.onTurnEnded({ agent: t.agents.get("root"), turnId: "limit-turn", outcome: { kind: "failed" }, timeline: [] } as never, { paseo: t.paseo } as never);
    expect(t.sent.at(-1)!.text).toContain("Also update the changelog");
    expect([b.agentId, t.created.at(-1)!.agentId]).toContain(t.sent.at(-1)!.id);
    expect(await t.manager.continuesElsewhere(t.paseo, "root")).not.toBeNull();
  });

  it("lets the user switch from a parked tab without waking it", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.add(b.agentId, { type: "assistant_message", text: "B finished the parser." });
    const c = await t.switchTo("root", "c");
    expect(c.agentId).not.toBe(b.agentId);
    expect(t.sent.at(-1)!.text).toContain("B finished the parser");
    expect(t.sent.map(({ id }) => id)).not.toContain("root");
    await expect(t.manager.continue(t.paseo, b.agentId, t.accounts[0]!, "a limit", "auto")).rejects.toThrow(/now continues in/);
  });

  it("retries failed creation using its reserved ID, with no work dispatched before creation", async () => {
    const t = await setup();
    t.create.mockRejectedValueOnce(new Error("creation failed"));
    await expect(t.switchTo("root", "b")).rejects.toThrow(/creation failed/);
    const reserved = (await t.store.read()).continuations.root!.pending!.agentId;
    expect(t.send).not.toHaveBeenCalled();
    const restarted = t.restart();
    expect((await t.switchTo("root", "b", restarted)).agentId).toBe(reserved);
    expect(t.created[0]!.prompt).toBeUndefined();
    expect(t.created[0]!.idempotencyKey).toBe(reserved);
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it("doesn't mistake a rejected submitted prompt for accepted delivery", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.send.mockImplementationOnce(async (id, text, options) => {
      t.add(id, { type: "user_message", text, clientMessageId: options?.messageId });
      delete t.timelines.get(id)!.at(-1)!.turnId;
      throw new Error("prompt rejected");
    });
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/prompt rejected/);
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/could not be confirmed/);
    expect(t.send).toHaveBeenCalledTimes(2);
  });

  it("waits for a busy pending destination instead of suggesting its archive", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.send.mockRejectedValueOnce(new Error("disconnected"));
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/disconnected/);
    t.agents.get("root")!.status = "running";
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/may still be starting/);
    expect(t.send).toHaveBeenCalledTimes(2);
  });

  it("can retarget a failed unstarted creation to another account", async () => {
    const t = await setup();
    t.create.mockRejectedValueOnce(new Error("creation failed"));
    await expect(t.switchTo("root", "b")).rejects.toThrow(/creation failed/);
    const c = await t.switchTo("root", "c");
    expect((await t.store.read()).bindings[c.agentId]!.accountId).toBe("c");
    expect(t.created).toHaveLength(1);
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it("keeps a late unstarted creation available after retargeting", async () => {
    const t = await setup();
    const create = t.create.getMockImplementation()!;
    t.create.mockImplementationOnce(async (request) => { await create(request); throw new Error("lost create reply"); });
    await expect(t.switchTo("root", "b")).rejects.toThrow(/lost create reply/);
    const earlierB = t.created[0]!.agentId;
    const c = await t.switchTo("root", "c");
    expect((await t.switchTo(c.agentId, "b")).agentId).toBe(earlierB);
    expect(t.created).toHaveLength(2);
    expect(t.sent.at(-1)!.text).toContain("Repair the build");
  });

  it("recovers a recent receipt without rereading a long old timeline", async () => {
    const t = await setup();
    for (let i = 0; i < 600; i++) t.add("root", { type: "assistant_message", text: `Old progress ${i}` });
    const b = await t.switchTo("root", "b");
    t.send.mockImplementationOnce(async (id, text, options) => {
      t.add(id, { type: "user_message", text, clientMessageId: options?.messageId });
      throw new Error("lost reply");
    });
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/lost reply/);
    t.refetch.mockClear();
    expect((await t.switchTo(b.agentId, "a", t.restart())).agentId).toBe("root");
    expect(t.refetch).toHaveBeenCalledTimes(1);
  });

  it("records a parked tab's limit but does not resume it after a reset, and says why once", async () => {
    const t = await setup();
    const service = t.service();
    const log = vi.spyOn(console, "log");
    await service.setAgentAccount(t.paseo, "root", "b");
    const b = t.created[0]!.agentId!;
    const limit = { agent: t.agents.get("root"), turnId: "parked-limit", outcome: { kind: "failed" }, timeline: [] };
    await service.onTurnEnded(limit as never, { paseo: t.paseo } as never);
    expect((await t.store.read()).accounts[0]!.limitedUntil).not.toBeNull();
    expect(t.send).toHaveBeenCalledTimes(1);
    const skipped = t.notes.filter(({ agentId, row }) => agentId === "root" && row.outcome === "stayed");
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.row.detail).toContain(`continues in “${t.agents.get(b)!.title}”`);
    expect(log.mock.calls.some(([line]) => String(line).includes(`not switching root automatically: its task continues in ${b}`))).toBe(true);
    await service.onTurnEnded({ ...limit, turnId: "parked-limit-2" } as never, { paseo: t.paseo } as never);
    expect(t.notes.filter(({ agentId, row }) => agentId === "root" && row.outcome === "stayed")).toHaveLength(1);
    log.mockRestore();
    vi.useFakeTimers();
    try {
      expect((await service.redeem(t.paseo, "a", "root")).continued).toBe(false);
      expect(t.send).toHaveBeenCalledTimes(1);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("resumes a tab after a reset once the tab its task moved to is archived", async () => {
    const t = await setup();
    const service = t.service();
    await service.setAgentAccount(t.paseo, "root", "b");
    const b = t.created[0]!.agentId!;
    await service.onTurnEnded({ agent: t.agents.get("root"), turnId: "parked-limit", outcome: { kind: "failed" }, timeline: [] } as never, { paseo: t.paseo } as never);
    t.agents.get(b)!.archivedAt = "2026-10-02T00:00:00Z";
    expect(await t.manager.continuesElsewhere(t.paseo, "root")).toBeNull();
    const notes = t.notes.length;
    vi.useFakeTimers();
    try {
      expect((await service.redeem(t.paseo, "a", "root")).continued).toBe(true);
      expect(t.sent.at(-1)!.id).toBe("root");
      expect(t.notes.slice(notes).some(({ row }) => row.detail?.includes("continues in"))).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("fails over automatically once the tab its task moved to is archived", async () => {
    const t = await setup();
    const service = t.service();
    const b = (await service.setAgentAccount(t.paseo, "root", "b")).continuedIn!;
    t.agents.get(b.agentId)!.archivedAt = "2026-10-02T00:00:00Z";
    await service.onTurnEnded({ agent: t.agents.get("root"), turnId: "limit-turn", outcome: { kind: "failed" }, timeline: [] } as never, { paseo: t.paseo } as never);
    expect((await t.store.read()).accounts[0]!.limitedUntil).not.toBeNull();
    expect(t.send).toHaveBeenCalledTimes(2);
    expect(["root", b.agentId]).not.toContain(t.sent.at(-1)!.id);
    expect(t.notes.some(({ agentId, row }) => agentId === "root" && row.outcome === "stayed")).toBe(false);
  });

  it("resumes after a reset when an automatic hand-off couldn't create its tab", async () => {
    const t = await setup();
    const service = t.service();
    t.create.mockRejectedValueOnce(new Error("creation failed"));
    await service.onTurnEnded({ agent: t.agents.get("root"), turnId: "limit-turn", outcome: { kind: "failed" }, timeline: [] } as never, { paseo: t.paseo } as never);
    expect((await t.store.read()).continuations.root!.pending?.stage).toBe("creating");
    expect(t.notes.some(({ agentId, row }) => agentId === "root" && row.detail?.includes("creation failed"))).toBe(true);
    expect(await t.manager.continuesElsewhere(t.paseo, "root")).toBeNull();
    const notes = t.notes.length;
    vi.useFakeTimers();
    try {
      expect((await service.redeem(t.paseo, "a", "root")).continued).toBe(true);
      expect(t.sent.at(-1)!.id).toBe("root");
      expect(t.notes.slice(notes).some(({ row }) => row.detail?.includes("continues in"))).toBe(false);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each(["rejected", "checked"])("fails over again after an automatic hand-off's creation was %s", async (failure) => {
    const t = await setup();
    const service = t.service();
    const create = t.create.getMockImplementation()!;
    if (failure === "rejected") t.create.mockRejectedValueOnce(new Error("creation failed"));
    else {
      // The tab is made, but its account is disabled before the prompt can go.
      t.create.mockImplementationOnce(async (request) => {
        await create(request);
        await t.store.update((draft) => { draft.accounts[1]!.disabled = true; });
      });
    }
    const limit = { agent: t.agents.get("root"), outcome: { kind: "failed" }, timeline: [] };
    await service.onTurnEnded({ ...limit, turnId: "limit-1" } as never, { paseo: t.paseo } as never);
    expect(t.send).not.toHaveBeenCalled();
    expect(await t.manager.continuesElsewhere(t.paseo, "root")).toBeNull();
    await service.onTurnEnded({ ...limit, turnId: "limit-2" } as never, { paseo: t.paseo } as never);
    expect(t.send).toHaveBeenCalledTimes(1);
    const next = t.created.at(-1)!.agentId!;
    expect(t.sent[0]!.id).toBe(next);
    expect((await t.store.read()).bindings[next]!.accountId).toBe(failure === "rejected" ? "b" : "c");
    expect((await t.store.read()).continuations.root!.pending).toBeUndefined();
    expect((await t.manager.continuesElsewhere(t.paseo, "root"))?.agentId).toBe(next);
  });

  it("doesn't let an archived destination of an unconfirmed send hold the task", async () => {
    const t = await setup();
    const service = t.service();
    const b = await t.switchTo("root", "b");
    t.send.mockRejectedValueOnce(new Error("disconnected"));
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/disconnected/);
    expect((await t.manager.continuesElsewhere(t.paseo, b.agentId))?.agentId).toBe("root");
    t.agents.get("root")!.archivedAt = "2026-10-02T00:00:00Z";
    expect(await t.manager.continuesElsewhere(t.paseo, b.agentId)).toBeNull();
    await service.onTurnEnded({ agent: t.agents.get(b.agentId), turnId: "limit-turn", outcome: { kind: "failed" }, timeline: [] } as never, { paseo: t.paseo } as never);
    expect(t.send).toHaveBeenCalledTimes(3);
    expect(["root", b.agentId]).not.toContain(t.sent.at(-1)!.id);
    expect((await t.store.read()).continuations.root!.pending).toBeUndefined();
  });

  it("prunes a finished task whose last hand-off never created its tab", async () => {
    const t = await setup();
    const service = t.service();
    t.create.mockRejectedValueOnce(new Error("creation failed"));
    await expect(t.switchTo("root", "b")).rejects.toThrow(/creation failed/);
    t.agents.get("root")!.archivedAt = "2026-10-02T00:00:00Z";
    await (service as unknown as { prune(paseo: PaseoApi): Promise<void> }).prune(t.paseo);
    expect((await t.store.read()).continuations.root).toBeUndefined();
  });

  it("records a limit even when looking up the task's other tabs fails", async () => {
    const t = await setup();
    const service = t.service();
    const b = (await service.setAgentAccount(t.paseo, "root", "b")).continuedIn!;
    const ref = t.paseo.agents.ref;
    t.paseo.agents.ref = ((id: string) => id === b.agentId ? { ...ref(id), refresh: async () => { throw new Error("daemon unreachable"); } } : ref(id)) as typeof ref;
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await service.onTurnEnded({ agent: t.agents.get("root"), turnId: "limit-turn", outcome: { kind: "failed" }, timeline: [] } as never, { paseo: t.paseo } as never);
      expect((await t.store.read()).accounts[0]!.limitedUntil).not.toBeNull();
      expect(error.mock.calls.some(([line]) => String(line).includes("could not find where root's task continues"))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  it("allows an explicit retry after an uncertain destination was deleted", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.send.mockRejectedValueOnce(new Error("disconnected"));
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/disconnected/);
    t.agents.delete("root");
    t.timelines.delete("root");
    expect((await t.switchTo(b.agentId, "a")).agentId).not.toBe("root");
    expect(t.sent.at(-1)!.text).toContain("Repair the build");
  });

  it("stops on a gap in the first timeline page even when older pages are available", async () => {
    const t = await setup();
    const read = t.refetch.getMockImplementation()!;
    t.refetch.mockImplementationOnce(async (...args) => ({ ...await read(...args), gap: true, hasOlder: true }));
    await expect(t.switchTo("root", "b")).rejects.toThrow(/history has a gap/);
    expect(t.send).not.toHaveBeenCalled();
  });

  it("rechecks the destination binding after collecting its update", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    const read = t.refetch.getMockImplementation()!;
    t.refetch.mockImplementationOnce(async (...args) => {
      await t.store.update((draft) => { draft.bindings.root!.accountId = "c"; });
      return read(...args);
    });
    await expect(t.switchTo(b.agentId, "a")).rejects.toThrow(/changed during the handoff/);
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it("stops if the account becomes unavailable while creating its tab, then reuses that unstarted tab", async () => {
    const t = await setup();
    const create = t.create.getMockImplementation()!;
    t.create.mockImplementationOnce(async (request) => {
      await create(request);
      await t.store.update((draft) => { draft.accounts[1]!.disabled = true; });
    });
    await expect(t.switchTo("root", "b")).rejects.toThrow(/changed while its tab was being created/);
    expect(t.send).not.toHaveBeenCalled();
    const reserved = t.created[0]!.agentId;
    await t.store.update((draft) => { draft.accounts[1]!.disabled = false; });
    expect((await t.switchTo("root", "b")).agentId).toBe(reserved);
    expect(t.created).toHaveLength(1);
  });

  it("waits for a new tab that is still initializing after creation", async () => {
    const t = await setup();
    const create = t.create.getMockImplementation()!;
    t.create.mockImplementationOnce(async (request) => {
      await create(request);
      const agent = t.agents.get(request.agentId!)!;
      agent.status = "initializing";
      setTimeout(() => { agent.status = "idle"; }, 400);
    });
    const b = await t.switchTo("root", "b");
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.id).toBe(b.agentId);
    expect((await t.store.read()).continuations.root!.pending).toBeUndefined();
  });

  it("doesn't send a handoff when creation opened the target on a different account", async () => {
    const t = await setup();
    const create = t.create.getMockImplementation()!;
    t.create.mockImplementationOnce(async (request) => {
      await create(request);
      await t.store.update((draft) => { draft.sessions[request.agentId!]!.accountId = "c"; });
    });
    await expect(t.switchTo("root", "b")).rejects.toThrow(/changed while its tab was being created/);
    expect(t.send).not.toHaveBeenCalled();
  });

  it.each(["message", "workspace"])("doesn't take over a reserved tab changed by a %s before retry", async (change) => {
    const t = await setup();
    const create = t.create.getMockImplementation()!;
    t.create.mockImplementationOnce(async (request) => { await create(request); throw new Error("lost create reply"); });
    await expect(t.switchTo("root", "b")).rejects.toThrow(/lost create reply/);
    const id = t.created[0]!.agentId!;
    if (change === "message") t.add(id, { type: "user_message", text: "A new task in this tab." });
    else t.agents.get(id)!.workspaceId = "another-workspace";
    await expect(t.switchTo("root", "b")).rejects.toThrow(/archive it before retrying/);
    expect(t.send).not.toHaveBeenCalled();
    expect(t.created).toHaveLength(1);
  });

  it("adopts an older destination when the first switch after upgrade starts in the original tab", async () => {
    const t = await setup();
    t.addAgent("legacy-b", { labels: { "zerosub.continued-from": "root" } });
    await t.store.update((draft) => { draft.bindings["legacy-b"] = { accountId: "b", source: "thread", at: "now" }; });
    expect((await t.switchTo("root", "b")).agentId).toBe("legacy-b");
    expect(t.created).toHaveLength(0);
  });

  it("paginates updates so early user corrections in a busy interval are not lost", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    t.add(b.agentId, { type: "user_message", text: "Do not publish anything." });
    for (let i = 0; i < 510; i++) t.add(b.agentId, { type: "assistant_message", text: `Progress ${i}` });
    await t.switchTo(b.agentId, "a");
    expect(t.sent.at(-1)!.text).toContain("Do not publish anything");
    expect(t.refetch.mock.calls.some(([, options]) => options.direction === "before")).toBe(true);
  });

  it("conservatively rereads a replaced timeline epoch", async () => {
    const t = await setup();
    const b = await t.switchTo("root", "b");
    await t.switchTo(b.agentId, "a");
    t.epochs.set("root", "epoch-2");
    t.timelines.set("root", []);
    t.add("root", { type: "user_message", text: "Replacement history with a newer instruction." });
    await t.switchTo("root", "b");
    expect(t.sent.at(-1)!.text).toContain("Replacement history with a newer instruction");
  });

  it("adopts the existing continuation label on older state without merging unrelated tasks", async () => {
    const t = await setup();
    t.addAgent("legacy-b", { labels: { "zerosub.continued-from": "root" } });
    t.add("legacy-b", { type: "user_message", text: "This task is continuing from an earlier Codex session that stopped because a limit. OLD FULL COPY" });
    t.add("legacy-b", { type: "assistant_message", text: "Work since the legacy handoff." });
    await t.store.update((draft) => { draft.bindings["legacy-b"] = { accountId: "b", source: "user", at: "now" }; });
    expect((await t.switchTo("legacy-b", "a")).agentId).toBe("root");
    expect(t.created).toHaveLength(0);
    expect(t.sent.at(-1)!.text).toContain("Work since the legacy handoff");
    expect(t.sent.at(-1)!.text).not.toContain("OLD FULL COPY");
    expect(salvageState({ accounts: [], bindings: {}, sessions: {} }).state.continuations).toEqual({});
  });
});

describe("fitting pending instructions", () => {
  it("keeps them all when they fit", () => {
    expect(fitInstructions(["one", "two"])).toBe("one\n\ntwo");
  });

  it("keeps the start and end of one oversized message", () => {
    const text = fitInstructions([`START ${"x".repeat(100_000)} END`], 10_000);
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(text).toMatch(/^START/);
    expect(text).toMatch(/END$/);
    expect(text).toContain("omitted");
  });

  it("keeps the first and the latest instruction even when the latest alone is too long", () => {
    const text = fitInstructions(["ORIGINAL", "middle", `LATEST ${"y".repeat(50_000)} TAIL`], 10_000);
    expect(text.length).toBeLessThanOrEqual(10_000);
    expect(text).toMatch(/^ORIGINAL/);
    expect(text).toContain("[… 1 earlier instruction omitted to fit this update …]");
    expect(text).not.toContain("middle");
    expect(text).toMatch(/TAIL$/);
  });
});
