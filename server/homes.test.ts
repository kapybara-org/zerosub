import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { accountSettings, mergeSettings, mergeShared, prepareClaudeHome, prepareCodexHome, readAccountProxy, removeHome, writeAccountProxy } from "./homes";

let root: string;
const saved = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  PASEO_HOME: process.env.PASEO_HOME,
  NO_PROXY: process.env.NO_PROXY,
  no_proxy: process.env.no_proxy,
};

/** What the generated `env` of an account with its own proxy adds when nothing inherited has a no-proxy list. */
const NO_PROXY_PINNED = { no_proxy: "localhost,127.0.0.1,::1,downloads.claude.ai", NO_PROXY: "localhost,127.0.0.1,::1,downloads.claude.ai" };

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-homes-")));
  // The generated settings of an account with a proxy depend on the daemon's no-proxy list.
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function isLinkTo(path: string, target: string): Promise<boolean> {
  const entry = await lstat(path).catch(() => null);
  return Boolean(entry?.isSymbolicLink()) && (await readlink(path)) === target;
}

async function sync(home: string, main: string, config: Record<string, unknown>, bump = 0): Promise<void> {
  await writeFile(join(main, ".claude.json"), JSON.stringify(config));
  if (bump) {
    const at = new Date(Date.now() + bump);
    await utimes(join(main, ".claude.json"), at, at);
  }
  await prepareClaudeHome(home, true);
}

describe("prepareClaudeHome", () => {
  it("shares configuration and history but keeps credentials and identity per account", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-a");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(join(main, "skills"), { recursive: true });
    await mkdir(join(main, "backups"), { recursive: true });
    await writeFile(join(main, "settings.json"), "{}");
    await writeFile(join(main, ".credentials.json"), "{}");
    await writeFile(join(main, "settings.json.tmp.123.abc"), "");
    await sync(home, main, {
      oauthAccount: { emailAddress: "main@example.com" },
      userID: "device",
      cachedGrowthBookFeatures: {},
      mcpServers: { docs: { command: "docs-mcp" } },
      projects: { "/work": { allowedTools: ["Bash(ls)"] } },
      theme: "dark",
    });

    expect((await lstat(join(home, "settings.json"))).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({});
    expect(await isLinkTo(join(home, "skills"), join(main, "skills"))).toBe(true);
    // Created in main up front so history is shared from the first session.
    expect(await isLinkTo(join(home, "projects"), join(main, "projects"))).toBe(true);
    expect(await isLinkTo(join(home, "todos"), join(main, "todos"))).toBe(true);
    for (const name of [".credentials.json", "backups", "settings.json.tmp.123.abc"]) {
      expect(await lstat(join(home, name)).catch(() => null)).toBeNull();
    }

    const seeded = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(seeded.oauthAccount).toBeUndefined();
    expect(seeded.userID).toBeUndefined();
    expect(seeded.cachedGrowthBookFeatures).toBeUndefined();
    expect(seeded.mcpServers).toEqual({ docs: { command: "docs-mcp" } });
    expect(seeded.theme).toBe("dark");
    expect(seeded.hasCompletedOnboarding).toBe(true);
  });

  it("reads main's settings through a dotfiles symlink without touching the link", async () => {
    const main = join(root, "main");
    const dotfiles = join(root, "dotfiles");
    const home = join(root, "homes", "claude-d");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(main, { recursive: true });
    await mkdir(dotfiles, { recursive: true });
    await writeFile(join(dotfiles, "settings.json"), '{"model":"opus"}');
    await symlink(join(dotfiles, "settings.json"), join(main, "settings.json"));
    await prepareClaudeHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ model: "opus" });
    expect(await isLinkTo(join(main, "settings.json"), join(dotfiles, "settings.json"))).toBe(true);
    expect(await readFile(join(dotfiles, "settings.json"), "utf8")).toBe('{"model":"opus"}');
  });

  it("layers the account's settings over main's and follows main's later changes", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-s");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(home, { recursive: true });
    await mkdir(main, { recursive: true });
    await writeFile(
      join(main, "settings.json"),
      JSON.stringify({ env: { DISABLE_TELEMETRY: "1", HTTPS_PROXY: "http://main:1" }, permissions: { allow: ["Bash(ls)"] }, model: "opus" }),
    );
    await writeFile(join(home, "settings.account.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://account:2" }, model: "sonnet" }));
    await prepareClaudeHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({
      env: { DISABLE_TELEMETRY: "1", HTTPS_PROXY: "http://account:2", ...NO_PROXY_PINNED },
      permissions: { allow: ["Bash(ls)"] },
      model: "sonnet",
    });

    await writeFile(join(main, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: "http://main:1" }, hooks: { Stop: [] } }));
    await prepareClaudeHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({
      env: { HTTPS_PROXY: "http://account:2", ...NO_PROXY_PINNED },
      hooks: { Stop: [] },
      model: "sonnet",
    });
  });

  it("replaces an earlier version's link to main's settings without writing through it", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-m");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(home, { recursive: true });
    await mkdir(main, { recursive: true });
    await writeFile(join(main, "settings.json"), '{"model":"opus"}');
    await symlink(join(main, "settings.json"), join(home, "settings.json"));
    await writeFile(join(home, "settings.account.json"), '{"env":{"HTTPS_PROXY":"http://account:2"}}');
    await prepareClaudeHome(home, true);
    expect((await lstat(join(home, "settings.json"))).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ model: "opus", env: { HTTPS_PROXY: "http://account:2", ...NO_PROXY_PINNED } });
    expect(await readFile(join(main, "settings.json"), "utf8")).toBe('{"model":"opus"}');
  });

  it("leaves a link to other settings alone in a home that isn't ZeroSub's own", async () => {
    const main = join(root, "main");
    const dotfiles = join(root, "dotfiles");
    const home = join(root, "elsewhere", "claude-work");
    process.env.CLAUDE_CONFIG_DIR = main;
    process.env.PASEO_HOME = root;
    await mkdir(home, { recursive: true });
    await mkdir(main, { recursive: true });
    await mkdir(dotfiles, { recursive: true });
    await writeFile(join(main, "settings.json"), '{"model":"opus"}');
    await writeFile(join(dotfiles, "work.json"), '{"model":"haiku"}');
    await symlink(join(dotfiles, "work.json"), join(home, "settings.json"));
    await prepareClaudeHome(home, true);
    expect(await isLinkTo(join(home, "settings.json"), join(dotfiles, "work.json"))).toBe(true);
    expect(await lstat(join(home, "settings.account.json")).catch(() => null)).toBeNull();
    // A proxy kept beside the link would never be used, so it isn't taken.
    await expect(writeAccountProxy(home, "http://127.0.0.1:7890")).rejects.toThrow(`links to ${join(dotfiles, "work.json")}`);
    expect(await lstat(join(home, "settings.account.json")).catch(() => null)).toBeNull();
    expect(await isLinkTo(join(home, "settings.json"), join(dotfiles, "work.json"))).toBe(true);
    expect(await readFile(join(dotfiles, "work.json"), "utf8")).toBe('{"model":"haiku"}');
  });

  it("replaces any link in a home of ZeroSub's own", async () => {
    const main = join(root, "main");
    const dotfiles = join(root, "dotfiles");
    const home = join(root, "zerosub", "homes", "claude-own");
    process.env.CLAUDE_CONFIG_DIR = main;
    process.env.PASEO_HOME = root;
    await mkdir(home, { recursive: true });
    await mkdir(main, { recursive: true });
    await mkdir(dotfiles, { recursive: true });
    await writeFile(join(main, "settings.json"), '{"model":"opus"}');
    await writeFile(join(dotfiles, "work.json"), '{"model":"haiku"}');
    await symlink(join(dotfiles, "work.json"), join(home, "settings.json"));
    await prepareClaudeHome(home, true);
    expect((await lstat(join(home, "settings.json"))).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ model: "opus" });
    expect(await readFile(join(dotfiles, "work.json"), "utf8")).toBe('{"model":"haiku"}');
  });

  it("leaves a hand-made settings.json alone until the account has its own overrides", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-h");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(home, { recursive: true });
    await mkdir(main, { recursive: true });
    await writeFile(join(main, "settings.json"), '{"model":"opus"}');
    await writeFile(join(home, "settings.json"), '{"env":{"HTTPS_PROXY":"http://by-hand:3"}}');
    await prepareClaudeHome(home, true);
    expect(await readFile(join(home, "settings.json"), "utf8")).toBe('{"env":{"HTTPS_PROXY":"http://by-hand:3"}}');
    expect(await lstat(join(home, "settings.account.json")).catch(() => null)).toBeNull();
  });

  it("keeps the previous settings when the account's overrides don't parse", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-i");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(home, { recursive: true });
    await mkdir(main, { recursive: true });
    await writeFile(join(main, "settings.json"), "{}");
    await writeFile(join(home, "settings.account.json"), '{"env":{"HTTPS_PROXY":"http://account:2"}}');
    await prepareClaudeHome(home, true);
    const before = await readFile(join(home, "settings.json"), "utf8");

    await writeFile(join(home, "settings.account.json"), '{"env":{"HTTPS_PROXY":');
    await writeFile(join(main, "settings.json"), '{"model":"opus"}');
    await expect(prepareClaudeHome(home, true)).rejects.toThrow();
    expect(await readFile(join(home, "settings.json"), "utf8")).toBe(before);
  });


  it("keeps MCP servers in step with main without clobbering the account", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-b");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(main, { recursive: true });
    await sync(home, main, { mcpServers: { docs: { command: "docs-mcp" }, old: { command: "old-mcp" } } });

    // The account signs in and adds a server of its own; Claude Code writes its identity here.
    const signedIn = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    signedIn.oauthAccount = { emailAddress: "b@example.com" };
    signedIn.mcpServers = { ...signedIn.mcpServers, mine: { command: "mine-mcp" } };
    signedIn.projects = { "/work": { allowedTools: ["Bash(npm test)"] } };
    await writeFile(join(home, ".claude.json"), JSON.stringify(signedIn));

    await sync(
      home,
      main,
      {
        mcpServers: { docs: { command: "docs-mcp-v2" }, linear: { url: "https://mcp.linear.app" } },
        projects: { "/work": { hasTrustDialogAccepted: true, allowedTools: ["Bash(ls)"] } },
      },
      5_000,
    );

    const synced = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(synced.oauthAccount).toEqual({ emailAddress: "b@example.com" });
    expect(synced.mcpServers).toEqual({
      docs: { command: "docs-mcp-v2" },
      linear: { url: "https://mcp.linear.app" },
      mine: { command: "mine-mcp" },
    });
    expect(synced.projects["/work"]).toEqual({ allowedTools: ["Bash(npm test)", "Bash(ls)"], hasTrustDialogAccepted: true });
    expect(await lstat(join(home, ".claude.json.lock")).catch(() => null)).toBeNull();
  });

  it("leaves entries the CLI created inside the home alone", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-c");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(join(home, "plans"), { recursive: true });
    await writeFile(join(home, "plans", "mine.md"), "keep me");
    await mkdir(join(main, "plans"), { recursive: true });
    await prepareClaudeHome(home, true);
    expect((await lstat(join(home, "plans"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(home, "plans", "mine.md"), "utf8")).toBe("keep me");
  });
});

describe("prepareCodexHome", () => {
  it("shares sessions and config but not credentials, caches or databases", async () => {
    const main = join(root, "codex");
    const home = join(root, "homes", "codex-a");
    process.env.CODEX_HOME = main;
    await mkdir(join(main, "skills"), { recursive: true });
    for (const name of ["auth.json", "config.toml", "models_cache.json", "state_5.sqlite", "state_5.sqlite-wal", "..codex-global-state.json.tmp-1"]) {
      await writeFile(join(main, name), "");
    }
    await prepareCodexHome(home, true);

    expect(await isLinkTo(join(home, "config.toml"), join(main, "config.toml"))).toBe(true);
    expect(await isLinkTo(join(home, "sessions"), join(main, "sessions"))).toBe(true);
    expect(await isLinkTo(join(home, "archived_sessions"), join(main, "archived_sessions"))).toBe(true);
    for (const name of ["auth.json", "models_cache.json", "state_5.sqlite", "state_5.sqlite-wal", "..codex-global-state.json.tmp-1"]) {
      expect(await lstat(join(home, name)).catch(() => null)).toBeNull();
    }
  });
});

describe("removeHome", () => {
  it("deletes the home without touching what its links point at", async () => {
    process.env.PASEO_HOME = root;
    const main = join(root, "main");
    const home = join(root, "zerosub", "homes", "claude-x");
    await mkdir(join(main, "projects"), { recursive: true });
    await writeFile(join(main, "projects", "conversation.jsonl"), "keep");
    await mkdir(home, { recursive: true });
    await symlink(join(main, "projects"), join(home, "projects"));
    await writeFile(join(home, ".claude.json"), "{}");

    await removeHome(home);

    expect(await lstat(home).catch(() => null)).toBeNull();
    expect(await readFile(join(main, "projects", "conversation.jsonl"), "utf8")).toBe("keep");
  });

  it("refuses anything outside zerosub's homes directory", async () => {
    process.env.PASEO_HOME = root;
    const outside = join(root, "elsewhere");
    await mkdir(outside, { recursive: true });
    await removeHome(outside);
    expect((await lstat(outside)).isDirectory()).toBe(true);
  });

  it("refuses a path that only starts with the homes directory", async () => {
    process.env.PASEO_HOME = root;
    const outside = join(root, "zerosub", "elsewhere");
    await mkdir(outside, { recursive: true });
    await mkdir(join(root, "zerosub", "homes", "claude-x"), { recursive: true });
    await removeHome([join(root, "zerosub", "homes", "claude-x"), "..", "..", "elsewhere"].join(sep));
    expect((await lstat(outside)).isDirectory()).toBe(true);
  });
});

describe("mergeShared", () => {
  it("merges objects, unions lists and adopts true", () => {
    expect(mergeShared({ a: 1, mine: 2 }, { a: 3, b: 4 })).toEqual({ a: 3, b: 4, mine: 2 });
    expect(mergeShared({ gone: 1, mine: 2 }, { a: 1 }, new Set(["gone", "a"]))).toEqual({ a: 1, mine: 2 });
    expect(mergeShared(["x"], ["x", "y"])).toEqual(["x", "y"]);
    expect(mergeShared(false, true)).toBe(true);
    expect(mergeShared(true, false)).toBe(true);
  });
});

describe("account proxy", () => {
  it("sets all four proxy variables, keeps the account's other overrides, and clears cleanly", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-p");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(home, { recursive: true });
    await mkdir(main, { recursive: true });
    await writeFile(join(main, "settings.json"), JSON.stringify({ env: { https_proxy: "http://main:1", DISABLE_TELEMETRY: "1" } }));
    await writeFile(join(home, "settings.account.json"), JSON.stringify({ model: "sonnet", env: { MY_VAR: "x" } }));

    await writeAccountProxy(home, "http://127.0.0.1:7890");
    const proxy = { https_proxy: "http://127.0.0.1:7890", HTTPS_PROXY: "http://127.0.0.1:7890", http_proxy: "http://127.0.0.1:7890", HTTP_PROXY: "http://127.0.0.1:7890" };
    expect(JSON.parse(await readFile(join(home, "settings.account.json"), "utf8"))).toEqual({ model: "sonnet", env: { MY_VAR: "x", ...proxy } });
    // Generated straight away, with the account's proxy winning over main's lower-case one.
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({
      env: { DISABLE_TELEMETRY: "1", MY_VAR: "x", ...proxy, ...NO_PROXY_PINNED },
      model: "sonnet",
    });
    expect(await readAccountProxy(home)).toBe("http://127.0.0.1:7890");

    await writeAccountProxy(home, null);
    expect(JSON.parse(await readFile(join(home, "settings.account.json"), "utf8"))).toEqual({ model: "sonnet", env: { MY_VAR: "x" } });
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).env).toEqual({ https_proxy: "http://main:1", DISABLE_TELEMETRY: "1", MY_VAR: "x" });
    expect(await readAccountProxy(home)).toBeNull();
  });

  it("sets up a brand-new home, before anything else exists in it", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-new");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(main, { recursive: true });
    await writeAccountProxy(home, "http://127.0.0.1:7890");
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  });

  it("writes nothing, nor makes the home again, for an account removed meanwhile", async () => {
    const home = join(root, "homes", "claude-gone");
    process.env.CLAUDE_CONFIG_DIR = join(root, "main");
    const gone = async () => false;
    await expect(writeAccountProxy(home, "http://127.0.0.1:7890", gone)).rejects.toThrow("That account no longer exists.");
    expect(await lstat(home).catch(() => null)).toBeNull();
  });

  it("adopts a hand-made settings.json as the account's overrides instead of dropping it", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-h2");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(home, { recursive: true });
    await mkdir(main, { recursive: true });
    await writeFile(join(main, "settings.json"), '{"model":"opus","hooks":{}}');
    await writeFile(join(home, "settings.json"), '{"model":"haiku","env":{"KEEP":"1"}}');
    await writeAccountProxy(home, "http://127.0.0.1:7890");
    const settings = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    expect(settings.model).toBe("haiku");
    expect(settings.hooks).toEqual({});
    expect(settings.env.KEEP).toBe("1");
    expect(settings.env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  });

  it("refuses to touch overrides that don't parse", async () => {
    const home = join(root, "homes", "claude-bad");
    process.env.CLAUDE_CONFIG_DIR = join(root, "main");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.account.json"), "{oops");
    await expect(writeAccountProxy(home, "http://127.0.0.1:7890")).rejects.toThrow();
    expect(await readFile(join(home, "settings.account.json"), "utf8")).toBe("{oops");
  });

  it("says which overrides don't parse without quoting them, as they may hold a key", async () => {
    const home = join(root, "homes", "claude-bad");
    process.env.CLAUDE_CONFIG_DIR = join(root, "main");
    await mkdir(home, { recursive: true });
    // A key typed in by hand without its quotes.
    await writeFile(join(home, "settings.account.json"), '{"env":{"ANTHROPIC_API_KEY":sk-ant-api03-secret}}');
    const error = String(await writeAccountProxy(home, "http://127.0.0.1:7890").catch((failure: unknown) => failure));
    expect(error).toContain(`${join(home, "settings.account.json")} isn't valid JSON`);
    expect(error).not.toContain("sk-ant");
  });
});


describe("mergeSettings", () => {
  it("lets the account win and merges objects one level deep", () => {
    expect(mergeSettings({ env: { A: "1", B: "2" }, model: "opus", list: ["x"] }, { env: { B: "3" }, list: ["y"] })).toEqual({
      env: { A: "1", B: "3" },
      model: "opus",
      list: ["y"],
    });
  });
});


describe("a home's settings.account.json marker", () => {
  it("is written at the first sync even without main settings, so main's later settings still reach the home", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-early");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(main, { recursive: true });
    await prepareClaudeHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.account.json"), "utf8"))).toEqual({});

    // Claude Code writes the generated file itself (for /model, say); main gets settings later.
    await writeFile(join(home, "settings.json"), '{"model":"haiku"}');
    await writeFile(join(main, "settings.json"), JSON.stringify({ env: { SHARED: "1" } }));
    await prepareClaudeHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ env: { SHARED: "1" }, model: "haiku" });
  });

  it("keeps what Claude Code saves in an added account's settings.json as the account's own, and main's later changes still reach it", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-own");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(main, { recursive: true });
    await writeFile(join(main, "settings.json"), JSON.stringify({ model: "opus", enabledPlugins: { a: true }, theme: "dark" }));
    await prepareClaudeHome(home, true);
    await writeAccountProxy(home, "http://127.0.0.1:7890");

    // /model and enabling a plugin there: Claude Code rewrites the whole file, everything else as it was.
    const generated = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    await writeFile(join(home, "settings.json"), JSON.stringify({ ...generated, model: "haiku", enabledPlugins: { a: true, b: true } }));
    await prepareClaudeHome(home, true);
    const own = JSON.parse(await readFile(join(home, "settings.account.json"), "utf8"));
    expect(own).toEqual({ env: expect.objectContaining({ HTTPS_PROXY: "http://127.0.0.1:7890" }), model: "haiku", enabledPlugins: { b: true } });
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toMatchObject({ model: "haiku", enabledPlugins: { a: true, b: true }, theme: "dark" });

    // Main's own changes still come through underneath, and a sync with nothing new changes nothing.
    await writeFile(join(main, "settings.json"), JSON.stringify({ model: "sonnet", enabledPlugins: { a: false, c: true }, theme: "light" }));
    await prepareClaudeHome(home, true);
    await prepareClaudeHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toMatchObject({ model: "haiku", enabledPlugins: { a: false, b: true, c: true }, theme: "light" });
    expect(JSON.parse(await readFile(join(home, "settings.account.json"), "utf8"))).toEqual(own);

    // A setting of the account's own that Claude Code takes out goes from its overrides too.
    const now = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    delete now.model;
    await writeFile(join(home, "settings.json"), JSON.stringify(now));
    await prepareClaudeHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.account.json"), "utf8")).model).toBeUndefined();
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).model).toBe("sonnet");
  });

  it("is added to a home of ZeroSub's own left without one, keeping what Claude Code wrote there as its overrides", async () => {
    process.env.PASEO_HOME = root;
    const main = join(root, "main");
    const home = join(root, "zerosub", "homes", "claude-stuck");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(home, { recursive: true });
    await mkdir(main, { recursive: true });
    await writeFile(join(home, "settings.json"), '{"model":"haiku"}');
    await writeFile(join(main, "settings.json"), JSON.stringify({ env: { SHARED: "1" }, model: "opus" }));
    await prepareClaudeHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.account.json"), "utf8"))).toEqual({ model: "haiku" });
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ env: { SHARED: "1" }, model: "haiku" });
  });
});


describe("merged settings lists", () => {
  it("join permissions and hooks the way Claude Code does, as Claude Code merges them across its settings files", () => {
    const stop = { hooks: [{ type: "command", command: "notify" }] };
    const lint = { matcher: "Edit", hooks: [{ type: "command", command: "lint" }] };
    const main = {
      permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)"], defaultMode: "default" },
      hooks: { Stop: [stop], PreToolUse: [lint] },
      env: { ANTHROPIC_API_KEY: "sk-main", SHARED: "1" },
      enabledMcpjsonServers: ["main"],
    };
    const account = {
      permissions: { deny: ["Read(.env)", "WebFetch"], ask: ["Bash(git push:*)"], defaultMode: "plan" },
      hooks: { Stop: [{ hooks: [{ type: "command", command: "beep" }] }] },
      enabledMcpjsonServers: ["mine"],
    };
    expect(mergeSettings(main, account)).toEqual({
      permissions: { allow: ["Bash(ls)"], deny: ["Read(.env)", "WebFetch"], ask: ["Bash(git push:*)"], defaultMode: "plan" },
      hooks: { Stop: [stop, { hooks: [{ type: "command", command: "beep" }] }], PreToolUse: [lint] },
      env: { ANTHROPIC_API_KEY: "sk-main", SHARED: "1" },
      enabledMcpjsonServers: ["mine"],
    });
  });
});

describe("an account's own proxy and the no-proxy list", () => {
  it("pins no_proxy and NO_PROXY without the entries that would skip the proxy for Claude", () => {
    const main = { env: { NO_PROXY: "localhost,.anthropic.com,corp.example" } };
    const account = { env: { HTTPS_PROXY: "http://127.0.0.1:7890" } };
    const inherited = { no_proxy: "*.claude.ai,127.0.0.1,api.anthropic.com:443" };
    const env = accountSettings(main, account, inherited).env as Record<string, string>;
    // Claude Code reads both when they differ: the daemon's lower-case list and main's upper-case one.
    expect(env.no_proxy).toBe("localhost,127.0.0.1,::1,downloads.claude.ai,corp.example");
    expect(env.NO_PROXY).toBe(env.no_proxy);
    expect(accountSettings({}, account, { NO_PROXY: "*" }).env).toMatchObject(NO_PROXY_PINNED);

    // Without a proxy of its own, an account keeps what it inherits.
    expect(accountSettings(main, { env: { MY_VAR: "x" } }, inherited).env).toEqual({ ...main.env, MY_VAR: "x" });
  });

  it("is generated from the daemon's environment too", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-np");
    process.env.CLAUDE_CONFIG_DIR = main;
    process.env.NO_PROXY = "localhost,anthropic.com,claude.ai";
    await mkdir(main, { recursive: true });
    await writeAccountProxy(home, "http://127.0.0.1:7890");
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).env).toMatchObject(NO_PROXY_PINNED);
    await writeAccountProxy(home, null);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).env).toBeUndefined();
  });
});

