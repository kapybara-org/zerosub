import { chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shownFamilies } from "../shared/model";
import type { FamilyAdapter } from "./adapter";
import { absentPi } from "./fakes.test-support";
import { familiesFromConfig, grokCommand, type FamilyResolver } from "./families";
import { GrokAdapter, GrokLogin, grokUsageProblem, parseGrokAuth, readGrokLogin } from "./grok";
import { grokPrivate, prepareGrokHome } from "./homes";
import { isOwnHome } from "./paths";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore, type StoredAccount } from "./state";

let root: string;
const KEYS = [
  "GROK_HOME",
  "GROK_AUTH_PATH",
  "GROK_AUTH",
  "XAI_API_KEY",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_AUTH_PROVIDER_ACCESS_TOKEN",
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
  "GROK_DEPLOYMENT_KEY",
  "GROK_CLI_CHAT_PROXY_BASE_URL",
  "PASEO_HOME",
] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-grok-")));
  process.env.PASEO_HOME = join(root, "paseo");
  for (const key of KEYS) if (key !== "PASEO_HOME") delete process.env[key];
});

afterEach(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** Paseo's catalog entry for Grok, as the app writes it into the daemon's config. */
const CATALOG = { extends: "acp", label: "Grok", command: ["grok", "agent", "stdio"], env: {} };

describe("recognising Grok providers", () => {
  it("maps Paseo's Grok entry, and Grok run by path, version or with options, to the grok family", () => {
    expect(familiesFromConfig({ grok: CATALOG })).toMatchObject({ grok: "grok", claude: "claude", codex: "codex", pi: "pi" });
    expect(
      familiesFromConfig({
        "grok-yolo": { extends: "acp", command: ["/home/me/.local/bin/grok", "agent", "--always-approve", "stdio"] },
        "grok-pinned": { extends: "acp", command: ["/home/me/.grok/bin/grok-1.0.77", "agent", "stdio"] },
      }),
    ).toMatchObject({ "grok-yolo": "grok", "grok-pinned": "grok" });
  });

  it("leaves other ACP agents, a shared leader, disabled entries and entries with their own login alone", () => {
    const families = familiesFromConfig({
      cursor: { extends: "acp", command: ["cursor-agent", "acp"] },
      grok: { extends: "acp", command: ["hermes", "acp"] },
      leader: { extends: "acp", command: ["grok", "agent", "--leader", "stdio"] },
      tui: { extends: "acp", command: ["grok"] },
      off: { ...CATALOG, enabled: false },
      keyed: { ...CATALOG, env: { XAI_API_KEY: "xai-test" } },
      homed: { ...CATALOG, env: { GROK_HOME: "/srv/grok" } },
      authed: { ...CATALOG, env: { GROK_AUTH_PATH: "/srv/grok/auth.json" } },
      oidc: { ...CATALOG, env: { GROK_OIDC_CLIENT_ID: "client" } },
      external: { ...CATALOG, env: { GROK_AUTH_PROVIDER_ACCESS_TOKEN: "token" } },
      blank: { ...CATALOG, env: { XAI_API_KEY: "" } },
    });
    for (const id of ["cursor", "grok", "leader", "tui", "off", "keyed", "homed", "authed", "oidc", "external"]) expect(families[id]).toBeUndefined();
    expect(families.blank).toBe("grok");
    expect(grokCommand(CATALOG)).toBe("grok");
    expect(grokCommand({ ...CATALOG, extends: undefined })).toBeNull();
  });
});

describe("prepareGrokHome", () => {
  it("shares sessions, config and skills but keeps the login and what Grok fetched for the account", async () => {
    const main = join(root, "grok");
    const home = join(root, "paseo", "zerosub", "homes", "grok-a");
    process.env.GROK_HOME = main;
    await mkdir(join(main, "skills"), { recursive: true });
    await mkdir(join(main, "logs"), { recursive: true });
    const own = ["auth.json", "auth.json.lock", "mcp_credentials.json", "settings_cache.json", "models_cache.json", "experiments_remote_opt_out", "managed_config.toml", "leader.sock"];
    for (const name of [...own, "config.toml", "agent_id", "worktrees.db"]) await writeFile(join(main, name), "x");
    await prepareGrokHome(home, true);

    const linked = async (name: string) => {
      const entry = await lstat(join(home, name)).catch(() => null);
      return Boolean(entry?.isSymbolicLink()) && (await readlink(join(home, name))) === join(main, name);
    };
    for (const name of ["config.toml", "sessions", "skills", "agent_id", "worktrees.db"]) expect(await linked(name), name).toBe(true);
    for (const name of [...own, "logs"]) expect(await lstat(join(home, name)).catch(() => null), name).toBeNull();
    // `sessions` is made in the CLI login's home, so a session written on any account is there for all.
    expect((await lstat(join(main, "sessions"))).isDirectory()).toBe(true);
  });

  it("keeps anything that looks like a login private, whatever Grok calls it later", () => {
    for (const name of ["auth-v2.json", "oauth_tokens.json", "client_secret", "leader.log", "x.pid", "a.tmp"]) expect(grokPrivate(name), name).toBe(true);
    for (const name of ["config.toml", "sessions", "memory-v2", "skills", "plugins", "bin"]) expect(grokPrivate(name), name).toBe(false);
  });

  it("never lets the CLI login's own home be deleted as an account's", async () => {
    process.env.GROK_HOME = join(root, "paseo", "zerosub", "homes", "grok-main");
    await mkdir(process.env.GROK_HOME, { recursive: true });
    expect(await isOwnHome(process.env.GROK_HOME)).toBe(false);
  });
});

describe("GrokAdapter.env", () => {
  it("gives an added account its home and auth file, and leaves the CLI login's as the daemon has them", async () => {
    const adapter = new GrokAdapter();
    expect(await adapter.env(null)).toEqual({ GROK_HOME: null, GROK_AUTH_PATH: null });
    expect(await adapter.env("/z/homes/grok-a")).toEqual({ GROK_HOME: "/z/homes/grok-a", GROK_AUTH_PATH: "/z/homes/grok-a/auth.json" });
  });

  it("blanks a login or API key the daemon's environment sets, so an added account never uses it", async () => {
    process.env.XAI_API_KEY = "xai-daemon";
    process.env.GROK_AUTH = "daemon-login";
    process.env.GROK_AUTH_PATH = "/shared/auth.json";
    process.env.GROK_AUTH_PROVIDER_COMMAND = "/usr/local/bin/company-auth";
    process.env.GROK_AUTH_PROVIDER_ACCESS_TOKEN = "provider-token";
    process.env.GROK_OIDC_ISSUER = "https://id.example";
    process.env.GROK_OIDC_CLIENT_ID = "client";
    process.env.GROK_DEPLOYMENT_KEY = "deployment";
    process.env.GROK_CLI_CHAT_PROXY_BASE_URL = "https://proxy.example/v1";
    const patch = await new GrokAdapter().env("/z/homes/grok-a");
    expect(patch).toMatchObject({
      XAI_API_KEY: "",
      GROK_AUTH: "",
      GROK_AUTH_PATH: "/z/homes/grok-a/auth.json",
      GROK_AUTH_PROVIDER_COMMAND: "",
      GROK_AUTH_PROVIDER_ACCESS_TOKEN: "",
      GROK_OIDC_ISSUER: "",
      GROK_OIDC_CLIENT_ID: "",
      GROK_DEPLOYMENT_KEY: "",
      GROK_CLI_CHAT_PROXY_BASE_URL: "",
    });
    expect(patch).not.toHaveProperty("GROK_CODE_XAI_API_KEY");
  });
});

/** A synthetic `auth.json` as Grok writes it: one entry per sign-in scope. */
function authFile(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    "https://auth.x.ai::client": {
      key: "synthetic-access",
      refresh_token: "synthetic-refresh",
      email: "Me@Example.com",
      user_id: "user-1",
      team_id: "team-1",
      ...fields,
    },
  };
}

describe("Grok identity", () => {
  it("reads who is signed in from the home's auth.json, never its login", async () => {
    const home = join(root, "grok-a");
    await mkdir(home, { recursive: true });
    const adapter = new GrokAdapter();
    expect(await adapter.identity(home)).toMatchObject({ signedIn: false, identity: null });
    await writeFile(join(home, "auth.json"), JSON.stringify(authFile({})));
    const identity = await adapter.identity(home);
    expect(identity).toEqual({ signedIn: true, email: "Me@Example.com", plan: null, organization: null, identity: "grok|team-1|user-1" });
    expect(JSON.stringify(identity)).not.toContain("synthetic");
  });

  it("reads the CLI login from GROK_HOME, or the file GROK_AUTH_PATH names", async () => {
    process.env.GROK_HOME = join(root, "grok");
    await mkdir(process.env.GROK_HOME, { recursive: true });
    await writeFile(join(process.env.GROK_HOME, "auth.json"), JSON.stringify(authFile({ user_id: "main" })));
    expect((await new GrokAdapter().identity(null)).identity).toBe("grok|team-1|main");
    process.env.GROK_AUTH_PATH = join(root, "elsewhere.json");
    await writeFile(process.env.GROK_AUTH_PATH, JSON.stringify(authFile({ user_id: "other" })));
    expect((await new GrokAdapter().identity(null)).identity).toBe("grok|team-1|other");
  });

  it("prefers Grok's own sign-in and needs a login in the entry", () => {
    expect(parseGrokAuth({ "https://idp.example::x": { key: "sso", user_id: "sso" }, ...authFile({ user_id: "grok" }) })?.identity).toBe("grok|team-1|grok");
    expect(parseGrokAuth(authFile({ team_id: undefined, user_id: undefined }))?.identity).toBe("grok|personal|me@example.com");
    expect(parseGrokAuth({ "https://auth.x.ai::client": { email: "a@b" } })).toBeNull();
    expect(parseGrokAuth({})).toBeNull();
  });

  it("refuses to call an unreadable auth.json signed out", async () => {
    const home = join(root, "grok-a");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "auth.json"), "{ half written");
    await expect(new GrokAdapter().identity(home)).rejects.toThrow();
  });
});

/** A stand-in `grok`, run by a Paseo provider the daemon's config names. */
async function fakeGrok(script: string): Promise<string> {
  const path = join(root, "bin", "grok");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
  await mkdir(join(root, "paseo"), { recursive: true });
  await writeFile(join(root, "paseo", "config.json"), JSON.stringify({ agents: { providers: { grok: { ...CATALOG, command: [path, "agent", "stdio"] } } } }));
  return path;
}

describe("Grok usage", () => {
  it("invokes `grok usage --json` with the account's home, but defers interpreting successful output", async () => {
    const seen = join(root, "seen");
    await fakeGrok(`echo "$* $GROK_HOME $GROK_AUTH_PATH" > ${seen}\necho '{"unverified":"output"}'`);
    const usage = await new GrokAdapter().usage("/z/homes/grok-a");
    expect((await readFile(seen, "utf8")).trim()).toBe("usage --json /z/homes/grok-a /z/homes/grok-a/auth.json");
    expect(usage).toMatchObject({ windows: [], error: expect.stringMatching(/format support awaits verification.*\/usage/i) });
  });

  it("reports usage as unavailable, with why, where `grok usage` can't read it", async () => {
    await fakeGrok("echo \"Error: \\`grok usage\\` can't show your plan's usage here yet. Run /usage inside grok instead.\" >&2; exit 1");
    expect(await new GrokAdapter().usage("/z/homes/grok-a")).toMatchObject({ windows: [], error: expect.stringMatching(/\/usage/) });
    await fakeGrok("echo 'Not signed in.' >&2; exit 1");
    expect((await new GrokAdapter().usage("/z/homes/grok-a")).error).toBe("Not signed in.");
    await fakeGrok("echo 'Usage limits are managed by your team.'");
    expect((await new GrokAdapter().usage("/z/homes/grok-a")).error).toBe("Usage limits are managed by your team.");
  });

  it("says when `grok usage` times out or fails without a word", () => {
    expect(grokUsageProblem({ code: null, stdout: "", stderr: "", timedOut: true })).toMatch(/in time/);
    expect(grokUsageProblem({ code: 2, stdout: "", stderr: "", timedOut: false })).toBe("`grok usage` failed (exit 2).");
  });
});

describe("Grok sign-in", () => {
  it("reads the device page and code `grok login --device-auth` prints, from the text or the link", () => {
    const printed = "To sign in, open this URL in your browser:\n\n  https://accounts.x.ai/oauth2/device?user_code=WXYZ-2345\n\nConfirm this code in your browser:\n\n  WXYZ-2345\n";
    expect(readGrokLogin(printed)).toEqual({ url: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-2345", userCode: "WXYZ-2345" });
    expect(readGrokLogin("  https://accounts.x.ai/oauth2/device\nConfirm this code in your browser:  ABCD-9876")?.userCode).toBe("ABCD-9876");
    expect(readGrokLogin("  https://accounts.x.ai/oauth2/device?user_code=QRST-1111")?.userCode).toBe("QRST-1111");
  });

  it("reads the browser link `grok login --oauth` prints, and nothing before it's there", () => {
    expect(readGrokLogin("Open this URL to sign in:\n  https://auth.x.ai/oauth2/authorize?response_type=code&state=s\n")).toEqual({
      url: "https://auth.x.ai/oauth2/authorize?response_type=code&state=s",
      userCode: null,
    });
    expect(readGrokLogin("Starting…\n")).toBeNull();
  });

  it("runs `grok login`, shows what it printed, and finishes when it exits", async () => {
    // The code only in bold text, not in the link.
    const command = await fakeGrok("printf '  https://accounts.x.ai/oauth2/device\\n\\n  \\033[1mWXYZ-2345\\033[0m\\n' >&2; sleep 0.3");
    const login = new GrokLogin(command, ["login", "--device-auth"], process.env);
    expect(await login.finished).toEqual({ ok: true, message: null });
    expect(login.progress).toMatchObject({ step: "waiting", userCode: "WXYZ-2345" });
    const failed = new GrokLogin(await fakeGrok("echo 'Error: access denied' >&2; exit 1"), ["login", "--oauth"], process.env);
    expect(await failed.finished).toEqual({ ok: false, message: "Error: access denied" });
  });
});

// --------------------------------------------------------------------------- the service with Grok

function grokAccount(id: string, kind: "main" | "managed"): StoredAccount {
  return {
    id,
    family: "grok",
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
    createdAt: new Date().toISOString(),
  };
}

/** Grok on a host that doesn't run it (no provider runs it, or the CLI isn't there). */
function missingGrok(): FamilyAdapter {
  return { ...absentPi(), family: "grok", portable: false };
}

/** Paseo with one idle Grok agent; `history`: it has a conversation already. */
function paseoWith(history: boolean) {
  const agent = { id: "agent-1", provider: "grok", status: "idle", lastUserMessageAt: history ? new Date().toISOString() : null, labels: {} };
  return {
    agents: {
      ref: () => ({ refresh: async () => ({ agent }) }),
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
    },
  };
}

async function grokService(accounts: StoredAccount[], grok?: FamilyAdapter): Promise<{ service: Service; store: StateStore }> {
  const store = new StateStore(join(root, "paseo", "zerosub", "state.json"));
  await store.update((draft) => {
    draft.accounts.push(...accounts);
  });
  const service = new Service(
    { claude: { ...absentPi(), family: "claude" }, codex: { ...absentPi(), family: "codex" }, pi: absentPi(), ...(grok ? { grok } : {}) },
    store,
    { resolve: async () => ({ grok: "grok" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  return { service, store };
}

describe("Grok is optional", () => {
  it("shows on the Accounts screen only once its CLI login is registered or an account of it was added", () => {
    expect(shownFamilies([])).toEqual(["claude", "codex"]);
    expect(shownFamilies([{ family: "grok" }])).toEqual(["claude", "codex", "grok"]);
    expect(shownFamilies([{ family: "pi" }, { family: "claude" }])).toEqual(["claude", "codex", "pi"]);
  });

  it("isn't missed where it isn't there, until a Grok account was added", async () => {
    const notInstalled = expect.arrayContaining([expect.stringContaining("Grok isn't installed")]);
    // Grok missing, and a service given no Grok adapter at all.
    for (const grok of [missingGrok(), undefined]) {
      const { service } = await grokService([], grok);
      await service.start();
      const view = await service.view(paseoWith(false) as never);
      expect(view.warnings).not.toEqual(notInstalled);
      expect(view.accounts.some((account) => account.family === "grok")).toBe(false);
      await service.stop();
      await rm(join(root, "paseo"), { recursive: true, force: true });
    }
    const { service } = await grokService([grokAccount("grok-a", "managed")], missingGrok());
    await service.start();
    expect((await service.view(paseoWith(false) as never)).warnings).toEqual(notInstalled);
    await service.stop();
  });

  it("loads a registry written before Grok as it is", async () => {
    const path = join(root, "state.json");
    await writeFile(path, JSON.stringify({ version: 1, defaults: { claude: null, codex: null, pi: null }, nextAgent: { claude: null, codex: null, pi: null } }));
    const state = await new StateStore(path).read();
    expect(state.defaults).toEqual({ claude: null, codex: null, pi: null });
    expect(state.nextAgent).toEqual({ claude: null, codex: null, pi: null });
  });
});

describe("a Grok conversation stays on its account", () => {
  it("refuses another account for an agent with history, without starting a new agent", async () => {
    const { service, store } = await grokService([grokAccount("grok-main", "main"), grokAccount("grok-a", "managed")], {
      ...missingGrok(),
      available: async () => ({ ok: true, detail: null }),
    });
    await expect(service.setAgentAccount(paseoWith(true) as never, "agent-1", "grok-a")).rejects.toThrow(
      /stay on the account they started on \(grok-main\)/,
    );
    expect((await store.read()).bindings).toEqual({});
    await expect(service.remove(paseoWith(true) as never, "grok-main")).rejects.toThrow(/`grok logout`/);
  });

  it("isn't moved in place, and nothing moves it at a limit or sign-out yet", () => {
    const adapter = new GrokAdapter();
    expect(adapter.portable).toBe(false);
    expect(adapter.detectLimit()).toBeNull();
    expect(adapter.detectSignOut()).toBeNull();
  });
});
