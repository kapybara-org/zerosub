import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ClaudeAdapter } from "./claude";
import type { FamilyResolver } from "./families";
import { readAccountProxy } from "./homes";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";
import { absentPi } from "./fakes.test-support";

// An API account's key goes in a header Claude Code sends to its base URL. Over plain http:// any
// proxy on the way reads it, so ZeroSub never sends one through a proxy it wasn't typed in with.
// The real adapter writes the account's files here; nothing is started and nothing goes out.

const VARIABLES = ["PASEO_HOME", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"];
const saved: Record<string, string | undefined> = {};
let root: string;

class OfflineClaude extends ClaudeAdapter {
  override async available() {
    return { ok: true, detail: null };
  }
  override async identity() {
    return { signedIn: false, email: null, plan: null, organization: null, identity: null };
  }
  override async usage() {
    return { fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null };
  }
  override async egress() {
    return null;
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-clear-text-"));
  for (const key of VARIABLES) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PASEO_HOME = root;
  process.env.CLAUDE_CONFIG_DIR = join(root, "main");
  await mkdir(join(root, "main"), { recursive: true });
});

afterEach(async () => {
  for (const key of VARIABLES) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const mainSettings = (env: Record<string, string>) => writeFile(join(root, "main", "settings.json"), JSON.stringify({ env }));
const homes = () => readdir(join(root, "zerosub", "homes")).catch(() => [] as string[]);
const KEY = "sk-ant-api03-test-0123456789";
const GATEWAY = "http://gw.example.com:4000";

function setUp() {
  const store = new StateStore(join(root, "state.json"));
  const claude = new OfflineClaude();
  const service = new Service(
    { claude, codex: { ...claude, family: "codex" } as never, pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  return { service, store };
}

describe("an API account with a plain http:// base URL", () => {
  it("isn't added behind the proxy it would inherit, unless the no-proxy list keeps its gateway direct", async () => {
    const { service, store } = setUp();
    await mainSettings({ HTTPS_PROXY: "http://10.0.0.1:3128" });
    await expect(service.addApiAccount({ label: "Gateway", key: KEY, keyKind: "api_key", baseUrl: GATEWAY })).rejects.toThrow(/plain http:\/\/.*10\.0\.0\.1:3128/);
    expect((await store.read()).accounts).toEqual([]);
    expect(await homes()).toEqual([]);

    // https:// is read by nobody on the way.
    await service.addApiAccount({ label: "Secure", key: KEY, keyKind: "api_key", baseUrl: "https://gw.example.com:4443" });
    // Kept direct, it doesn't cross the proxy.
    await mainSettings({ HTTPS_PROXY: "http://10.0.0.1:3128", NO_PROXY: "gw.example.com" });
    await service.addApiAccount({ label: "Direct", key: `${KEY}-2`, keyKind: "api_key", baseUrl: GATEWAY });
    expect((await store.read()).accounts.map((account) => account.label)).toEqual(["Secure", "Direct"]);
  });

  it("is added with a proxy typed in along with its key, and then keeps that one", async () => {
    const { service, store } = setUp();
    const id = await service.addApiAccount({ label: "Gateway", key: KEY, keyKind: "api_key", baseUrl: GATEWAY, proxy: "http://127.0.0.1:7890" });
    const home = (await store.read()).accounts.find((account) => account.id === id)!.home!;

    // A new proxy would read a key it was never typed in for; with none, the main one would.
    await expect(service.setProxy(id, "http://10.0.0.2:8080")).rejects.toThrow(/plain http:\/\//);
    await mainSettings({ HTTPS_PROXY: "http://10.0.0.1:3128" });
    await expect(service.setProxy(id, "")).rejects.toThrow(/plain http:\/\/.*10\.0\.0\.1:3128/);
    expect(await readAccountProxy(home)).toBe("http://127.0.0.1:7890");
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");

    // With nothing to inherit, it can go direct.
    await mainSettings({});
    await service.setProxy(id, "");
    expect(await readAccountProxy(home)).toBeNull();
  });

  it("isn't moved to plain http:// behind the proxy it inherits", async () => {
    const { service, store } = setUp();
    await mainSettings({ HTTPS_PROXY: "http://10.0.0.1:3128" });
    const id = await service.addApiAccount({ label: "Gateway", key: KEY, keyKind: "api_key", baseUrl: "https://gw.example.com:4443" });
    await expect(service.updateApiAccount(id, { key: KEY, keyKind: "api_key", baseUrl: GATEWAY })).rejects.toThrow(/plain http:\/\//);
    const home = (await store.read()).accounts.find((account) => account.id === id)!.home!;
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).env.ANTHROPIC_BASE_URL).toBe("https://gw.example.com:4443");
  });

  it("keeps the CLI login from getting a proxy it would follow it through", async () => {
    const { service, store } = setUp();
    await store.update((draft) => void draft.accounts.push({ id: MAIN_ACCOUNT_ID.claude, family: "claude", label: "CLI", kind: "main", home: null, createdAt: "2026-11-15T00:00:00.000Z" } as never));
    await mainSettings({});
    await service.addApiAccount({ label: "Gateway", key: KEY, keyKind: "api_key", baseUrl: GATEWAY });
    await expect(service.setProxy(MAIN_ACCOUNT_ID.claude, "http://10.0.0.1:3128")).rejects.toThrow(/Gateway .*plain http:\/\//);
    expect(JSON.parse(await readFile(join(root, "main", "settings.json"), "utf8"))).toEqual({ env: {} });
  });
});
