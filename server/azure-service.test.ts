import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { preferences } from "../shared/preferences";
import type { Usage } from "../shared/model";
import type { SwitchRow } from "../shared/timeline";
import type { AgentTimelineItem, FamilyAdapter } from "./adapter";
import { ApiUsageStore } from "./api-usage";
import { AZURE_KEY_ENV } from "./azure";
import { CodexAdapter } from "./codex";
import { absentPi } from "./fakes.test-support";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore, StoredAccountSchema, findAccount, type StoredAccount } from "./state";
import { AZURE_RATE_LIMIT_MS, detectCodexLimit, detectCodexSignOut } from "./limits";

const ENDPOINT = "https://example-resource.openai.azure.com/openai/v1";
const KEY = "azure-secret-key-0123456789abcdef";
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "CODEX_HOME", "PASEO_HOME"] as const;

let root: string;
const saved: Partial<Record<(typeof PROXY_KEYS)[number], string>> = {};
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-azure-service-"));
  for (const key of PROXY_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PASEO_HOME = join(root, "paseo");
  process.env.CODEX_HOME = join(root, "codex");
  await mkdir(process.env.CODEX_HOME, { recursive: true });
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of PROXY_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function claudeAdapter(): FamilyAdapter {
  return { ...absentPi(), family: "claude" } as FamilyAdapter;
}

function fakePaseo() {
  const agent = { id: "agent-1", provider: "codex", status: "idle", archivedAt: null, lastUserMessageAt: null, persistence: null, model: "gpt-5" };
  const notes: unknown[] = [];
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    providers: { listAvailable: async () => ({ providers: [] }) },
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({
        refresh: async () => ({ agent }),
        send: async () => undefined,
        timeline: { append: async (item: unknown) => void notes.push(item), refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  return { paseo, notes };
}

function setUp() {
  const store = new StateStore(join(root, "paseo", "zerosub", "state.json"));
  const families = { resolve: async () => ({ codex: "codex" }) } as unknown as FamilyResolver;
  const reopener = { locate: async () => null, reopen: async () => ({ ok: true as const }) } as unknown as Reopener;
  const apiUsage = new ApiUsageStore(join(root, "paseo", "zerosub", "api-usage.json"));
  const service = new Service({ claude: claudeAdapter(), codex: new CodexAdapter(), pi: absentPi() }, store, families, reopener, apiUsage);
  services.push(service);
  return { service, store };
}

describe("Azure OpenAI accounts in the service", () => {
  it("keeps the key out of the registry, the app's view and the log", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const logged: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
    const { service, store } = setUp();
    const { accountId, warning } = await service.addAzureAccount({ label: "Azure", endpoint: `${ENDPOINT}/`, key: KEY });
    expect(warning).toBeNull();
    expect(fetch).toHaveBeenCalledWith(`${ENDPOINT}/models`, expect.objectContaining({ headers: expect.objectContaining({ "api-key": KEY }) }));

    const account = findAccount(await store.read(), accountId)!;
    expect(account).toMatchObject({ family: "codex", auth: "api", provider: "azure", kind: "managed" });
    const registry = await readFile(join(root, "paseo", "zerosub", "state.json"), "utf8");
    expect(registry).not.toContain(KEY);
    expect(JSON.stringify(await store.read())).not.toContain(KEY);

    const { paseo } = fakePaseo();
    const view = await service.view(paseo as never);
    const card = view.accounts.find((entry) => entry.id === accountId)!;
    expect(card.azure).toMatchObject({ endpoint: ENDPOINT, host: "example-resource.openai.azure.com", keyHint: KEY.slice(-4) });
    expect(card.apiEditable).toBe(false);
    expect(JSON.stringify(view)).not.toContain(KEY);

    // A session on the account gets its home and the key, and a config.toml without it.
    await service.setAgentAccount(paseo as never, "agent-1", accountId).catch(() => undefined);
    const opened = await service.onSessionOpen(
      { agentId: "agent-1", provider: "codex", reason: "create", purpose: "interactive", env: {}, workspaceId: "w", cwd: root } as never,
      { paseo } as never,
    );
    expect(opened?.env.CODEX_HOME).toBe(account.home);
    expect(opened?.env[AZURE_KEY_ENV]).toBe(KEY);
    const config = await readFile(join(account.home!, "config.toml"), "utf8");
    expect(config).toContain(`base_url = "${ENDPOINT}"`);
    expect(config).not.toContain(KEY);

    // Editing prices or the endpoint never sends the key back either.
    const update = await service.updateAzureAccount(accountId, { prices: { "gpt-5": { input: 1.25, cachedInput: 0.125, cacheWrite: 0, output: 10 } } });
    expect(JSON.stringify(update)).not.toContain(KEY);
    expect(logged.join("\n")).not.toContain(KEY);
  });

  it("refuses a key Azure refuses, and saves one it couldn't check with a warning", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service, store } = setUp();
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    await expect(service.addAzureAccount({ label: "Bad", endpoint: ENDPOINT, key: KEY })).rejects.toThrow(/refused the key/);
    expect((await store.read()).accounts).toHaveLength(0);
    expect(Object.keys((await store.read()).cleanup)).toHaveLength(0);

    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const { warning } = await service.addAzureAccount({ label: "Offline", endpoint: ENDPOINT, key: KEY });
    expect(warning).toMatch(/couldn't be checked/);
    expect((await store.read()).accounts).toHaveLength(1);
    await expect(service.addAzureAccount({ label: "Twice", endpoint: ENDPOINT, key: KEY })).rejects.toThrow(/already added/);
  });

  /** An Azure account with agent-1's session open on it, and a way to end that agent's turn. */
  async function onAzure() {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service, store } = setUp();
    const { accountId } = await service.addAzureAccount({ label: "Azure", endpoint: ENDPOINT, key: KEY });
    const { paseo } = fakePaseo();
    await service.setAgentAccount(paseo as never, "agent-1", accountId).catch(() => undefined);
    await service.onSessionOpen(
      { agentId: "agent-1", provider: "codex", reason: "create", purpose: "interactive", env: {}, workspaceId: "w", cwd: root } as never,
      { paseo } as never,
    );
    const endTurn = (outcome: unknown, timeline: unknown[] = []) =>
      service.onTurnEnded({ agent: { id: "agent-1", provider: "codex" }, turnId: "turn-1", outcome, timeline } as never, { paseo } as never);
    const account = async () => findAccount(await store.read(), accountId)!;
    return { endTurn, account };
  }

  const MCP_WARNINGS = [
    { type: "user_message", text: "Fix the build." },
    { type: "notification", level: "warning", message: "MCP client for github failed to start: HTTP 401 Unauthorized" },
    { type: "notification", level: "warning", message: "MCP client for search failed to start: HTTP 429 Too Many Requests" },
    { type: "assistant_message", text: "The build is fixed." },
  ];

  it("leaves the account usable after a completed turn whose warnings carry another service's 401 or 429", async () => {
    const t = await onAzure();
    const fetch = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetch);
    await t.endTurn({ kind: "completed" }, MCP_WARNINGS);
    expect(await t.account()).toMatchObject({ signedIn: true, limitedUntil: null });
    // Nothing looked like Azure's own refusal, so the key wasn't even checked.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks the key with Azure before taking a failed turn's 401 for a refused key", async () => {
    const t = await onAzure();
    // Azure still takes the key: the 401 was the MCP server's, so the account stays usable.
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await t.endTurn({ kind: "failed", error: { message: "MCP client for github failed to start: HTTP 401 Unauthorized" } });
    expect(fetch).toHaveBeenCalledWith(`${ENDPOINT}/models`, expect.objectContaining({ headers: expect.objectContaining({ "api-key": KEY }) }));
    expect(await t.account()).toMatchObject({ signedIn: true });

    // Azure can't be reached to ask: nothing is decided on the turn's word alone.
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    await t.endTurn({ kind: "failed", error: { message: "unexpected status 401 Unauthorized" } });
    expect(await t.account()).toMatchObject({ signedIn: true });

    // Azure refuses it too: now it's signed out, for the user to enter the key again.
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 401 }));
    await t.endTurn({ kind: "failed", error: { message: "unexpected status 401 Unauthorized: Access denied due to invalid subscription key." } });
    expect(await t.account()).toMatchObject({ signedIn: false });
  });

  it("sets an Azure account aside for a minute after a 429, rather than taking it for signed out", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service, store } = setUp();
    const { accountId } = await service.addAzureAccount({ label: "Azure", endpoint: ENDPOINT, key: KEY });
    const { paseo } = fakePaseo();
    await service.setAgentAccount(paseo as never, "agent-1", accountId).catch(() => undefined);
    await service.onSessionOpen(
      { agentId: "agent-1", provider: "codex", reason: "create", purpose: "interactive", env: {}, workspaceId: "w", cwd: root } as never,
      { paseo } as never,
    );
    const before = Date.now();
    await service.onTurnEnded(
      {
        agent: { id: "agent-1", provider: "codex" },
        turnId: null,
        outcome: { kind: "failed", error: { message: "exceeded retry limit, last status: 429 Too Many Requests" } },
        timeline: [],
      } as never,
      { paseo } as never,
    );
    const account = findAccount(await store.read(), accountId)!;
    expect(account.signedIn).toBe(true);
    const until = Date.parse(account.limitedUntil ?? "");
    expect(until - before).toBeGreaterThanOrEqual(AZURE_RATE_LIMIT_MS - 1_000);
    expect(until - before).toBeLessThanOrEqual(AZURE_RATE_LIMIT_MS + 5_000);
  });
});

describe("accounts without the Azure marker", () => {
  it("are never taken for Azure, whatever their auth: API-key accounts keep their own form", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service, store } = setUp();
    const home = join(root, "paseo", "zerosub", "homes", "codex-keyed");
    await mkdir(home, { recursive: true });
    const keyed = StoredAccountSchema.parse({ id: "codex-keyed", family: "codex", label: "Keyed", kind: "managed", auth: "api", home, createdAt: "2026-10-01T00:00:00.000Z" });
    const claudeKey = StoredAccountSchema.parse({
      id: "claude-key",
      family: "claude",
      label: "Claude key",
      kind: "managed",
      auth: "api",
      home: join(root, "claude-key"),
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    await store.update((draft) => void draft.accounts.push(keyed, claudeKey));
    await expect(service.updateAzureAccount(keyed.id, { prices: {} })).rejects.toThrow(/isn't an Azure OpenAI account/);
    await expect(service.updateAzureAccount(claudeKey.id, { prices: {} })).rejects.toThrow(/isn't an Azure OpenAI account/);

    const { paseo } = fakePaseo();
    const view = await service.view(paseo as never);
    expect(view.accounts.find((entry) => entry.id === keyed.id)).toMatchObject({ azure: null, apiEditable: true });
    expect(view.accounts.find((entry) => entry.id === claudeKey.id)).toMatchObject({ azure: null, apiEditable: true });
  });

  it("keeps an Azure account out of the API-key form", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service } = setUp();
    const { accountId } = await service.addAzureAccount({ label: "Azure", endpoint: ENDPOINT, key: KEY });
    await expect(service.updateApiAccount(accountId, { key: "other-key" })).rejects.toThrow(/Azure OpenAI account/);
  });
});

type PaseoApi = PluginHookContext["paseo"];
type Create = Parameters<ReturnType<PaseoApi["workspaces"]["ref"]>["agents"]["create"]>[0];
type Snapshot = NonNullable<Awaited<ReturnType<ReturnType<PaseoApi["agents"]["ref"]>["refresh"]>>>["agent"];
type Entry = { item: AgentTimelineItem; timestamp: string; seqStart: number; seqEnd: number; turnId?: string };

const LIMIT = "You've hit your usage limit. Try again at 3:45 PM.";

function codexAccount(fields: Partial<StoredAccount> & Pick<StoredAccount, "id" | "kind" | "home">): StoredAccount {
  return StoredAccountSchema.parse({ family: "codex", label: fields.id.toUpperCase(), createdAt: "2026-10-01T00:00:00.000Z", ...fields });
}

/**
 * A ChatGPT agent ("root") on the CLI login, the only subscription account, with an Azure account
 * added: a limit on the turn is what decides whether the work moves onto Azure.
 */
async function failoverSetUp(paidApiFallback: boolean, autoRedeem = false, redeem: "reset" | "none" = "none") {
  const main = join(root, "codex");
  const azureHome = join(root, "azure");
  await mkdir(join(main, "sessions"), { recursive: true });
  await mkdir(azureHome, { recursive: true });
  await symlink(join(main, "sessions"), join(azureHome, "sessions"));
  const sub = codexAccount({ id: "a", kind: "main", home: null, identity: "chatgpt|ws|a@example.com", email: "a@example.com" });
  const azure = codexAccount({ id: "azure", kind: "managed", home: azureHome, auth: "api", provider: "azure", identity: "azure|x|y", label: "Azure" });
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => {
    draft.accounts = [sub, azure];
    draft.defaults.codex = "a";
    draft.bindings.root = { accountId: "a", source: "thread", at: "2026-10-01T00:00:00.000Z" };
    draft.sessions.root = { accountId: "a", family: "codex", openedAt: "2026-10-01T00:00:00.000Z" };
    draft.continuations.root = { activeAgentId: "root", members: { root: { accountId: "a", identity: sub.identity, email: sub.email, seen: {} } } };
  });

  const agents = new Map<string, Snapshot>();
  const timelines = new Map<string, Entry[]>();
  let clock = 0;
  const addAgent = (id: string, values: Partial<Snapshot> = {}) => {
    agents.set(id, {
      id, provider: "codex", model: "synthetic-model", title: "Fix the build", cwd: root, workspaceId: "workspace-1",
      status: "idle", currentModeId: "full-access", thinkingOptionId: "high", labels: {}, features: [],
      archivedAt: null, lastUserMessageAt: "2026-10-01T00:00:00.000Z", pendingPermissions: [], ...values,
    } as Snapshot);
    timelines.set(id, []);
  };
  const add = (id: string, item: AgentTimelineItem) => {
    const entries = timelines.get(id)!;
    const seq = entries.length + 1;
    entries.push({ item, timestamp: new Date(1_700_000_000_000 + clock++ * 1000).toISOString(), seqStart: seq, seqEnd: seq, turnId: "accepted-turn" });
  };
  addAgent("root");
  add("root", { type: "user_message", text: "Repair the build." });
  add("root", { type: "assistant_message", text: "The parser has been repaired." });

  const created: Create[] = [];
  const notes: SwitchRow[] = [];
  const create = vi.fn(async (request: Create) => {
    created.push(request);
    addAgent(request.agentId!, { labels: request.labels, title: request.title, currentModeId: request.config.modeId ?? null, lastUserMessageAt: null });
    const binding = (await store.read()).bindings[request.agentId!];
    await store.update((draft) => {
      draft.sessions[request.agentId!] = { accountId: binding?.accountId ?? "azure", family: "codex", openedAt: "now" };
    });
  });
  const refetch = async (id: string, options: { direction?: string; cursor?: { epoch: string; seq: number }; limit?: number }) => {
    const all = timelines.get(id) ?? [];
    const eligible = all.filter((entry) => options.direction !== "before" || entry.seqEnd < options.cursor!.seq);
    const entries = eligible.slice(-(options.limit ?? 500));
    return {
      epoch: "epoch-1", window: { minSeq: 1, maxSeq: all.length, nextSeq: all.length + 1 }, entries,
      startCursor: entries.length ? { epoch: "epoch-1", seq: entries[0]!.seqStart } : null,
      endCursor: entries.length ? { epoch: "epoch-1", seq: entries.at(-1)!.seqEnd } : null,
      hasOlder: eligible.length > entries.length, gap: false, staleCursor: false,
    };
  };
  const paseo = {
    providers: { listModels: async () => ({ models: [{ id: "synthetic-model", isDefault: true }] }) },
    workspaces: { ref: () => ({ agents: { create } }) },
    agents: {
      create,
      list: async () => ({ entries: [...agents.values()].map((agent) => ({ agent })), pageInfo: { hasMore: false } }),
      ref: (id: string) => ({
        refresh: async () => (agents.has(id) ? { agent: structuredClone(agents.get(id)) } : null),
        send: async () => undefined,
        timeline: {
          refetch: (options: Parameters<typeof refetch>[1]) => refetch(id, options),
          append: async (item: { data: SwitchRow }) => void notes.push(item.data),
        },
      }),
    },
  } as unknown as PaseoApi;
  const adapter = {
    family: "codex",
    portable: false,
    usageSpacingMs: 0,
    detectLimit: detectCodexLimit,
    detectSignOut: detectCodexSignOut,
    env: async (home: string | null) => (home ? { CODEX_HOME: home } : {}),
    prepareHome: async () => undefined,
    identity: async () => null,
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    redeemReset: vi.fn(async () => (redeem === "reset" ? { outcome: "reset", message: "Spent a banked reset.", left: 1 } : { outcome: "none", message: "none", left: 0 })),
  } as unknown as FamilyAdapter;
  const service = new Service(
    { codex: adapter, claude: claudeAdapter(), pi: absentPi() },
    store,
    { resolve: async () => ({ codex: "codex" as const }) } as unknown as FamilyResolver,
    { locate: async () => null, reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    new ApiUsageStore(join(root, "api-usage.json")),
  );
  services.push(service);
  service.setPreferences(preferences.schema.parse({ paidApiFallback, autoRedeem }));
  const endTurn = (message: string) =>
    service.onTurnEnded(
      { agent: { id: "root", provider: "codex" }, turnId: `turn-${clock++}`, outcome: { kind: "failed", error: { message } }, timeline: [] } as never,
      { paseo } as never,
    );
  return { service, store, paseo, created, create, notes, endTurn, redeemReset: adapter.redeemReset as ReturnType<typeof vi.fn> };
}

describe("moving work onto Azure by itself", () => {
  it("never happens with paid API fallback off: the agent stops at its limit, as with any API account", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = await failoverSetUp(false);
    await t.endTurn(LIMIT);
    expect(t.created).toEqual([]);
    expect(t.notes.at(-1)).toMatchObject({ reason: "exhausted", outcome: "stayed" });
    expect((await t.store.read()).bindings.root?.accountId).toBe("a");
  });

  it("happens with it on once every ChatGPT subscription account is out, and the timeline says it's billed per token", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = await failoverSetUp(true);
    await t.endTurn(LIMIT);
    expect(t.created).toHaveLength(1);
    const state = await t.store.read();
    expect(state.bindings[t.created[0]!.agentId!]?.accountId).toBe("azure");
    expect(t.notes.at(-1)).toMatchObject({ outcome: "continued", to: "Azure" });
    expect(t.notes.at(-1)?.detail).toMatch(/Azure OpenAI, a paid API billed per token/);
  });

  it("isn't needed with it on while a subscription account has room", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = await failoverSetUp(true);
    await t.store.update((draft) => void draft.accounts.push(codexAccount({ id: "b", kind: "managed", home: join(root, "b"), identity: "chatgpt|ws|b@example.com" })));
    await t.endTurn(LIMIT);
    expect(t.created).toHaveLength(1);
    expect((await t.store.read()).bindings[t.created[0]!.agentId!]?.accountId).toBe("b");
    expect(t.notes.at(-1)?.detail ?? null).toBeNull();
  });
});

describe("a banked reset and Azure, both on", () => {
  it("spends the free reset first, and doesn't bill Azure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = await failoverSetUp(true, true, "reset");
    await t.endTurn(LIMIT);
    expect(t.redeemReset).toHaveBeenCalledTimes(1);
    expect(t.created).toEqual([]);
    expect(t.notes.at(-1)).toMatchObject({ outcome: "reset", to: "A" });
    expect((await t.store.read()).bindings.root?.accountId).toBe("a");
  });

  it("opens a new agent on a limited subscription with a usable banked reset, not on Azure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = await failoverSetUp(true, true, "reset");
    await t.store.update((draft) => {
      Object.assign(draft.accounts.find((account) => account.id === "a")!, {
        limitedUntil: new Date(Date.now() + 3 * 60 * 60_000).toISOString(), limitKind: "window", limitedAt: new Date().toISOString(),
      });
    });
    const reading = (usableNow: boolean): Usage => ({
      fetchedAt: new Date().toISOString(), windows: [{ id: "primary", label: "5-hour", usedPercent: 100, resetsAt: null, minutes: 300 }],
      error: null, cached: false, credits: null, resets: { available: 1, usableNow, blockedReason: null, expiresAt: null, refills: [], label: null },
    });
    const usage = (t.service as unknown as { usage: Map<string, Usage> }).usage;
    const open = (agentId: string) => t.service.onSessionOpen(
      { agentId, provider: "codex", reason: "create", purpose: "interactive", env: {}, workspaceId: "w", cwd: root } as never,
      { paseo: t.paseo } as never,
    );
    usage.set("a", reading(true));
    await open("fresh");
    expect((await t.store.read()).bindings.fresh?.accountId).toBe("a");
    expect((await t.store.read()).sessions.fresh?.accountId).toBe("a");
    // A reset that can't be used right now doesn't hold a new agent back from Azure.
    usage.set("a", reading(false));
    await open("later");
    expect((await t.store.read()).bindings.later?.accountId).toBe("azure");
  });

  it("moves onto Azure only once no reset could be spent", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const t = await failoverSetUp(true, true, "none");
    await t.endTurn(LIMIT);
    expect(t.redeemReset).toHaveBeenCalledTimes(1);
    expect(t.created).toHaveLength(1);
    expect(t.redeemReset.mock.invocationCallOrder[0]!).toBeLessThan(t.create.mock.invocationCallOrder[0]!);
    expect((await t.store.read()).bindings[t.created[0]!.agentId!]?.accountId).toBe("azure");
    expect(t.notes.at(-1)).toMatchObject({ outcome: "continued", to: "Azure" });
  });
});
