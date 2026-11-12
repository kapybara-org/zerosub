import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FamilyAdapter, UsageRead } from "./adapter";
import type { FamilyResolver } from "./families";
import { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

// Paseo leaves background agents (`background: true`, e.g. a helper another plugin starts) out of its
// agent lists unless asked. `paseo agent reload` resolves the id from such a list, so it can't find
// one: the switch failed with "Reload failed" while the agent's new binding was already saved.

const MAIN = MAIN_ACCOUNT_ID.claude;
const OTHER = "claude-other";
const HELPER = "helper-1";
const LONG_AGO = "2026-01-01T00:00:00.000Z";

let root: string;
const saved = { PASEO_HOME: process.env.PASEO_HOME, PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-background-"));
  process.env.PASEO_HOME = root;
  // No paseo CLI anywhere it's looked for: a CLI reload can't happen, and the real one never runs.
  process.env.PATH = "";
  process.env.HOME = root;
  process.env.USERPROFILE = root;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

function adapter(): FamilyAdapter {
  const reading = (): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null });
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined,
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async () => null,
    usage: async () => reading(),
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

/** A host like Paseo 0.16: background agents left out of its list, and a reload of its own. */
async function setUp() {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) =>
    Object.assign(draft, {
      accounts: [
        { id: MAIN, family: "claude", label: "main", kind: "main", home: null, createdAt: LONG_AGO },
        { id: OTHER, family: "claude", label: "other", kind: "managed", home: join(root, OTHER), createdAt: LONG_AGO },
      ],
      defaults: { claude: OTHER, codex: null },
      sessions: { [HELPER]: { accountId: OTHER, family: "claude", openedAt: LONG_AGO } },
    }),
  );
  const helper = { id: HELPER, provider: "claude", status: "idle", archivedAt: null, lastUserMessageAt: null, background: true };
  const reloads: string[] = [];
  let service: Service;
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () => ({ agent: id === HELPER ? helper : null }),
        timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
        reload: async () => {
          reloads.push(id);
          await service.onSessionOpen(
            { agentId: id, provider: "claude", reason: "refresh", purpose: "interactive", env: {} } as never,
            { paseo } as never,
          );
        },
      }),
    },
  };
  service = new Service(
    { claude: adapter(), codex: { ...adapter(), family: "codex", portable: false } as FamilyAdapter },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    new Reopener(),
  );
  return { service, store, paseo: paseo as never, reloads };
}

describe("a background agent", () => {
  it("moves to a chosen account right away, through the host's own reload", async () => {
    const { service, store, paseo, reloads } = await setUp();
    const summary = await service.setAgentAccount(paseo, HELPER, MAIN);
    expect(summary.failed).toEqual([]);
    expect(summary.reopened).toEqual([HELPER]);
    expect(reloads).toEqual([HELPER]);
    const state = await store.read();
    expect(state.bindings[HELPER]).toMatchObject({ accountId: MAIN, source: "user" });
    expect(state.sessions[HELPER]?.accountId).toBe(MAIN);
  });
});
