import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";
import { AGENT_METADATA_KEY } from "../shared/model";
import { preferences } from "../shared/preferences";

// Paseo tells a composer item its agent's metadata and nothing else of the agent, so the daemon
// keeps each agent's ID in the agent's own metadata for the Account control to read.

const MAIN = MAIN_ACCOUNT_ID.claude;
const HELLO = "claude-hello";

let root: string;
let previousHome: string | undefined;
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-agent-metadata-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

interface Listed {
  id: string;
  /** Left out: a Paseo before 0.16, which keeps no agent metadata. */
  metadata?: Record<string, unknown>;
}

async function setUp(listed: Listed[] = [], setMetadata: ((agentId: string, patch: Record<string, string>) => Promise<undefined>) | null = vi.fn(async (_agentId: string, _patch: Record<string, string>) => undefined)) {
  const store = new StateStore(join(await mkdtemp(join(root, "state-")), "state.json"));
  const stored = (id: string, label: string, kind: "main" | "managed") =>
    ({ id, family: "claude", label, kind, home: kind === "main" ? null : join(tmpdir(), id), createdAt: "2026-09-23T00:00:00.000Z" });
  await store.update((draft) => Object.assign(draft, { accounts: [stored(MAIN, "marketing", "main"), stored(HELLO, "hello", "managed")], defaults: { claude: MAIN, codex: null, pi: null } }));
  const snapshot = (agent: Listed) => ({ provider: "claude", status: "idle", archivedAt: null, lastUserMessageAt: null, title: null, labels: {}, ...agent });
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: listed.map((agent) => ({ agent: snapshot(agent) })), pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (agentId: string) => ({
        refresh: async () => ({ agent: null }),
        timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
        // A Paseo before 0.16 has no agent metadata, and its SDK no way to write it.
        ...(setMetadata ? { setMetadata: (patch: Record<string, string>) => setMetadata(agentId, patch) } : {}),
      }),
    },
  };
  const claude = {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async () => null,
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
  const service = new Service(
    { claude, codex: claude, pi: claude },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  services.push(service);
  service.setPreferences(preferences.schema.parse({}));
  service.attach(paseo as never);
  const context = { paseo } as never;
  const open = (agentId: string, request: { metadata?: Record<string, unknown>; purpose?: string; reason?: string } = {}) =>
    service.onSessionOpen(
      { agentId, provider: "claude", cwd: "/repo", workspaceId: "workspace-1", reason: "create", purpose: "interactive", env: {}, ...request } as never,
      context,
    );
  return { service, paseo: paseo as never, setMetadata, open };
}

describe("an agent's ID in its own metadata", () => {
  it("is written as the agent's session opens, once", async () => {
    const { setMetadata, open } = await setUp();
    await open("fresh", { metadata: {} });
    expect(setMetadata).toHaveBeenCalledExactlyOnceWith("fresh", { [AGENT_METADATA_KEY]: "fresh" });
    await open("fresh", { metadata: {}, reason: "resume" });
    expect(setMetadata).toHaveBeenCalledOnce();
  });

  it("is left alone where it's there already, for a session that only reads history, and on a Paseo without metadata", async () => {
    const { setMetadata, open } = await setUp();
    await open("named", { metadata: { [AGENT_METADATA_KEY]: "named" } });
    await open("read", { metadata: {}, purpose: "history" });
    await open("older");
    expect(setMetadata).not.toHaveBeenCalled();
  });

  it("isn't written for agents that are only listed, whose account button stays until their session opens", async () => {
    // Writing it counts as a change to the agent: all at once, every agent would look just used.
    const { service, paseo, setMetadata, open } = await setUp([{ id: "old", metadata: {} }, { id: "named", metadata: { [AGENT_METADATA_KEY]: "named" } }]);
    const state = await service.view(paseo);
    expect(setMetadata).not.toHaveBeenCalled();
    expect(state.agentMetadata).toBe(true);
    expect(state.agents.map((route) => [route.agentId, route.inComposer])).toEqual([["old", false], ["named", true]]);

    // Once its session opens it's being named, though the daemon's list may still be from before.
    await open("old", { metadata: {}, reason: "resume" });
    expect(setMetadata).toHaveBeenCalledExactlyOnceWith("old", { [AGENT_METADATA_KEY]: "old" });
    expect((await service.view(paseo)).agents.find((route) => route.agentId === "old")?.inComposer).toBe(true);
  });

  it("leaves the account button to an agent whose metadata couldn't be written", async () => {
    const refuse = vi.fn(async () => {
      throw new Error("Agent is archived");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { service, paseo, open } = await setUp([{ id: "stuck", metadata: {} }], refuse);
    await open("stuck", { metadata: {}, reason: "resume" });
    await vi.waitFor(async () => expect((await service.view(paseo)).agents[0]?.inComposer).toBe(false));
    expect(refuse).toHaveBeenCalledOnce();
    error.mockRestore();
  });

  it("puts a new agent in the next state the app reads, not one from before it existed", async () => {
    const listed: Listed[] = [];
    const { service, paseo, open } = await setUp(listed);
    expect((await service.view(paseo)).agents).toEqual([]);
    listed.push({ id: "fresh", metadata: {} });
    await open("fresh", { metadata: {} });
    expect((await service.view(paseo)).agents.map((route) => [route.agentId, route.inComposer])).toEqual([["fresh", true]]);
  });

  it("isn't tried on a Paseo that keeps no agent metadata, where the account button stays", async () => {
    const { service, paseo, open } = await setUp([{ id: "older" }], null);
    await open("older");
    const state = await service.view(paseo);
    expect(state.agentMetadata).toBe(false);
    expect(state.agents[0]?.inComposer).toBe(false);
  });

  it("drops the list it read before Paseo listed a new agent, once Paseo says it has", async () => {
    const listed: Listed[] = [];
    const { service, paseo, open } = await setUp(listed);
    await open("fresh", { metadata: {} });
    // The app asks between the session opening and Paseo listing the agent: that list lacks it.
    expect((await service.view(paseo)).agents).toEqual([]);
    listed.push({ id: "fresh", metadata: {} });
    expect((await service.view(paseo)).agents).toEqual([]);
    service.onAgentCreated();
    expect((await service.view(paseo)).agents.map((route) => [route.agentId, route.inComposer])).toEqual([["fresh", true]]);
  });
});
