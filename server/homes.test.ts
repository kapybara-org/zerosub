import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountSettings,
  mergeSettings,
  mergeShared,
  normalizeBaseUrl,
  prepareClaudeHome,
  readAccountApi,
  readAccountProxy,
  writeAccountApi,
  writeAccountProxy,
  prepareCodexHome,
  removeHome,
} from "./homes";

let root: string;
const saved = {
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  PASEO_HOME: process.env.PASEO_HOME,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
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
  // Retried: a write the test set off in the background can still be landing in it.
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

  it("never replaces an account's .claude.json that doesn't read, and syncs it once it reads again", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-d");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(main, { recursive: true });
    await sync(home, main, { mcpServers: { docs: { command: "docs-mcp" } } });

    // Half written, say. The account's identity is in there, so it mustn't become just main's servers.
    const damaged = '{"oauthAccount":{"emailAddress":"d@example.com"},"mcpServers":';
    await writeFile(join(home, ".claude.json"), damaged);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const linear = { mcpServers: { linear: { url: "https://mcp.linear.app" } } };
    await sync(home, main, linear, 5_000);
    await sync(home, main, linear, 10_000);
    expect(await readFile(join(home, ".claude.json"), "utf8")).toBe(damaged);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();

    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "d@example.com" } }));
    await sync(home, main, linear, 15_000);
    const synced = JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    expect(synced.oauthAccount).toEqual({ emailAddress: "d@example.com" });
    expect(synced.mcpServers).toEqual({ linear: { url: "https://mcp.linear.app" } });
  });

  it("leaves the user's own links alone in a home that isn't ZeroSub's own", async () => {
    const main = join(root, "main");
    const dotfiles = join(root, "dotfiles");
    const elsewhere = join(root, "elsewhere", "claude-work");
    const own = join(root, "zerosub", "homes", "claude-own");
    process.env.CLAUDE_CONFIG_DIR = main;
    process.env.PASEO_HOME = root;
    await mkdir(join(main, "skills"), { recursive: true });
    await mkdir(join(dotfiles, "skills"), { recursive: true });
    for (const home of [elsewhere, own]) {
      await mkdir(home, { recursive: true });
      await symlink(join(dotfiles, "skills"), join(home, "skills"));
      await symlink(join(dotfiles, "gone"), join(home, "notes"));
      await symlink(join(main, "agents"), join(home, "agents")); // shared once, and gone from main since
      await prepareClaudeHome(home, true);
      expect(await lstat(join(home, "agents")).catch(() => null)).toBeNull();
    }
    expect(await isLinkTo(join(elsewhere, "skills"), join(dotfiles, "skills"))).toBe(true);
    expect(await isLinkTo(join(elsewhere, "notes"), join(dotfiles, "gone"))).toBe(true);
    expect(await isLinkTo(join(own, "skills"), join(main, "skills"))).toBe(true);
    expect(await lstat(join(own, "notes")).catch(() => null)).toBeNull();
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

  it("shares sessions from the first sync, so sessions on any account see each other", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-d");
    process.env.CLAUDE_CONFIG_DIR = main;
    await prepareClaudeHome(home, true);
    expect(await isLinkTo(join(home, "sessions"), join(main, "sessions"))).toBe(true);
  });

  it("replaces an empty sessions folder from before it was shared with the link", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-e");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(join(home, "sessions"), { recursive: true });
    await mkdir(join(main, "sessions"), { recursive: true });
    await writeFile(join(main, "sessions", "1.json"), "{}");
    await prepareClaudeHome(home, true);
    expect(await isLinkTo(join(home, "sessions"), join(main, "sessions"))).toBe(true);
    expect(await readFile(join(main, "sessions", "1.json"), "utf8")).toBe("{}");
  });

  it("does the same in a home that isn't ZeroSub's own", async () => {
    const paseo = join(root, "paseo");
    const main = join(root, "main");
    const home = join(root, "elsewhere", "claude-f");
    process.env.PASEO_HOME = paseo;
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(join(home, "sessions"), { recursive: true });
    await prepareClaudeHome(home, true);
    expect(await isLinkTo(join(home, "sessions"), join(main, "sessions"))).toBe(true);
  });

  describe("a sessions folder with something in it", () => {
    const backups = async (home: string) => (await readdir(home)).filter((name) => name.startsWith("sessions.bak-"));

    it("is copied to main, kept as a backup and replaced with the link", async () => {
      const main = join(root, "main");
      const home = join(root, "homes", "claude-g");
      process.env.CLAUDE_CONFIG_DIR = main;
      await mkdir(join(home, "sessions", "nested"), { recursive: true });
      await writeFile(join(home, "sessions", "2.json"), "running");
      await writeFile(join(home, "sessions", "2.abc.key"), "secret", { mode: 0o600 });
      await writeFile(join(home, "sessions", "nested", "note"), "deep");
      await prepareClaudeHome(home, true);

      expect(await isLinkTo(join(home, "sessions"), join(main, "sessions"))).toBe(true);
      expect(await readFile(join(main, "sessions", "2.json"), "utf8")).toBe("running");
      expect(await readFile(join(main, "sessions", "nested", "note"), "utf8")).toBe("deep");
      expect((await stat(join(main, "sessions", "2.abc.key"))).mode & 0o777).toBe(0o600);
      const [backup, ...others] = await backups(home);
      expect(others).toEqual([]);
      expect(await readFile(join(home, backup!, "2.json"), "utf8")).toBe("running");
      expect(await readFile(join(home, backup!, "nested", "note"), "utf8")).toBe("deep");
    });

    it("never overwrites main's file of the same name, and the backup keeps the account's", async () => {
      const main = join(root, "main");
      const home = join(root, "homes", "claude-g");
      process.env.CLAUDE_CONFIG_DIR = main;
      await mkdir(join(home, "sessions"), { recursive: true });
      await mkdir(join(main, "sessions"), { recursive: true });
      await writeFile(join(home, "sessions", "3.json"), "account");
      await writeFile(join(main, "sessions", "3.json"), "main");
      await prepareClaudeHome(home, true);

      expect(await readFile(join(main, "sessions", "3.json"), "utf8")).toBe("main");
      const [backup] = await backups(home);
      expect(await readFile(join(home, backup!, "3.json"), "utf8")).toBe("account");
    });

    it("is backed up once: later syncs find the link", async () => {
      const main = join(root, "main");
      const home = join(root, "homes", "claude-g");
      process.env.CLAUDE_CONFIG_DIR = main;
      await mkdir(join(home, "sessions"), { recursive: true });
      await writeFile(join(home, "sessions", "4.json"), "{}");
      await prepareClaudeHome(home, true);
      await prepareClaudeHome(home, true);
      expect(await backups(home)).toHaveLength(1);
    });

    it("stays exactly as it is when the copy fails, and goes through at a later sync", async () => {
      const main = join(root, "main");
      const home = join(root, "homes", "claude-g");
      process.env.CLAUDE_CONFIG_DIR = main;
      await mkdir(join(home, "sessions"), { recursive: true });
      await mkdir(join(main, "sessions"), { recursive: true });
      await writeFile(join(home, "sessions", "5.json"), "running");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await chmod(join(main, "sessions"), 0o500);
      try {
        await prepareClaudeHome(home, true);
      } finally {
        await chmod(join(main, "sessions"), 0o700);
      }
      expect((await lstat(join(home, "sessions"))).isDirectory()).toBe(true);
      expect(await readFile(join(home, "sessions", "5.json"), "utf8")).toBe("running");
      expect(await backups(home)).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();

      await prepareClaudeHome(home, true);
      expect(await isLinkTo(join(home, "sessions"), join(main, "sessions"))).toBe(true);
    });

    it("is left alone when it's main's own, so main is never linked to itself", async () => {
      const main = join(root, "main");
      process.env.CLAUDE_CONFIG_DIR = main;
      await mkdir(join(main, "sessions"), { recursive: true });
      await prepareClaudeHome(main, true);
      expect((await lstat(join(main, "sessions"))).isDirectory()).toBe(true);

      await writeFile(join(main, "sessions", "6.json"), "main");
      await prepareClaudeHome(main, true);
      expect((await lstat(join(main, "sessions"))).isDirectory()).toBe(true);
      expect(await readFile(join(main, "sessions", "6.json"), "utf8")).toBe("main");
      expect(await backups(main)).toEqual([]);
    });
  });

  it("leaves a plain file called sessions alone", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-i");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "sessions"), "not a folder");
    await prepareClaudeHome(home, true);
    expect(await readFile(join(home, "sessions"), "utf8")).toBe("not a folder");
  });

  it("leaves any other empty folder the CLI made in the home alone", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-h");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(join(home, "plans"), { recursive: true });
    await mkdir(join(main, "plans"), { recursive: true });
    await prepareClaudeHome(home, true);
    expect((await lstat(join(home, "plans"))).isDirectory()).toBe(true);
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
    const api = { keyKind: "auth_token" as const, key: "secret-token", baseUrl: null, disableTelemetry: false, disableErrorReporting: false, disableNonessentialTraffic: false };
    await expect(writeAccountApi(home, api, gone)).rejects.toThrow(
      "That account no longer exists.",
    );
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

describe("account API settings", () => {
  const OFF = { disableTelemetry: false, disableErrorReporting: false, disableNonessentialTraffic: false };
  const KEY = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1111";
  const NEXT = "sk-ant-api03-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-2222";

  /** Main's settings sending everything to a company gateway with main's own credentials. */
  const CORPORATE = {
    model: "opus",
    apiKeyHelper: "~/bin/corp-key",
    env: {
      SHARED: "1",
      ANTHROPIC_BASE_URL: "https://corp-gateway.example",
      ANTHROPIC_API_KEY: "sk-ant-MAIN",
      ANTHROPIC_AUTH_TOKEN: "corp-token",
      CLAUDE_CODE_OAUTH_TOKEN: "main-oauth",
      ANTHROPIC_CUSTOM_HEADERS: "x-corp: secret",
      CLAUDE_CODE_USE_BEDROCK: "1",
    },
  };
  /** Everything an API account's generated `env` blanks unless the account sets it itself. */
  const BLANKED = {
    ANTHROPIC_API_KEY: "",
    ANTHROPIC_AUTH_TOKEN: "",
    CLAUDE_CODE_OAUTH_TOKEN: "",
    ANTHROPIC_CUSTOM_HEADERS: "",
    CLAUDE_CODE_USE_BEDROCK: "",
    CLAUDE_CODE_USE_VERTEX: "",
    CLAUDE_CODE_USE_FOUNDRY: "",
    CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
    CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "",
    CLAUDE_CODE_USE_MANTLE: "",
  };

  async function setUpHome(id: string, mainSettings: Record<string, unknown> = { env: { DISABLE_TELEMETRY: "0", SHARED: "1" } }) {
    const main = join(root, "main");
    const home = join(root, "homes", id);
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(main, { recursive: true });
    await writeFile(join(main, "settings.json"), JSON.stringify(mainSettings));
    await writeFile(
      join(main, ".claude.json"),
      JSON.stringify({ theme: "dark", customApiKeyResponses: { approved: ["main-own-key-approval"], rejected: [] } }),
    );
    const overrides = async () => JSON.parse(await readFile(join(home, "settings.account.json"), "utf8")).env;
    const global = async () => JSON.parse(await readFile(join(home, ".claude.json"), "utf8"));
    const generated = async () => JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    const setMain = (value: Record<string, unknown>) => writeFile(join(main, "settings.json"), JSON.stringify(value));
    return { home, overrides, global, generated, setMain };
  }

  it("stores the key, base URL and switches, and approves the key in a seeded .claude.json", async () => {
    const { home, overrides, global } = await setUpHome("claude-api");
    await writeAccountApi(home, { keyKind: "api_key", key: ` ${KEY} `, baseUrl: "https://gw.example.com/v1/", ...OFF, disableTelemetry: true });

    expect(await overrides()).toEqual({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://gw.example.com/v1", DISABLE_TELEMETRY: "1" });
    // The account's switch beats main's "0"; main's other variables still apply.
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8")).env).toMatchObject({ DISABLE_TELEMETRY: "1", SHARED: "1" });
    // Seeded from main (preferences, not main's own key approvals), then this key approved.
    expect(await global()).toMatchObject({ theme: "dark", customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] } });
    expect(await readAccountApi(home)).toEqual({
      keyKind: "api_key",
      keyHint: "1111",
      baseUrl: "https://gw.example.com/v1",
      disableTelemetry: true,
      disableErrorReporting: false,
      disableNonessentialTraffic: false,
    });

    // Keeping the home in sync with main later doesn't drop the approval.
    await prepareClaudeHome(home, true);
    expect((await global()).customApiKeyResponses.approved).toEqual([KEY.slice(-20)]);
  });

  it("keeps the key when none is typed, and retires the old approval when it's replaced", async () => {
    const { home, overrides, global } = await setUpHome("claude-keep");
    await writeAccountApi(home, { keyKind: "api_key", key: KEY, baseUrl: "https://gw.example.com", ...OFF, disableNonessentialTraffic: true });

    await writeAccountApi(home, { keyKind: "api_key", key: null, baseUrl: "https://gw.example.com", ...OFF, disableErrorReporting: true });
    expect(await overrides()).toEqual({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://gw.example.com", DISABLE_ERROR_REPORTING: "1" });

    await writeAccountApi(home, { keyKind: "api_key", key: NEXT, baseUrl: null, ...OFF });
    expect(await overrides()).toEqual({ ANTHROPIC_API_KEY: NEXT });
    expect((await global()).customApiKeyResponses.approved).toEqual([NEXT.slice(-20)]);
  });

  it("won't send a kept key to a different base URL", async () => {
    const { home, overrides } = await setUpHome("claude-move");
    await writeAccountApi(home, { keyKind: "api_key", key: KEY, baseUrl: "https://gw.example.com", ...OFF });
    for (const baseUrl of ["https://evil.example.com", null]) {
      await expect(writeAccountApi(home, { keyKind: "api_key", key: null, baseUrl, ...OFF })).rejects.toThrow(/key again/);
    }
    expect(await overrides()).toEqual({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://gw.example.com" });
    // The same address written differently is still the same place, and a typed key may go anywhere.
    await writeAccountApi(home, { keyKind: "api_key", key: null, baseUrl: "https://GW.example.com/", ...OFF, disableTelemetry: true });
    await writeAccountApi(home, { keyKind: "api_key", key: KEY, baseUrl: "https://other.example.com", ...OFF });
    expect(await overrides()).toEqual({ ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "https://other.example.com" });
  });

  it("switches between an API key and a bearer token without leaving the other behind", async () => {
    const { home, overrides } = await setUpHome("claude-kind");
    await writeAccountApi(home, { keyKind: "api_key", key: KEY, baseUrl: "https://gw.example.com", ...OFF });
    await writeAccountApi(home, { keyKind: "auth_token", key: null, baseUrl: "https://gw.example.com", ...OFF });
    expect(await overrides()).toEqual({ ANTHROPIC_AUTH_TOKEN: KEY, ANTHROPIC_BASE_URL: "https://gw.example.com" });
    expect((await readAccountApi(home))?.keyKind).toBe("auth_token");
  });

  it("keeps the account's proxy and other overrides", async () => {
    const { home, overrides } = await setUpHome("claude-mixed");
    await writeAccountProxy(home, "http://127.0.0.1:7890");
    await writeAccountApi(home, { keyKind: "auth_token", key: KEY, baseUrl: null, ...OFF });
    expect(await overrides()).toMatchObject({ ANTHROPIC_AUTH_TOKEN: KEY, HTTPS_PROXY: "http://127.0.0.1:7890" });
    expect(await readAccountProxy(home)).toBe("http://127.0.0.1:7890");
  });

  it("sends a key without a base URL to Anthropic's own API, not to main's gateway", async () => {
    const { home, overrides, generated } = await setUpHome("claude-official", CORPORATE);
    await writeAccountApi(home, { keyKind: "api_key", key: KEY, baseUrl: null, ...OFF });

    const settings = await generated();
    expect(settings.env).toEqual({ SHARED: "1", ...BLANKED, ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: KEY });
    expect(settings.apiKeyHelper).toBeUndefined();
    expect(settings.model).toBe("opus");
    // Only the generated file spells the endpoint out: the card still shows no base URL.
    expect(await overrides()).toEqual({ ANTHROPIC_API_KEY: KEY });
    expect((await readAccountApi(home))?.baseUrl).toBeNull();
  });

  it("sends a gateway's token alone: none of main's key, token, helper, headers or provider", async () => {
    const { home, generated } = await setUpHome("claude-third-party", CORPORATE);
    await writeAccountApi(home, { keyKind: "auth_token", key: KEY, baseUrl: "https://gw.example.com", ...OFF });

    const settings = await generated();
    expect(settings.env).toEqual({ SHARED: "1", ...BLANKED, ANTHROPIC_BASE_URL: "https://gw.example.com", ANTHROPIC_AUTH_TOKEN: KEY });
    expect(settings.apiKeyHelper).toBeUndefined();
  });

  it("keeps a saved key where it went when main's settings change later", async () => {
    const { home, generated, setMain } = await setUpHome("claude-later");
    await writeAccountApi(home, { keyKind: "api_key", key: KEY, baseUrl: null, ...OFF });
    const gateway = join(root, "homes", "claude-later-gw");
    await writeAccountApi(gateway, { keyKind: "auth_token", key: NEXT, baseUrl: "https://gw.example.com", ...OFF });

    await setMain(CORPORATE);
    await prepareClaudeHome(home, true);
    await prepareClaudeHome(gateway, true);
    expect((await generated()).env).toMatchObject({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: KEY, ANTHROPIC_AUTH_TOKEN: "" });
    const other = JSON.parse(await readFile(join(gateway, "settings.json"), "utf8"));
    expect(other.env).toMatchObject({ ANTHROPIC_BASE_URL: "https://gw.example.com", ANTHROPIC_AUTH_TOKEN: NEXT, ANTHROPIC_API_KEY: "" });

    // Saving without retyping the key is still the same place, so it's allowed and stays put.
    await writeAccountApi(home, { keyKind: "api_key", key: null, baseUrl: null, ...OFF, disableTelemetry: true });
    expect((await generated()).env).toMatchObject({ ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: KEY });
  });

  it("writes out every variable the daemon or a shell could otherwise slip in", async () => {
    // Claude Code applies settings `env` over the environment it starts with, so stating each one
    // in the account's settings is what beats an export in the daemon or in a launcher's shell.
    process.env.ANTHROPIC_BASE_URL = "https://shell-gateway.example";
    process.env.ANTHROPIC_API_KEY = "sk-ant-SHELL";
    process.env.ANTHROPIC_AUTH_TOKEN = "shell-token";
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "shell-oauth";
    const { home, generated } = await setUpHome("claude-shell");
    await writeAccountApi(home, { keyKind: "auth_token", key: KEY, baseUrl: null, ...OFF });
    expect((await generated()).env).toMatchObject({
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
      ANTHROPIC_AUTH_TOKEN: KEY,
      ANTHROPIC_API_KEY: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
    });
  });

  it("corrects an API account generated before the endpoint was pinned, without asking for the key", async () => {
    const { home, overrides, generated } = await setUpHome("claude-before", CORPORATE);
    // What an earlier version left behind: the account as entered, and main's gateway and key merged in.
    const entered = { env: { ANTHROPIC_API_KEY: KEY, DISABLE_TELEMETRY: "1" } };
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.account.json"), JSON.stringify(entered));
    await writeFile(join(home, "settings.json"), JSON.stringify(mergeSettings(CORPORATE, entered)));
    expect((await generated()).env.ANTHROPIC_BASE_URL).toBe("https://corp-gateway.example");

    await prepareClaudeHome(home, true);
    const settings = await generated();
    expect(settings.env).toEqual({ SHARED: "1", ...BLANKED, ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: KEY, DISABLE_TELEMETRY: "1" });
    expect(settings.apiKeyHelper).toBeUndefined();
    expect(await overrides()).toEqual(entered.env);
  });

  it("leaves a subscription account with main's settings plus its own, as before", async () => {
    const { home, generated } = await setUpHome("claude-subscription", CORPORATE);
    await writeAccountProxy(home, "http://127.0.0.1:7890");
    const own = JSON.parse(await readFile(join(home, "settings.account.json"), "utf8"));
    const merged = mergeSettings(CORPORATE, own);
    expect(await generated()).toEqual({ ...merged, env: { ...(merged.env as object), ...NO_PROXY_PINNED } });
    expect(await readAccountApi(home)).toBeNull();
  });

  it("refuses a missing key or a bad base URL without writing anything", async () => {
    const { home } = await setUpHome("claude-bad-api");
    await expect(writeAccountApi(home, { keyKind: "api_key", key: " ", baseUrl: null, ...OFF })).rejects.toThrow(/key/);
    await expect(writeAccountApi(home, { keyKind: "api_key", key: KEY, baseUrl: "ftp://gw", ...OFF })).rejects.toThrow(/http/);
    await expect(lstat(join(home, "settings.account.json"))).rejects.toThrow();
    expect(await readAccountApi(home)).toBeNull();
  });

  it("checks base URLs", () => {
    expect(normalizeBaseUrl(" https://GW.example.com:8443/anthropic// ")).toBe("https://gw.example.com:8443/anthropic");
    expect(normalizeBaseUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(() => normalizeBaseUrl("gw.example.com")).toThrow();
    expect(() => normalizeBaseUrl("https://user:pass@gw.example.com")).toThrow(/credentials/);
    expect(() => normalizeBaseUrl("https://gw.example.com/?key=1")).toThrow(/query/);
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

  it("isn't undone by a sync that was waiting for the home, once its account has gone", async () => {
    process.env.PASEO_HOME = root;
    const main = join(root, "main");
    const home = join(root, "zerosub", "homes", "claude-y");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(join(main, "projects"), { recursive: true });
    await prepareClaudeHome(home, true);

    let registered = true;
    const removing = removeHome(home);
    const syncing = prepareClaudeHome(home, true, async () => registered);
    registered = false; // the account went before the sync got to the home
    await Promise.all([removing, syncing]);

    expect(await lstat(home).catch(() => null)).toBeNull();
  });

  it("leaves a Codex home alone once its account has gone", async () => {
    const main = join(root, "codex-main");
    const home = join(root, "zerosub", "homes", "codex-y");
    process.env.CODEX_HOME = main;
    await mkdir(main, { recursive: true });
    await prepareCodexHome(home, true, async () => false);
    expect(await lstat(home).catch(() => null)).toBeNull();
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

describe("accountSettings", () => {
  it("pins an API account's endpoint under its own overrides and leaves other accounts to the plain merge", () => {
    const main = { apiKeyHelper: "main-helper", env: { A: "1", ANTHROPIC_BASE_URL: "https://corp.example" } };
    const proxy = { env: { HTTPS_PROXY: "http://127.0.0.1:7890" } };
    expect(accountSettings(main, { env: { DISABLE_TELEMETRY: "1" } })).toEqual(mergeSettings(main, { env: { DISABLE_TELEMETRY: "1" } }));
    expect(accountSettings(main, proxy)).toEqual({ ...main, env: { ...main.env, ...proxy.env, ...NO_PROXY_PINNED } });

    // The account's own values win, its own helper included; an empty base URL means Anthropic's.
    const own = accountSettings(main, { apiKeyHelper: "own-helper", env: { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: " ", ANTHROPIC_CUSTOM_HEADERS: "x-own: 1" } });
    expect(own.apiKeyHelper).toBe("own-helper");
    expect(own.env).toMatchObject({ A: "1", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "", ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_CUSTOM_HEADERS: "x-own: 1" });
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
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ env: { SHARED: "1" } });
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
  it("join permissions and hooks the way Claude Code does, and keep an API account's pinned env on top", () => {
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

    const api = accountSettings(main, { ...account, env: { ANTHROPIC_AUTH_TOKEN: "token" } });
    expect(api.permissions).toEqual(mergeSettings(main, account).permissions);
    expect(api.env).toMatchObject({ ANTHROPIC_AUTH_TOKEN: "token", ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "https://api.anthropic.com", SHARED: "1" });
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

describe("removeHome through a link", () => {
  it("leaves the folder a link in homes/ points at, and everything in it, alone", async () => {
    process.env.PASEO_HOME = root;
    const real = join(root, "claude-config", "claude-mine");
    const main = join(root, "main");
    await mkdir(join(main, "projects"), { recursive: true });
    await mkdir(real, { recursive: true });
    await writeFile(join(real, ".claude.json"), "{}");
    await symlink(join(main, "projects"), join(real, "projects"));
    await mkdir(join(root, "zerosub", "homes"), { recursive: true });
    const link = join(root, "zerosub", "homes", "claude-mine");
    await symlink(real, link);

    await removeHome(link);
    expect(await isLinkTo(link, real)).toBe(true);
    expect(await readFile(join(real, ".claude.json"), "utf8")).toBe("{}");
    expect(await isLinkTo(join(real, "projects"), join(main, "projects"))).toBe(true);
  });
});

describe("an API key's hint", () => {
  it("is left out for a short key", async () => {
    const home = join(root, "homes", "claude-short");
    process.env.CLAUDE_CONFIG_DIR = join(root, "main");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.account.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-12345678" } }));
    expect((await readAccountApi(home))?.keyHint).toBe("");
    await writeFile(join(home, "settings.account.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "sk-ant-api03-abcdefgh" } }));
    expect((await readAccountApi(home))?.keyHint).toBe("efgh");
  });
});
