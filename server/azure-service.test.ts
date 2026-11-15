import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter } from "./adapter";
import { ApiUsageStore } from "./api-usage";
import { AZURE_KEY_ENV } from "./azure";
import { CodexAdapter } from "./codex";
import { absentPi } from "./fakes.test-support";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore, findAccount } from "./state";
import { AZURE_RATE_LIMIT_MS } from "./limits";

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
  const azureUsage = new ApiUsageStore(join(root, "paseo", "zerosub", "azure-usage.json"));
  const service = new Service({ claude: claudeAdapter(), codex: new CodexAdapter(), pi: absentPi() }, store, families, reopener, azureUsage);
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
    expect(account).toMatchObject({ family: "codex", auth: "api", kind: "managed" });
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
