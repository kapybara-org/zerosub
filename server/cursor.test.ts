import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shownFamilies } from "../shared/model";
import type { FamilyAdapter } from "./adapter";
import { cursorBinary } from "./binaries";
import { CURSOR_UNSUPPORTED, CursorAdapter, CursorLogin, parseCursorStatus, readCursorLogin } from "./cursor";
import { absentPi } from "./fakes.test-support";
import { acpCommand, familiesFromConfig, type FamilyResolver } from "./families";
import { prepareCursorHome, removeHome } from "./homes";
import { isOwnHome } from "./paths";
import { run } from "./process";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore, type StoredAccount } from "./state";

let root: string;
const KEYS = ["HOME", "XDG_CONFIG_HOME", "CURSOR_CONFIG_DIR", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "CURSOR_API_ENDPOINT", "PASEO_HOME"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-cursor-")));
  process.env.PASEO_HOME = join(root, "paseo");
  // The daemon's home folder, so ~/.config and ~/.cursor are the test's own.
  process.env.HOME = join(root, "me");
  for (const key of KEYS) if (key !== "PASEO_HOME" && key !== "HOME") delete process.env[key];
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** Paseo's catalog entry for Cursor, as the app writes it into the daemon's config. */
const CATALOG = { extends: "acp", label: "Cursor", command: ["cursor-agent", "acp"], env: {} };

describe("recognising Cursor providers", () => {
  it("maps Paseo's Cursor entry, and cursor-agent run by path or with options, to the cursor family", () => {
    expect(familiesFromConfig({ cursor: CATALOG })).toMatchObject({ cursor: "cursor", claude: "claude", codex: "codex", pi: "pi" });
    expect(
      familiesFromConfig({
        "cursor-local": { extends: "acp", command: ["/home/me/.local/bin/cursor-agent", "--trust", "acp"] },
        "cursor-model": { extends: "acp", command: ["cursor-agent", "acp", "--model", "auto"] },
      }),
    ).toMatchObject({ "cursor-local": "cursor", "cursor-model": "cursor" });
    // Nothing is Cursor without a provider that runs it.
    expect(familiesFromConfig({})).not.toHaveProperty("cursor");
    expect(acpCommand("cursor", CATALOG)).toBe("cursor-agent");
  });

  it("leaves the bare `agent` alias, other ACP agents, disabled entries and entries with their own login, key or endpoint alone", () => {
    const families = familiesFromConfig({
      alias: { extends: "acp", command: ["agent", "acp"] },
      aliasPath: { extends: "acp", command: ["/home/me/.local/bin/agent", "acp"] },
      windows: { extends: "acp", command: ["cursor-agent.cmd", "acp"] },
      grokish: { extends: "acp", command: ["grok", "agent", "stdio"] },
      cursor: { extends: "acp", command: ["hermes", "acp"] },
      tui: { extends: "acp", command: ["cursor-agent"] },
      plain: { command: ["cursor-agent", "acp"] },
      off: { ...CATALOG, enabled: false },
      flagKey: { ...CATALOG, command: ["cursor-agent", "--api-key", "key_test", "acp"] },
      flagEndpoint: { ...CATALOG, command: ["cursor-agent", "-e", "https://api.example", "acp"] },
      flagEndpointEq: { ...CATALOG, command: ["cursor-agent", "--endpoint=https://api.example", "acp"] },
      keyed: { ...CATALOG, env: { CURSOR_API_KEY: "key_test" } },
      token: { ...CATALOG, env: { CURSOR_AUTH_TOKEN: "token" } },
      endpoint: { ...CATALOG, env: { CURSOR_API_ENDPOINT: "https://api.example" } },
      xdg: { ...CATALOG, env: { XDG_CONFIG_HOME: "/srv/xdg" } },
      config: { ...CATALOG, env: { CURSOR_CONFIG_DIR: "/srv/cursor" } },
      blank: { ...CATALOG, env: { CURSOR_API_KEY: "" } },
    });
    const left = ["alias", "aliasPath", "windows", "cursor", "tui", "plain", "off", "flagKey", "flagEndpoint", "flagEndpointEq", "keyed", "token", "endpoint", "xdg", "config"];
    for (const id of left) expect(families[id], id).toBeUndefined();
    expect(families.grokish).toBe("grok");
    expect(families.blank).toBe("cursor");
    expect(acpCommand("cursor", { ...CATALOG, extends: undefined })).toBeNull();
    // One table for both: Grok's command isn't Cursor's, nor the other way round.
    expect(acpCommand("cursor", { extends: "acp", command: ["grok", "agent", "stdio"] })).toBeNull();
    expect(acpCommand("grok", CATALOG)).toBeNull();
    expect(acpCommand("claude", { extends: "acp", command: ["claude", "acp"] })).toBeNull();
  });

  it("finds the binary of the provider that runs Cursor, preferring the one called cursor", async () => {
    await mkdir(join(root, "paseo"), { recursive: true });
    await writeFile(
      join(root, "paseo", "config.json"),
      JSON.stringify({ agents: { providers: { other: { ...CATALOG, command: ["/opt/other/cursor-agent", "acp"] }, cursor: { ...CATALOG, command: ["/opt/cursor-agent", "acp"] } } } }),
    );
    expect(await cursorBinary()).toBe("/opt/cursor-agent");
  });
});

// --------------------------------------------------------------------------- homes

/**
 * The daemon's own folders, with `XDG_CONFIG_HOME` and `CURSOR_CONFIG_DIR` unset: `~/.config` with
 * other tools' settings and the CLI login's `cursor/auth.json`, and `~/.cursor`.
 */
async function mainFolders(): Promise<{ config: string; dotCursor: string }> {
  const config = join(root, "me", ".config");
  const dotCursor = join(root, "me", ".cursor");
  await mkdir(join(config, "git"), { recursive: true });
  await writeFile(join(config, "git", "config"), "[user]\n\tname = Shared Settings\n");
  await mkdir(join(config, "gh"), { recursive: true });
  await writeFile(join(config, "mimeapps.list"), "x");
  await mkdir(join(config, "cursor"), { recursive: true });
  await writeFile(join(config, "cursor", "auth.json"), JSON.stringify({ accessToken: "synthetic-main", refreshToken: "synthetic-main" }));
  for (const name of ["projects", "skills-cursor"]) await mkdir(join(dotCursor, name), { recursive: true });
  await writeFile(
    join(dotCursor, "cli-config.json"),
    JSON.stringify({
      version: 1,
      permissions: { allow: ["Shell(ls)"], deny: [] },
      model: { modelId: "auto" },
      approvalMode: "allowlist",
      authInfo: { email: "main@example.com", userId: 1, teamId: 2, activeTeamId: 2 },
      privacyCache: { ghostMode: true, privacyMode: 2, updatedAt: 1 },
    }),
  );
  for (const name of ["statsig-cache.json", "acp-config.json", "hooks.json", "cli-config.json.123.abc.tmp"]) await writeFile(join(dotCursor, name), "{}");
  return { config, dotCursor };
}

const linkedTo = async (path: string, target: string) => {
  const entry = await lstat(path).catch(() => null);
  return Boolean(entry?.isSymbolicLink()) && (await readlink(path)) === target;
};

const missing = async (path: string) => (await lstat(path).catch(() => null)) === null;

describe("prepareCursorHome", () => {
  it("mirrors ~/.config except cursor/, which mirrors ~/.cursor except the account's login, cli-config.json and flag cache", async () => {
    const { config, dotCursor } = await mainFolders();
    const home = join(root, "paseo", "zerosub", "homes", "cursor-a");
    await prepareCursorHome(home, true);

    // The account's XDG_CONFIG_HOME: other tools' settings are the real ones.
    for (const name of ["git", "gh", "mimeapps.list"]) expect(await linkedTo(join(home, name), join(config, name)), name).toBe(true);
    // Its `cursor/` is its own folder, without the CLI login's auth.json…
    const own = await lstat(join(home, "cursor"));
    expect(own.isDirectory() && !own.isSymbolicLink()).toBe(true);
    expect(await missing(join(home, "cursor", "auth.json"))).toBe(true);
    // …linking ~/.cursor's entries back (chats and ACP sessions shared, made up front)…
    for (const name of ["acp-sessions", "chats", "projects", "skills-cursor", "acp-config.json", "hooks.json"]) {
      expect(await linkedTo(join(home, "cursor", name), join(dotCursor, name)), name).toBe(true);
    }
    // …except what's the account's.
    for (const name of ["statsig-cache.json", "cli-config.json.123.abc.tmp"]) expect(await missing(join(home, "cursor", name)), name).toBe(true);
    const settings = await lstat(join(home, "cursor", "cli-config.json"));
    expect(settings.isFile() && !settings.isSymbolicLink()).toBe(true);
    const seeded = JSON.parse(await readFile(join(home, "cursor", "cli-config.json"), "utf8")) as Record<string, unknown>;
    expect(seeded).toEqual({ version: 1, permissions: { allow: ["Shell(ls)"], deny: [] }, model: { modelId: "auto" }, approvalMode: "allowlist" });

    // Nothing of the CLI login's was changed, and ~/.config got nothing new.
    expect(JSON.parse(await readFile(join(config, "cursor", "auth.json"), "utf8"))).toMatchObject({ accessToken: "synthetic-main" });
    expect((await readdir(config)).sort()).toEqual(["cursor", "gh", "git", "mimeapps.list"]);
    expect((await readdir(join(config, "cursor"))).sort()).toEqual(["auth.json"]);

    // Removing the account leaves the folders it mirrored as they were.
    await removeHome(home);
    expect(await missing(home)).toBe(true);
    expect((await readdir(config)).sort()).toEqual(["cursor", "gh", "git", "mimeapps.list"]);
    expect((await readdir(dotCursor)).sort()).toContain("chats");
  });

  it("mirrors the daemon's own XDG_CONFIG_HOME, whose cursor/ is then Cursor's settings folder too", async () => {
    const xdg = join(root, "xdg");
    process.env.XDG_CONFIG_HOME = xdg;
    await mkdir(join(xdg, "cursor", "acp-sessions"), { recursive: true });
    await mkdir(join(xdg, "git"), { recursive: true });
    await writeFile(join(xdg, "cursor", "auth.json"), "{}");
    await writeFile(join(xdg, "cursor", "cli-config.json"), JSON.stringify({ model: { modelId: "auto" }, authInfo: { userId: 1 } }));
    await writeFile(join(xdg, "cursor", "permissions.json"), "{}");
    const home = join(root, "paseo", "zerosub", "homes", "cursor-a");
    await prepareCursorHome(home, true);
    expect(await linkedTo(join(home, "git"), join(xdg, "git"))).toBe(true);
    expect(await linkedTo(join(home, "cursor", "permissions.json"), join(xdg, "cursor", "permissions.json"))).toBe(true);
    expect(await linkedTo(join(home, "cursor", "acp-sessions"), join(xdg, "cursor", "acp-sessions"))).toBe(true);
    expect(await missing(join(home, "cursor", "auth.json"))).toBe(true);
    expect(JSON.parse(await readFile(join(home, "cursor", "cli-config.json"), "utf8"))).toEqual({ model: { modelId: "auto" } });
    // The home folder's ~/.config and ~/.cursor play no part.
    expect(await missing(join(root, "me"))).toBe(true);
  });

  it("lets a tool the agent runs read its usual settings through the account's XDG_CONFIG_HOME", async () => {
    await mainFolders();
    const home = join(root, "paseo", "zerosub", "homes", "cursor-a");
    await prepareCursorHome(home, true);
    const patch = await new CursorAdapter("linux").env(home);
    // cursor-agent hands its tools its own environment as it is, so this is what git sees there.
    const result = await run("git", ["config", "--global", "--get", "user.name"], {
      env: { PATH: process.env.PATH, HOME: join(root, "me"), XDG_CONFIG_HOME: patch.XDG_CONFIG_HOME ?? undefined },
    });
    expect(result.stdout.trim()).toBe("Shared Settings");
  });

  it("keeps a later account's own cli-config.json", async () => {
    const home = join(root, "paseo", "zerosub", "homes", "cursor-a");
    await prepareCursorHome(home, true);
    await writeFile(join(home, "cursor", "cli-config.json"), JSON.stringify({ model: { modelId: "mine" } }));
    await mainFolders();
    await prepareCursorHome(home, true);
    expect(JSON.parse(await readFile(join(home, "cursor", "cli-config.json"), "utf8"))).toEqual({ model: { modelId: "mine" } });
    expect(await linkedTo(join(home, "git"), join(root, "me", ".config", "git"))).toBe(true);
  });

  it("never lets a folder holding what Cursor accounts mirror be deleted as an account's", async () => {
    process.env.CURSOR_CONFIG_DIR = join(root, "paseo", "zerosub", "homes", "cursor-main", "settings");
    await mkdir(process.env.CURSOR_CONFIG_DIR, { recursive: true });
    expect(await isOwnHome(join(root, "paseo", "zerosub", "homes", "cursor-main"))).toBe(false);
    expect(await isOwnHome(join(root, "paseo", "zerosub", "homes", "cursor-other"))).toBe(true);
    process.env.CURSOR_CONFIG_DIR = join(root, "elsewhere");
    process.env.XDG_CONFIG_HOME = join(root, "paseo", "zerosub", "homes", "cursor-xdg");
    expect(await isOwnHome(join(root, "paseo", "zerosub", "homes", "cursor-xdg"))).toBe(false);
  });
});

// --------------------------------------------------------------------------- env and platforms

describe("CursorAdapter.env", () => {
  it("makes an added account's home its XDG_CONFIG_HOME, and leaves the CLI login's as the daemon has it", async () => {
    const adapter = new CursorAdapter("linux");
    expect(await adapter.env(null)).toEqual({ XDG_CONFIG_HOME: null });
    expect(await adapter.env("/z/homes/cursor-a")).toEqual({ XDG_CONFIG_HOME: "/z/homes/cursor-a" });
  });

  it("blanks a key, token or settings folder the daemon's environment sets, so an added account never uses or saves it", async () => {
    process.env.CURSOR_API_KEY = "key_daemon";
    process.env.CURSOR_AUTH_TOKEN = "token_daemon";
    process.env.CURSOR_CONFIG_DIR = "/srv/cursor";
    process.env.CURSOR_API_ENDPOINT = "https://api.example";
    const patch = await new CursorAdapter("linux").env("/z/homes/cursor-a");
    expect(patch).toEqual({ XDG_CONFIG_HOME: "/z/homes/cursor-a", CURSOR_API_KEY: "", CURSOR_AUTH_TOKEN: "", CURSOR_CONFIG_DIR: "" });
    // Another endpoint is where every account signs in, not a login.
    expect(await new CursorAdapter("linux").env(null)).toEqual({ XDG_CONFIG_HOME: null });
  });
});

describe("Cursor outside Linux", () => {
  for (const platform of ["darwin", "win32"] as const) {
    it(`is unavailable on ${platform}, says why, and makes no account folder`, async () => {
      const adapter = new CursorAdapter(platform);
      const ran = join(root, "ran");
      await fakeCursor(`touch ${ran}`);
      expect(await adapter.available()).toEqual({ ok: false, detail: CURSOR_UNSUPPORTED[platform] });
      expect(CURSOR_UNSUPPORTED[platform]).toMatch(platform === "darwin" ? /HOME/ : /APPDATA/);
      expect(await adapter.env(null)).toEqual({});
      expect(await adapter.env(join(root, "h"))).toEqual({});
      await expect(adapter.prepareHome(join(root, "h"))).rejects.toThrow(/Linux only/);
      await expect(adapter.login(join(root, "h"))).rejects.toThrow(/Linux only/);
      expect(await missing(join(root, "h"))).toBe(true);
      expect(await missing(ran)).toBe(true);
    });

    it(`never checks or signs out an added account on ${platform}, where cursor-agent would reach the CLI login`, async () => {
      const ran = join(root, "ran");
      await fakeCursor(`echo "$*" >> ${ran}\necho '${statusJson({ email: "main@example.com", userId: 1 })}'`);
      const adapter = new CursorAdapter(platform);
      await expect(adapter.identity(join(root, "h"))).rejects.toThrow(CURSOR_UNSUPPORTED[platform]);
      await expect(adapter.logout(join(root, "h"))).rejects.toThrow(CURSOR_UNSUPPORTED[platform]);
      expect(await missing(ran)).toBe(true);
      // The CLI login is still checked as the daemon has it.
      expect((await adapter.identity(null)).identity).toBe("cursor|personal|1");
      expect((await readFile(ran, "utf8")).trim()).toBe("status --format json");
    });
  }

  it("is available on Linux once a provider runs cursor-agent", async () => {
    await fakeCursor("echo 2026.11.13");
    expect(await new CursorAdapter("linux").available()).toEqual({ ok: true, detail: null });
  });
});

// --------------------------------------------------------------------------- identity, sign-in, usage

/** `cursor-agent status --format json` as 2026.11.13 prints it (synthetic values). */
function statusJson(userInfo: Record<string, unknown> | undefined, isAuthenticated = true): string {
  return JSON.stringify(
    isAuthenticated
      ? { status: "authenticated", isAuthenticated, hasAccessToken: true, hasRefreshToken: true, ...(userInfo ? { userInfo } : { message: "Logged in (unable to fetch user details)" }) }
      : { status: "unauthenticated", isAuthenticated, hasAccessToken: false, hasRefreshToken: false, message: "Not logged in" },
    null,
    2,
  );
}

describe("Cursor identity", () => {
  it("reads who is signed in from `status --format json`", () => {
    expect(parseCursorStatus(statusJson({ email: "Me@Example.com", userId: 123, teamId: 456, teamName: "Team" }))).toEqual({
      signedIn: true,
      email: "Me@Example.com",
      plan: null,
      organization: "Team",
      identity: "cursor|456|123",
    });
    expect(parseCursorStatus(statusJson({ email: "Me@Example.com" })).identity).toBe("cursor|personal|me@example.com");
    expect(parseCursorStatus(statusJson({ userId: 7, teamId: 0 })).identity).toBe("cursor|personal|7");
  });

  it("is signed in without knowing as whom when Cursor couldn't say, and signed out when it says so", () => {
    expect(parseCursorStatus(statusJson(undefined))).toMatchObject({ signedIn: true, identity: null });
    expect(parseCursorStatus(statusJson(undefined, false))).toEqual({ signedIn: false, email: null, plan: null, organization: null, identity: null });
    expect(parseCursorStatus(JSON.stringify({ status: "partially-authenticated", isAuthenticated: false }))).toMatchObject({ signedIn: false });
  });

  it("refuses to call output it can't read signed out", () => {
    expect(() => parseCursorStatus("Not logged in")).toThrow();
    expect(() => parseCursorStatus(JSON.stringify({ status: "authenticated" }))).toThrow();
  });

  it("runs status with the account's folders, and treats a failed run as unknown, not signed out", async () => {
    const seen = join(root, "seen");
    await fakeCursor(`echo "$* $XDG_CONFIG_HOME" > ${seen}\necho '${statusJson({ email: "a@b.c", userId: 9 })}'`);
    expect((await new CursorAdapter("linux").identity("/z/homes/cursor-a")).identity).toBe("cursor|personal|9");
    expect((await readFile(seen, "utf8")).trim()).toBe("status --format json /z/homes/cursor-a");
    await fakeCursor("echo 'network down' >&2; exit 1");
    await expect(new CursorAdapter("linux").identity("/z/homes/cursor-a")).rejects.toThrow("network down");
  });
});

/** A stand-in `cursor-agent`, run by a Paseo provider the daemon's config names. */
async function fakeCursor(script: string): Promise<string> {
  const path = join(root, "bin", "cursor-agent");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  await mkdir(join(root, "paseo"), { recursive: true });
  await writeFile(join(root, "paseo", "config.json"), JSON.stringify({ agents: { providers: { cursor: { ...CATALOG, command: [path, "acp"] } } } }));
  return path;
}

/** What `cursor-agent login` 2026.11.13 prints with NO_OPEN_BROWSER (the link's values are synthetic). */
const LINK = "https://cursor.com/loginDeepControl?challenge=synthetic&uuid=00000000-0000-4000-8000-000000000000&mode=login&redirectTarget=cli&supportsSelectedTeamLogin=true";
const PRINTED = `Starting login process...\nAuthenticating with Cursor...\nWaiting for browser authentication...\nOpen a browser and navigate to this link: ${LINK}\n`;

describe("Cursor sign-in", () => {
  it("reads the link `cursor-agent login` prints, and nothing before it's there", () => {
    expect(readCursorLogin(PRINTED)).toEqual({ url: LINK, userCode: null });
    expect(readCursorLogin("Starting login process...\n")).toBeNull();
    expect(readCursorLogin("see https://example.com/loginDeepControl?x=1\n")).toBeNull();
  });

  it("runs `cursor-agent login` without opening a browser, shows the link, and finishes when it exits", async () => {
    const seen = join(root, "seen");
    await fakeCursor(`echo "$* $NO_OPEN_BROWSER $XDG_CONFIG_HOME" > ${seen}\nprintf '${PRINTED.replace(/\n/g, "\\n")}'\nsleep 0.3`);
    const login = await new CursorAdapter("linux").login("/z/homes/cursor-a");
    expect(await login.finished).toEqual({ ok: true, message: null });
    expect(login.progress).toMatchObject({ step: "waiting", url: LINK, userCode: null });
    expect((await readFile(seen, "utf8")).trim()).toBe("login 1 /z/homes/cursor-a");
    await expect(login.submitCode("x")).rejects.toThrow(/pasted code/);

    const failed = new CursorLogin(await fakeCursor("echo 'Error: login timed out' >&2; exit 1"), ["login"], process.env);
    expect(await failed.finished).toEqual({ ok: false, message: "Error: login timed out" });
  });
});

describe("Cursor usage", () => {
  it("stays unavailable, without running anything or calling Cursor", async () => {
    const ran = join(root, "ran");
    await fakeCursor(`touch ${ran}`);
    const usage = await new CursorAdapter("linux").usage();
    expect(usage).toMatchObject({ windows: [], resets: null, error: expect.stringMatching(/no command that shows plan usage/) });
    expect(await lstat(ran).catch(() => null)).toBeNull();
    expect((await new CursorAdapter("linux").redeemReset()).outcome).toBe("none");
  });
});

// --------------------------------------------------------------------------- the service with Cursor

function cursorAccount(id: string, kind: "main" | "managed"): StoredAccount {
  return {
    id,
    family: "cursor",
    label: id,
    autoLabel: false,
    kind,
    auth: "subscription",
    home: kind === "main" ? null : join(root, "paseo", "zerosub", "homes", id),
    email: null,
    plan: null,
    organization: null,
    identity: id,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    modelLimits: {},
    createdAt: new Date().toISOString(),
  };
}

/** Cursor on a host that doesn't run it (no provider runs it, or the CLI isn't there). */
function missingCursor(): FamilyAdapter {
  return { ...absentPi(), family: "cursor", portable: false };
}

/** Paseo with one idle Cursor agent; `history`: it has a conversation already. */
function paseoWith(history: boolean) {
  const agent = { id: "agent-1", provider: "cursor", status: "idle", lastUserMessageAt: history ? new Date().toISOString() : null, labels: {} };
  return {
    agents: {
      ref: () => ({ refresh: async () => ({ agent }) }),
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
    },
  };
}

async function cursorService(accounts: StoredAccount[], cursor?: FamilyAdapter): Promise<{ service: Service; store: StateStore }> {
  const store = new StateStore(join(root, "paseo", "zerosub", "state.json"));
  await store.update((draft) => {
    draft.accounts.push(...accounts);
  });
  const service = new Service(
    { claude: { ...absentPi(), family: "claude" }, codex: { ...absentPi(), family: "codex" }, pi: absentPi(), ...(cursor ? { cursor } : {}) },
    store,
    { resolve: async () => ({ cursor: "cursor" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  return { service, store };
}

describe("Cursor is optional", () => {
  it("shows on the Accounts screen only once its CLI login is registered or an account of it was added", () => {
    expect(shownFamilies([])).toEqual(["claude", "codex"]);
    expect(shownFamilies([{ family: "cursor" }])).toEqual(["claude", "codex", "cursor"]);
  });

  it("isn't missed where it isn't there, until a Cursor account was added", async () => {
    const notInstalled = expect.arrayContaining([expect.stringContaining("Cursor isn't installed")]);
    for (const cursor of [missingCursor(), undefined]) {
      const { service } = await cursorService([], cursor);
      await service.start();
      const view = await service.view(paseoWith(false) as never);
      expect(view.warnings).not.toEqual(notInstalled);
      expect(view.accounts.some((account) => account.family === "cursor")).toBe(false);
      await service.stop();
      await rm(join(root, "paseo"), { recursive: true, force: true });
    }
    const { service } = await cursorService([cursorAccount("cursor-a", "managed")], missingCursor());
    await service.start();
    expect((await service.view(paseoWith(false) as never)).warnings).toEqual(notInstalled);
    await service.stop();
  });

  it("loads a registry written before Cursor as it is", async () => {
    const path = join(root, "state.json");
    await writeFile(path, JSON.stringify({ version: 1, defaults: { claude: null, codex: null, pi: null, grok: null }, nextAgent: { claude: null, codex: null, pi: null } }));
    const state = await new StateStore(path).read();
    expect(state.defaults).toEqual({ claude: null, codex: null, pi: null, grok: null });
  });
});

describe("Cursor accounts and the daemon's environment", () => {
  it("warns that a key or token in it is only for the CLI login, once Cursor is on the Accounts screen", async () => {
    process.env.CURSOR_API_KEY = "key_daemon";
    const warning = expect.arrayContaining([expect.stringContaining("sets CURSOR_API_KEY")]);
    const { service } = await cursorService([], missingCursor());
    await service.start();
    expect((await service.view(paseoWith(false) as never)).warnings).not.toEqual(warning);
    await service.stop();
    await rm(join(root, "paseo"), { recursive: true, force: true });
    const shown = await cursorService([cursorAccount("cursor-main", "main")], missingCursor());
    await shown.service.start();
    expect((await shown.service.view(paseoWith(false) as never)).warnings).toEqual(warning);
    await shown.service.stop();
  });
});

describe("Cursor on macOS and Windows", () => {
  it("never shows on the Accounts screen or starts a sign-in, and isn't missed", async () => {
    await fakeCursor("echo 2026.11.13");
    for (const platform of ["darwin", "win32"] as const) {
      const { service, store } = await cursorService([], new CursorAdapter(platform));
      await service.start();
      const view = await service.view(paseoWith(false) as never);
      expect(view.accounts.some((account) => account.family === "cursor")).toBe(false);
      expect(view.warnings.some((warning) => warning.includes("Cursor"))).toBe(false);
      await expect(service.startLogin("cursor", "browser")).rejects.toThrow();
      expect((await store.read()).accounts).toEqual([]);
      await service.stop();
      await rm(join(root, "paseo", "zerosub"), { recursive: true, force: true });
    }
  });

  it("cleans up a Linux registry's homes without running cursor-agent, so the CLI login is never signed out", async () => {
    const { config, dotCursor } = await mainFolders();
    const ran = join(root, "ran");
    await fakeCursor(`echo "$*" >> ${ran}\necho '${statusJson({ email: "main@example.com", userId: 1 })}'`);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);
    for (const platform of ["darwin", "win32"] as const) {
      // A removed account's home, and one an earlier run's sign-in left unfinished.
      const removed = join(root, "paseo", "zerosub", "homes", "cursor-a");
      const unfinished = join(root, "paseo", "zerosub", "homes", "cursor-b");
      for (const home of [removed, unfinished]) await prepareCursorHome(home, true);
      const { service, store } = await cursorService([], new CursorAdapter(platform));
      await store.update((draft) => {
        draft.cleanup[removed] = { family: "cursor", accountId: "cursor-a", why: "removed", at: new Date().toISOString() };
        draft.cleanup[unfinished] = { family: "cursor", accountId: "cursor-b", why: "unfinished", at: new Date().toISOString() };
      });
      await service.cleanUpHomes(paseoWith(false) as never);
      // Both stay listed, and in place, for a later pass…
      expect(Object.keys((await store.read()).cleanup).sort()).toEqual([removed, unfinished]);
      expect(await missing(removed)).toBe(false);
      for (const home of [removed, unfinished]) expect(errors).toHaveBeenCalledWith(`[ZeroSub] cleaning up ${home} failed`, CURSOR_UNSUPPORTED[platform]);
      // …until cleanup gives up, as on a sign-out that keeps failing: the removed account's home goes, the other stays.
      await service.cleanUpHomes(paseoWith(false) as never);
      await service.cleanUpHomes(paseoWith(false) as never);
      expect((await store.read()).cleanup).toEqual({});
      expect(await missing(removed)).toBe(true);
      expect(await missing(unfinished)).toBe(false);
      await service.stop();
      await rm(join(root, "paseo", "zerosub"), { recursive: true, force: true });
    }
    // cursor-agent never ran, and the CLI login's folders are as they were.
    expect(await missing(ran)).toBe(true);
    expect(JSON.parse(await readFile(join(config, "cursor", "auth.json"), "utf8"))).toMatchObject({ accessToken: "synthetic-main" });
    expect((await readdir(config)).sort()).toEqual(["cursor", "gh", "git", "mimeapps.list"]);
    expect(await readdir(dotCursor)).toContain("chats");
    errors.mockRestore();
    logged.mockRestore();
  });
});

describe("a Cursor conversation stays on its account", () => {
  it("refuses another account for an agent with history, without starting a new agent", async () => {
    const { service, store } = await cursorService([cursorAccount("cursor-main", "main"), cursorAccount("cursor-a", "managed")], {
      ...missingCursor(),
      available: async () => ({ ok: true, detail: null }),
    });
    await expect(service.setAgentAccount(paseoWith(true) as never, "agent-1", "cursor-a")).rejects.toThrow(/stay on the account they started on \(cursor-main\)/);
    expect((await store.read()).bindings).toEqual({});
    await expect(service.remove(paseoWith(true) as never, "cursor-main")).rejects.toThrow(/`cursor-agent logout`/);
  });

  it("isn't moved in place, and nothing moves it at a limit or sign-out yet", () => {
    const adapter = new CursorAdapter("linux");
    expect(adapter.portable).toBe(false);
    expect(adapter.detectLimit()).toBeNull();
    expect(adapter.detectSignOut()).toBeNull();
  });
});
