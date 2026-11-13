import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnEnv } from "./adapter";
import { ClaudeAdapter, accountProxy } from "./claude";
import { inheritedClaudeProxy, mainProxyBlock, mainProxyEnv, mainProxyPath, readMainProxy, writeMainProxy } from "./main-proxy";
import { rememberProviderEnvs } from "./provider-env";

const USAGE = "https://api.anthropic.com/api/oauth/usage";
const VARIABLES = ["PASEO_HOME", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-main-proxy-")));
  saved = Object.fromEntries(VARIABLES.map((key) => [key, process.env[key]]));
  for (const key of VARIABLES) delete process.env[key];
  process.env.PASEO_HOME = join(root, "paseo");
  process.env.CLAUDE_CONFIG_DIR = join(root, "main");
  await mkdir(join(root, "main"), { recursive: true });
});

afterEach(async () => {
  rememberProviderEnvs({}, undefined);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Retried: a write the test set off in the background can still be landing in it.
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function mainSettings(env: Record<string, string>) {
  return writeFile(join(root, "main", "settings.json"), JSON.stringify({ env }));
}

describe("the CLI login's proxy", () => {
  it("is kept beside the registry, readable only by you, while main's settings set none", async () => {
    await mainSettings({ FOO: "1" });
    await writeMainProxy("http://me:secret@10.0.0.1:3128");
    expect(await readMainProxy()).toEqual({ proxy: "http://me:secret@10.0.0.1:3128", file: null });
    expect(mainProxyPath()).toBe(join(root, "paseo", "zerosub", "cli-login.json"));
    expect((await stat(mainProxyPath())).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(root, "main", "settings.json"), "utf8"))).toEqual({ env: { FOO: "1" } });

    await writeMainProxy(null);
    expect(await readMainProxy()).toEqual({ proxy: null, file: null });
    await expect(stat(mainProxyPath())).rejects.toThrow();
  });

  it("starts the CLI login with all four proxy variables and a no-proxy list that keeps Claude on it", async () => {
    expect(await mainProxyEnv()).toEqual({});
    process.env.NO_PROXY = "corp.example,.anthropic.com";
    rememberProviderEnvs({ claude: "claude" }, { claude: { env: { HTTPS_PROXY: "http://provider:2" } } });
    await writeMainProxy("http://127.0.0.1:7890");
    const proxy = "http://127.0.0.1:7890";
    const expected = { https_proxy: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, HTTP_PROXY: proxy, no_proxy: "localhost,127.0.0.1,::1,downloads.claude.ai,corp.example", NO_PROXY: "localhost,127.0.0.1,::1,downloads.claude.ai,corp.example" };
    expect(await mainProxyEnv()).toEqual(expected);

    const adapter = new ClaudeAdapter();
    expect(await adapter.env(null)).toEqual({ CLAUDE_CONFIG_DIR: null, CLAUDE_SECURESTORAGE_CONFIG_DIR: null, ...expected });
    // Without it, the daemon's no-proxy list would send it around the provider's proxy.
    expect(await adapter.proxyState(null)).toEqual({ own: proxy, file: null, inherited: null, blocked: null });
    // The CLI processes ZeroSub starts for it, and its own calls with the login's token, go the same way.
    expect(spawnEnv(await adapter.env(null), "claude")).toMatchObject(expected);
    expect(await accountProxy(null, USAGE)).toBe(proxy);
    // An added account keeps its own settings.
    expect(Object.keys(await adapter.env(join(root, "homes", "claude-a")))).toEqual(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]);
  });

  it("is changed in main's settings when they set one, which Claude Code would go by, leaving the rest as it was", async () => {
    await writeMainProxy("http://127.0.0.1:2020");
    // Main's settings linked in from elsewhere, readable by others, setting a proxy by hand since.
    const real = join(root, "dotfiles", "claude-settings.json");
    await mkdir(join(root, "dotfiles"));
    const old = "http://127.0.0.1:1133";
    const before = { model: "opus", env: { https_proxy: old, HTTPS_PROXY: old, http_proxy: old, HTTP_PROXY: old, NO_PROXY: "localhost", FOO: "1" } };
    await writeFile(real, JSON.stringify(before), { mode: 0o644 });
    await symlink(real, join(root, "main", "settings.json"));
    const file = join(root, "main", "settings.json");
    expect(await readMainProxy()).toEqual({ proxy: old, file });
    expect(await mainProxyEnv()).toEqual({});
    expect(await accountProxy(null, USAGE)).toBe(old);

    await writeMainProxy("http://127.0.0.1:7890");
    const now = "http://127.0.0.1:7890";
    expect(JSON.parse(await readFile(real, "utf8"))).toEqual({
      model: "opus",
      env: { https_proxy: now, HTTPS_PROXY: now, http_proxy: now, HTTP_PROXY: now, NO_PROXY: "localhost,127.0.0.1,::1,downloads.claude.ai", no_proxy: "localhost,127.0.0.1,::1,downloads.claude.ai", FOO: "1" },
    });
    expect((await lstat(file)).isSymbolicLink()).toBe(true);
    expect((await stat(real)).mode & 0o777).toBe(0o644);
    // It's the only proxy the CLI login has now.
    await expect(stat(mainProxyPath())).rejects.toThrow();
    expect(await readMainProxy()).toEqual({ proxy: now, file });
    expect(await accountProxy(null, USAGE)).toBe(now);
    // The file as it was is kept, readable only by you.
    const backups = join(root, "paseo", "zerosub", "backups");
    const [copy, ...more] = (await readdir(backups)).filter((name) => name.startsWith("claude-settings-"));
    expect(more).toEqual([]);
    expect(JSON.parse(await readFile(join(backups, copy!), "utf8"))).toEqual(before);
    expect((await stat(join(backups, copy!))).mode & 0o777).toBe(0o600);

    await writeMainProxy(null);
    expect(JSON.parse(await readFile(real, "utf8"))).toEqual({ model: "opus", env: { NO_PROXY: "localhost,127.0.0.1,::1,downloads.claude.ai", no_proxy: "localhost,127.0.0.1,::1,downloads.claude.ai", FOO: "1" } });
    expect(await readMainProxy()).toEqual({ proxy: null, file: null });
  });

  it("keeps the five latest copies of main's settings from before it changed them", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (let minute = 0; minute < 7; minute += 1) {
        vi.setSystemTime(Date.UTC(2026, 9, 29, 1, minute));
        await mainSettings({ HTTPS_PROXY: `http://127.0.0.1:${1000 + minute}` });
        await writeMainProxy("http://127.0.0.1:7890");
      }
    } finally {
      vi.useRealTimers();
    }
    const backups = join(root, "paseo", "zerosub", "backups");
    const names = (await readdir(backups)).filter((name) => name.startsWith("claude-settings-")).sort();
    expect(names).toEqual([2, 3, 4, 5, 6].map((minute) => `claude-settings-2026-10-29T01-0${minute}-00-000Z.json`));
  });

  it("can't be set while main's settings send Anthropic or Claude around any proxy, and can always be cleared", async () => {
    await mainSettings({ NO_PROXY: "localhost,127.0.0.1" });
    await writeMainProxy("http://127.0.0.1:7890");
    expect(await mainProxyBlock()).toBeNull();

    await mainSettings({ no_proxy: "localhost,.anthropic.com", NO_PROXY: "*" });
    const block = `${join(root, "main", "settings.json")} sets no_proxy and NO_PROXY in its env with Anthropic or Claude on it, so Claude Code goes around any proxy for them. Take those entries out there first.`;
    expect(await mainProxyBlock()).toBe(block);
    await expect(writeMainProxy("http://127.0.0.1:7891")).rejects.toThrow(block);
    expect(await readMainProxy()).toEqual({ proxy: "http://127.0.0.1:7890", file: null });
    await writeMainProxy(null);
    expect(await readMainProxy()).toEqual({ proxy: null, file: null });

    await writeFile(join(root, "main", "settings.json"), "{ not json");
    await expect(mainProxyBlock()).rejects.toThrow("isn't valid JSON");
  });
});

describe("the proxy an account goes through without one of its own", () => {
  it("is the one Claude Code picks, from main's settings over Paseo's config over the daemon", async () => {
    expect(await inheritedClaudeProxy()).toBeNull();
    process.env.HTTPS_PROXY = "http://daemon:1";
    expect(await inheritedClaudeProxy()).toEqual({ proxy: "http://daemon:1", from: "the daemon's environment" });
    rememberProviderEnvs({ claude: "claude" }, { claude: { env: { HTTPS_PROXY: "http://provider:2" } } });
    expect(await inheritedClaudeProxy()).toEqual({ proxy: "http://provider:2", from: "the Claude provider's env in Paseo's config" });
    // The lower-case variable comes first, wherever it's set.
    await mainSettings({ HTTPS_PROXY: "http://settings:3" });
    process.env.https_proxy = "http://daemon:4";
    expect(await inheritedClaudeProxy()).toEqual({ proxy: "http://daemon:4", from: "the daemon's environment" });
    await mainSettings({ https_proxy: "http://settings:3" });
    expect(await inheritedClaudeProxy()).toEqual({ proxy: "http://settings:3", from: join(root, "main", "settings.json") });
  });

  it("is, for the CLI login, the one it would go through with its own taken out of main's settings", async () => {
    process.env.HTTPS_PROXY = "http://daemon:1";
    await mainSettings({ https_proxy: "http://settings:3", HTTPS_PROXY: "http://settings:3" });
    expect(await inheritedClaudeProxy(true)).toEqual({ proxy: "http://daemon:1", from: "the daemon's environment" });
    // Without one there, a blank in main's settings still blanks the daemon's out.
    await mainSettings({ HTTPS_PROXY: "" });
    expect(await inheritedClaudeProxy(true)).toBeNull();
  });

  it("is none when Anthropic is on the no-proxy list, or a setting blanks the proxy out", async () => {
    process.env.HTTPS_PROXY = "http://daemon:1";
    await mainSettings({ NO_PROXY: ".anthropic.com" });
    expect(await inheritedClaudeProxy()).toBeNull();
    await mainSettings({ HTTPS_PROXY: "" });
    expect(await inheritedClaudeProxy()).toBeNull();
  });
});
