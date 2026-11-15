import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { estimateApiCost, totalTokens, type ApiMonth } from "../shared/model";
import type { TurnEvent } from "./adapter";
import {
  AZURE_KEY_ENV,
  azureConfigToml,
  checkAzureKey,
  findRollout,
  normalizeAzureEndpoint,
  parseRollout,
  syncAzureConfig,
  writeAzureAccount,
} from "./azure";
import { ApiUsageStore, addApiTokens, currentMonth, tokenDelta } from "./api-usage";
import { CodexAdapter } from "./codex";
import { AZURE_QUOTA_MS, AZURE_RATE_LIMIT_MS, detectAzureLimit, detectAzureSignOut } from "./limits";

const ENDPOINT = "https://example-resource.openai.azure.com/openai/v1";
const KEY = "azure-test-key-0123456789abcdef";

function failed(message: string): TurnEvent {
  return { outcome: { kind: "failed", error: { message } }, timeline: [], turnId: "turn-1" };
}

/** The top-level part of a TOML file: everything before its first table header. */
function topLevel(toml: string): string {
  const header = toml.search(/^\s*\[/m);
  return header < 0 ? toml : toml.slice(0, header);
}

describe("azureConfigToml", () => {
  it("sets the provider on an empty shared config", () => {
    const toml = azureConfigToml("", ENDPOINT);
    expect(topLevel(toml)).toMatch(/^model_provider = "zerosub_azure"$/m);
    expect(toml).toContain('[model_providers.zerosub_azure]\nname = "Azure OpenAI"\n');
    expect(toml).toContain(`base_url = "${ENDPOINT}"`);
    expect(toml).toContain(`env_key = "${AZURE_KEY_ENV}"`);
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).not.toContain(KEY);
  });

  it("keeps the shared settings and tables, with model_provider before the first table", () => {
    const shared = [
      'model = "gpt-5.1-codex"',
      'approval_policy = "on-request"',
      "",
      "[mcp_servers.docs]",
      'command = "docs-mcp"',
      "",
      '[projects."/home/me/app"]',
      'trust_level = "trusted"',
    ].join("\n");
    const toml = azureConfigToml(shared, ENDPOINT);
    const top = topLevel(toml);
    expect(top).toContain('model_provider = "zerosub_azure"');
    expect(top).toContain('model = "gpt-5.1-codex"');
    expect(toml).toContain('[mcp_servers.docs]\ncommand = "docs-mcp"');
    expect(toml).toContain('[projects."/home/me/app"]\ntrust_level = "trusted"');
    // The provider's table comes after every shared one, so no shared key ends up inside it.
    expect(toml.indexOf("[model_providers.zerosub_azure]")).toBeGreaterThan(toml.indexOf("trust_level"));
    expect(toml.trimEnd().endsWith('wire_api = "responses"')).toBe(true);
  });

  it("overrides a top-level model_provider but leaves a profile's", () => {
    const shared = ['model_provider = "openai"', "", "[profiles.fast]", 'model_provider = "ollama"'].join("\n");
    const toml = azureConfigToml(shared, ENDPOINT);
    expect(toml.match(/^model_provider = /gm)).toHaveLength(2);
    expect(topLevel(toml)).not.toContain('"openai"');
    expect(toml).toContain('[profiles.fast]\nmodel_provider = "ollama"');
  });

  it("replaces an earlier zerosub_azure table and dotted keys, not other providers", () => {
    const shared = [
      'model_providers.zerosub_azure.base_url = "https://old.example.com"',
      "",
      "[model_providers.zerosub_azure]",
      'base_url = "https://stale.example.com"',
      "",
      '[model_providers."zerosub_azure".http_headers]',
      'x = "y"',
      "",
      "[model_providers.other]",
      'base_url = "https://other.example.com"',
    ].join("\n");
    const toml = azureConfigToml(shared, ENDPOINT);
    expect(toml).not.toContain("old.example.com");
    expect(toml).not.toContain("stale.example.com");
    expect(toml).not.toContain("http_headers");
    expect(toml).toContain('[model_providers.other]\nbase_url = "https://other.example.com"');
    expect(toml.match(/\[model_providers\.zerosub_azure\]/g)).toHaveLength(1);
  });

  it("isn't fooled by multi-line strings and arrays that look like headers or keys", () => {
    const shared = [
      'instructions = """',
      "[not.a.table]",
      'model_provider = "inside a string"',
      '"""',
      "notify = [",
      '  "a",',
      '  ["b"]',
      "]",
      'model_provider = "openai" # trailing comment',
      "[tools]",
      "web_search = true",
    ].join("\n");
    const toml = azureConfigToml(shared, ENDPOINT);
    expect(toml).toContain('[not.a.table]\nmodel_provider = "inside a string"\n"""');
    expect(toml).toContain('notify = [\n  "a",\n  ["b"]\n]');
    expect(toml).not.toContain('"openai"');
    expect(toml).toContain("[tools]\nweb_search = true");
  });
});

describe("syncAzureConfig", () => {
  let root: string;
  const saved = process.env.CODEX_HOME;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zerosub-azure-"));
    process.env.CODEX_HOME = join(root, "codex");
    await mkdir(process.env.CODEX_HOME, { recursive: true });
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = saved;
    await rm(root, { recursive: true, force: true });
  });

  it("replaces a link to the shared config with a file of its own, and follows the shared one", async () => {
    const shared = join(root, "codex", "config.toml");
    await writeFile(shared, 'model = "gpt-5"\n');
    const home = join(root, "home");
    await writeAzureAccount(home, { endpoint: ENDPOINT, key: KEY, prices: {} });
    await symlink(shared, join(home, "config.toml"));
    await syncAzureConfig(home);
    expect(await readFile(shared, "utf8")).toBe('model = "gpt-5"\n');
    const own = await readFile(join(home, "config.toml"), "utf8");
    expect(own).toContain('model = "gpt-5"');
    expect(own).toContain('model_provider = "zerosub_azure"');
    await writeFile(shared, 'model = "gpt-5.1"\n');
    await syncAzureConfig(home);
    expect(await readFile(join(home, "config.toml"), "utf8")).toContain('model = "gpt-5.1"');
  });

  it("keeps the key in azure.json only, readable only by the user, and hands it to sessions by variable", async () => {
    const home = join(root, "home");
    await writeAzureAccount(home, { endpoint: ENDPOINT, key: KEY, prices: {} });
    expect((await stat(join(home, "azure.json"))).mode & 0o777).toBe(0o600);
    const env = await new CodexAdapter().env(home);
    expect(env.CODEX_HOME).toBe(home);
    expect(env[AZURE_KEY_ENV]).toBe(KEY);
    expect(await readFile(join(home, "config.toml"), "utf8")).not.toContain(KEY);
  });
});

describe("normalizeAzureEndpoint", () => {
  it("accepts the v1 URL and fills in the path for a bare resource", () => {
    expect(normalizeAzureEndpoint(`${ENDPOINT}/`)).toBe(ENDPOINT);
    expect(normalizeAzureEndpoint("https://example-resource.openai.azure.com")).toBe(ENDPOINT);
    expect(normalizeAzureEndpoint("https://example-resource.openai.azure.com/openai")).toBe(ENDPOINT);
    expect(normalizeAzureEndpoint("https://gateway.example.com/azure/v1")).toBe("https://gateway.example.com/azure/v1");
  });
  it("refuses http, credentials and queries", () => {
    expect(() => normalizeAzureEndpoint("http://example-resource.openai.azure.com/openai/v1")).toThrow(/https/);
    expect(() => normalizeAzureEndpoint("https://user:pw@example.com/openai/v1")).toThrow(/key field/);
    expect(() => normalizeAzureEndpoint(`${ENDPOINT}?api-version=1`)).toThrow(/query/);
    expect(() => normalizeAzureEndpoint("not a url")).toThrow(/URL/);
  });
});

describe("checkAzureKey", () => {
  it("lists the models with the key in the api-key header", async () => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    const result = await checkAzureKey(ENDPOINT, KEY, async (url, init) => {
      seen.push({ url, headers: init.headers });
      return { status: 200 };
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual([{ url: `${ENDPOINT}/models`, headers: expect.objectContaining({ "api-key": KEY }) }]);
  });
  it("fails on a refused key and only warns when the endpoint can't be reached", async () => {
    for (const status of [401, 403]) {
      expect(await checkAzureKey(ENDPOINT, KEY, async () => ({ status }))).toMatchObject({ ok: false, fatal: true });
    }
    const unreachable = await checkAzureKey(ENDPOINT, KEY, async () => {
      throw new Error(`getaddrinfo ENOTFOUND (sent ${KEY})`);
    });
    expect(unreachable).toMatchObject({ ok: false, fatal: false });
    expect(JSON.stringify(unreachable)).not.toContain(KEY);
    expect(await checkAzureKey(ENDPOINT, KEY, async () => ({ status: 503 }))).toMatchObject({ ok: false, fatal: false });
  });
});

describe("Azure errors", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  it("reads a rate limit as a short cooldown", () => {
    const hit = detectAzureLimit(failed("exceeded retry limit, last status: 429 Too Many Requests, request id: abc"), now);
    expect(hit).toMatchObject({ kind: "window", resetsAt: new Date(now.getTime() + AZURE_RATE_LIMIT_MS).toISOString() });
  });
  it("uses Azure's own retry-after when it gives one", () => {
    const hit = detectAzureLimit(failed("Requests have exceeded token rate limit of your current pricing tier. Please retry after 20 seconds."), now);
    expect(hit?.resetsAt).toBe(new Date(now.getTime() + 20_000).toISOString());
  });
  it("reads an exhausted quota as a longer one", () => {
    for (const message of ["Quota exceeded. Check your plan and billing details.", '{"error":{"code":"insufficient_quota"}}']) {
      expect(detectAzureLimit(failed(message), now)).toMatchObject({ kind: "budget", resetsAt: new Date(now.getTime() + AZURE_QUOTA_MS).toISOString() });
    }
  });
  it("tells a refused key from a limit, and ignores ordinary failures", () => {
    const refused = failed("unexpected status 401 Unauthorized: Access denied due to invalid subscription key or wrong API endpoint.");
    expect(detectAzureLimit(refused, now)).toBeNull();
    expect(detectAzureSignOut(refused)).toMatch(/401/);
    expect(detectAzureSignOut(failed("429 Too Many Requests"))).toBeNull();
    expect(detectAzureLimit(failed("stream disconnected before completion"), now)).toBeNull();
  });
});

describe("Azure token counts", () => {
  const month = (models: ApiMonth["models"]): ApiMonth => ({ month: "2026-11", models, uncounted: 0, updatedAt: null });

  it("adds a thread's growth, and starts over when the month turns (UTC)", () => {
    const november = Date.parse("2026-11-30T23:59:00Z");
    const december = Date.parse("2026-12-01T00:00:30Z");
    let totals = addApiTokens(undefined, "gpt-5", { input: 100, cachedInput: 40, cacheWrite: 0, output: 10 }, november);
    totals = addApiTokens(totals, "gpt-5", { input: 50, cachedInput: 0, cacheWrite: 0, output: 5 }, november);
    expect(totals).toMatchObject({ month: "2026-11", models: { "gpt-5": { input: 150, cachedInput: 40, cacheWrite: 0, output: 15 } } });
    expect(currentMonth(totals, december)).toBeNull();
    const next = addApiTokens(totals, "gpt-5", { input: 7, cachedInput: 0, cacheWrite: 0, output: 1 }, december);
    expect(next).toMatchObject({ month: "2026-12", models: { "gpt-5": { input: 7, cachedInput: 0, cacheWrite: 0, output: 1 } } });
  });

  it("counts only what a thread used since it was last counted", () => {
    expect(tokenDelta(undefined, { input: 10, cachedInput: 2, cacheWrite: 0, output: 3 })).toEqual({ input: 10, cachedInput: 2, cacheWrite: 0, output: 3 });
    expect(tokenDelta({ input: 10, cachedInput: 2, cacheWrite: 0, output: 3 }, { input: 25, cachedInput: 6, cacheWrite: 0, output: 4 })).toEqual({ input: 15, cachedInput: 4, cacheWrite: 0, output: 1 });
    // A count that went back (a new thread under the same id, say) counts whole.
    expect(tokenDelta({ input: 100, cachedInput: 0, cacheWrite: 0, output: 9 }, { input: 5, cachedInput: 0, cacheWrite: 0, output: 1 })).toEqual({ input: 5, cachedInput: 0, cacheWrite: 0, output: 1 });
  });

  it("keeps per-thread marks and monthly totals in its own file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zerosub-azure-usage-"));
    try {
      const store = new ApiUsageStore(join(root, "api-usage.json"));
      const now = Date.parse("2026-11-15T12:00:00Z");
      await store.countThread("codex-a", "thread-1", { model: "gpt-5", total: { input: 1000, cachedInput: 200, cacheWrite: 0, output: 50 } }, "x", now);
      await store.countThread("codex-a", "thread-1", { model: "gpt-5", total: { input: 1500, cachedInput: 300, cacheWrite: 0, output: 80 } }, "x", now);
      await store.noteUncounted("codex-a", now);
      const reread = await new ApiUsageStore(join(root, "api-usage.json")).read();
      expect(reread.accounts["codex-a"]).toMatchObject({ month: "2026-11", uncounted: 1, models: { "gpt-5": { input: 1500, cachedInput: 300, cacheWrite: 0, output: 80 } } });
      expect(totalTokens(reread.accounts["codex-a"] ?? null)).toEqual({ input: 1500, cachedInput: 300, cacheWrite: 0, output: 80 });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("estimates the cost from the price table, and says when a price is missing", () => {
    const used = month({ "gpt-5": { input: 2_000_000, cachedInput: 1_000_000, cacheWrite: 0, output: 100_000 }, "o4-mini": { input: 10, cachedInput: 0, cacheWrite: 0, output: 0 } });
    const prices = { "gpt-5": { input: 1.25, cachedInput: 0.125, cacheWrite: 0, output: 10 } };
    const cost = estimateApiCost(used, prices);
    expect(cost.complete).toBe(false);
    expect(cost.usd).toBeCloseTo(1.25 + 0.125 + 1, 6);
    expect(estimateApiCost(month({ "gpt-5": { input: 1_000_000, cachedInput: 0, cacheWrite: 0, output: 0 } }), prices)).toEqual({ usd: 1.25, complete: true });
    expect(estimateApiCost(used, {})).toEqual({ usd: null, complete: false });
  });

  it("reads a thread's running total and model from its Codex rollout", async () => {
    const root = await mkdtemp(join(tmpdir(), "zerosub-rollout-"));
    try {
      const thread = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
      const day = join(root, "2026", "11", "15");
      await mkdir(day, { recursive: true });
      const lines = [
        { type: "session_meta", payload: { id: thread } },
        { type: "turn_context", payload: { model: "gpt-5.1-codex" } },
        { type: "event_msg", payload: { type: "token_count", info: null } },
        { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 900, cached_input_tokens: 300, output_tokens: 40 } } } },
        { type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1200, cached_input_tokens: 500, output_tokens: 70 } } } },
      ];
      await writeFile(join(day, `rollout-2026-11-15T10-00-00-${thread}.jsonl`), `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
      const path = await findRollout(thread, root);
      expect(path).toContain(thread);
      expect(parseRollout(await readFile(path!, "utf8"))).toEqual({ model: "gpt-5.1-codex", total: { input: 1200, cachedInput: 500, cacheWrite: 0, output: 70 } });
      expect(await findRollout("0199ffff-0000-0000-0000-000000000000", root)).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
