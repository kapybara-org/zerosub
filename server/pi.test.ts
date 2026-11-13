import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEnv, type FamilyAdapter, type TurnEvent } from "./adapter";
import { absentPi } from "./fakes.test-support";
import { familiesFromConfig, type FamilyResolver } from "./families";
import { crossesInheritedProxy, piAuth, piLiteral, piModels, preparePiHome, readPiAccount, readPiAccountApi, sentInTheClear, writePiAccountApi, writePiAccountProxy } from "./homes";
import { detectPiSignOut } from "./limits";
import { PiAdapter, piSessionDir } from "./pi";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, findAccount } from "./state";

const KEY = "sk-ant-api03-pppppppppppppppppppppppp-4242";
/** What an added account's agents get in place of any Anthropic key or token from elsewhere. */
const BLANK_ANTHROPIC = {
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  ANTHROPIC_OAUTH_TOKEN: "",
  ANTHROPIC_CUSTOM_HEADERS: "",
  ANTHROPIC_FEDERATION_RULE_ID: "",
  ANTHROPIC_ORGANIZATION_ID: "",
  ANTHROPIC_IDENTITY_TOKEN_FILE: "",
  ANTHROPIC_SERVICE_ACCOUNT_ID: "",
  ANTHROPIC_WORKSPACE_ID: "",
};
const SAVED = ["PASEO_HOME", "ZEROSUB_PI_DIR", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID", "ANTHROPIC_IDENTITY_TOKEN_FILE", "ANTHROPIC_SERVICE_ACCOUNT_ID", "ANTHROPIC_WORKSPACE_ID", "OPENROUTER_API_KEY", "QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_TEAM_API_KEY", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "NO_PROXY", "no_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

let root: string;
let main: string;
let saved: Partial<Record<(typeof SAVED)[number], string>>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-pi-"));
  saved = {};
  for (const key of SAVED) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  main = join(root, "pi-agent");
  process.env.PI_CODING_AGENT_DIR = main;
  process.env.PASEO_HOME = join(root, "paseo");
  // Never ~/.pi-config: added accounts' folders and scripts are kept there.
  process.env.ZEROSUB_PI_DIR = join(root, "pi-config");
  await mkdir(join(main, "sessions"), { recursive: true });
  await mkdir(join(main, "extensions"), { recursive: true });
  await writeFile(join(main, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
  await writeFile(
    join(main, "auth.json"),
    JSON.stringify({
      anthropic: { type: "api_key", key: "sk-main" },
      openrouter: { type: "api_key", key: "sk-or" },
      openai: { type: "oauth", access: "a", refresh: "r", expires: 1 },
    }),
  );
  await writeFile(join(main, "models-store.json"), "{}");
});

afterEach(async () => {
  for (const key of SAVED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("a Pi account's generated files", () => {
  it("copies the CLI login's other API keys, but not its sign-ins, and puts the account's key in for Anthropic", () => {
    expect(
      piAuth(
        { anthropic: { type: "api_key", key: "main" }, openrouter: { type: "api_key", key: "or" }, openai: { type: "oauth", refresh: "r" } },
        KEY,
      ),
    ).toEqual({ openrouter: { type: "api_key", key: "or" }, anthropic: { type: "api_key", key: KEY } });
    expect(piAuth(undefined, null)).toEqual({});
  });

  it("stores a key so Pi reads it as typed, never running or filling it in", () => {
    // Pi runs a value starting with `!` and fills in `$NAME`; `$$` is a `$` and `$!` a `!` (Pi 1.4.0's resolveConfigValue).
    expect(piLiteral("sk-ant-plain")).toBe("sk-ant-plain");
    expect(piLiteral("!echo leaked")).toBe("$!echo leaked");
    expect(piLiteral("sk$HOME")).toBe("sk$$HOME");
    expect(piLiteral("${X}")).toBe("$${X}");
    expect(piLiteral("$!")).toBe("$$!");
    expect(piLiteral("a!b")).toBe("a!b");
    expect(piAuth(undefined, "!echo$X")).toEqual({ anthropic: { type: "api_key", key: "$!echo$$X" } });
  });

  it("sends Anthropic's requests to the account's base URL, and drops anything else that would send another key", () => {
    const mainModels = {
      providers: { anthropic: { baseUrl: "https://elsewhere", apiKey: "x", headers: { a: "b" }, authHeader: true, models: [{ id: "m" }] }, ollama: { baseUrl: "http://localhost" } },
      modelOverrides: { x: {} },
    };
    expect(piModels(mainModels, "https://gw.example.com")).toEqual({
      providers: { anthropic: { models: [{ id: "m" }], baseUrl: "https://gw.example.com" }, ollama: { baseUrl: "http://localhost" } },
      modelOverrides: { x: {} },
    });
    expect(piModels({ providers: { anthropic: { baseUrl: "https://elsewhere" } } }, null)).toEqual({});
    expect(piModels(undefined, null)).toEqual({});
  });

  it("takes the CLI login's per-model base URLs and headers out of Anthropic's models, which would otherwise outrank the account's", () => {
    const mainModels = {
      providers: {
        anthropic: {
          models: [{ id: "relay", baseUrl: "https://relay.example.com", headers: { "x-relay": "t" }, name: "Relay" }, { id: "plain" }],
          modelOverrides: { "claude-sonnet-4-5": { headers: { "x-other": "t" }, name: "Sonnet" } },
        },
      },
    };
    expect(piModels(mainModels, null)).toEqual({
      providers: { anthropic: { models: [{ id: "relay", name: "Relay" }, { id: "plain" }], modelOverrides: { "claude-sonnet-4-5": { name: "Sonnet" } } } },
    });
  });
});

describe("a Pi account's home", () => {
  it("shares the CLI login's entries and keeps its sign-ins, models and catalog to itself", async () => {
    const home = join(root, "paseo", "zerosub", "homes", "pi-aaaaaaaaaaaa");
    await writePiAccountApi(home, { key: KEY, baseUrl: "https://gw.example.com/" });
    await preparePiHome(home, true);

    expect(await readlink(join(home, "settings.json"))).toBe(await realpath(join(main, "settings.json")));
    expect((await lstat(join(home, "sessions"))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(home, "extensions"))).isSymbolicLink()).toBe(true);
    await expect(lstat(join(home, "models-store.json"))).rejects.toThrow();

    const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
    expect(auth).toEqual({ openrouter: { type: "api_key", key: "sk-or" }, anthropic: { type: "api_key", key: KEY } });
    expect((await stat(join(home, "auth.json"))).mode & 0o777).toBe(0o600);
    expect((await stat(join(home, "zerosub.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(home, "models.json"), "utf8"))).toEqual({ providers: { anthropic: { baseUrl: "https://gw.example.com" } } });

    expect(await readPiAccountApi(home)).toMatchObject({ keyHint: "4242", baseUrl: "https://gw.example.com" });
  });

  it("only sends a kept key where it went before", async () => {
    const home = join(root, "home");
    await writePiAccountApi(home, { key: KEY, baseUrl: null });
    await expect(writePiAccountApi(home, { key: null, baseUrl: "https://gw.example.com" })).rejects.toThrow(/Enter the key again/);
    await writePiAccountApi(home, { key: null, baseUrl: null });
    await writePiAccountProxy(home, "http://u:p@127.0.0.1:7890");
    expect(await readPiAccount(home)).toEqual({ key: KEY, baseUrl: null, proxy: "http://u:p@127.0.0.1:7890" });
    await writePiAccountProxy(home, null);
    expect((await readPiAccount(home)).proxy).toBeNull();
    expect(await readPiAccountApi(join(root, "nothing"))).toBeNull();
  });

  it("only sends a kept key through a new proxy when the base URL encrypts it", async () => {
    const home = join(root, "home");
    await writePiAccountApi(home, { key: KEY, baseUrl: "http://gw.example.com" });
    await expect(writePiAccountProxy(home, "http://attacker:8080")).rejects.toThrow(/plain http/);
    // Clearing it is fine, and so is any proxy once the key goes over https:// or stays on this machine.
    await writePiAccountProxy(home, null);
    await writePiAccountApi(home, { key: KEY, baseUrl: "http://127.0.0.1:4000" });
    await writePiAccountProxy(home, "http://127.0.0.1:7890");
    await writePiAccountApi(home, { key: KEY, baseUrl: "https://gw.example.com" });
    await writePiAccountProxy(home, "http://10.0.0.1:3128");
    expect(sentInTheClear("http://[::1]:4000")).toBe(false);
    expect(sentInTheClear("http://localhost")).toBe(false);
    expect(sentInTheClear("http://127.0.0.2")).toBe(true);
    expect(sentInTheClear(null)).toBe(false);
  });

  it("sets no new proxy while Pi's own models.json sends another provider's key over plain http://", async () => {
    const home = join(root, "home");
    await writePiAccountApi(home, { key: KEY, baseUrl: null });
    // openrouter's key (in Pi's auth.json) is copied to every account.
    await writeFile(join(main, "models.json"), JSON.stringify({ providers: { openrouter: { models: [{ id: "m", baseUrl: "http://gw.example.com" }] } } }));
    await expect(writePiAccountProxy(home, "http://10.0.0.1:3128")).rejects.toThrow(/openrouter/);
    // A provider without a stored key, or one on this machine, sends nothing a proxy could read.
    await writeFile(join(main, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://gw.example.com" }, openrouter: { baseUrl: "http://localhost:4000" } } }));
    await writePiAccountProxy(home, "http://10.0.0.1:3128");
    expect((await readPiAccount(home)).proxy).toBe("http://10.0.0.1:3128");

    // Credentials kept in models.json itself are copied too: the provider's, a model's or an override's.
    const remote = "http://gw.example.com";
    for (const providers of [
      { ollama: { baseUrl: remote, apiKey: "k" } },
      { ollama: { baseUrl: remote, modelOverrides: { m: { headers: { authorization: "Bearer k" } } } } },
      { ollama: { models: [{ id: "m", baseUrl: remote, headers: { "x-api-key": "k" } }] } },
    ]) {
      await writeFile(join(main, "models.json"), JSON.stringify({ providers }));
      await expect(writePiAccountProxy(home, "http://10.0.0.2:3128")).rejects.toThrow(/ollama/);
    }
    // An empty header list, or `authHeader: false`, sends nothing to read.
    await writeFile(join(main, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: remote, headers: {}, authHeader: false } } }));
    await writePiAccountProxy(home, "http://10.0.0.2:3128");

    // A key Pi takes from the environment for one of its own providers crosses the proxy as well.
    await writeFile(join(main, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "sk-main" } }));
    await writeFile(join(main, "models.json"), JSON.stringify({ providers: { openrouter: { baseUrl: remote } } }));
    await writePiAccountProxy(home, "http://10.0.0.3:3128");
    process.env.OPENROUTER_API_KEY = "sk-or-env";
    await expect(writePiAccountProxy(home, "http://10.0.0.4:3128")).rejects.toThrow(/openrouter/);
    delete process.env.OPENROUTER_API_KEY;
    // A provider Pi takes its key from more than one variable for (from 1.6: the per-plan one, then the shared one).
    await writeFile(join(main, "models.json"), JSON.stringify({ providers: { "qwen-token-plan": { baseUrl: remote } } }));
    for (const name of ["QWEN_TOKEN_PLAN_API_KEY", "QWEN_TOKEN_PLAN_TEAM_API_KEY"] as const) {
      process.env[name] = "sk-qwen";
      await expect(writePiAccountProxy(home, "http://10.0.0.4:3128"), name).rejects.toThrow(/qwen-token-plan/);
      delete process.env[name];
    }

    // Pi reads models.json past a byte order mark, `//` comments and trailing commas, so they hide nothing.
    await writeFile(join(main, "models.json"), `\uFEFF{\n  // my gateway\n  "providers": { "ollama": { "baseUrl": "${remote}", "apiKey": "k", }, },\n}\n`);
    await expect(writePiAccountProxy(home, "http://10.0.0.4:3128")).rejects.toThrow(/ollama/);
  });
});

describe("PiAdapter", () => {
  it("starts an added account on its own agent directory, the CLI login's sessions and its own proxy", async () => {
    process.env.NO_PROXY = "localhost,.anthropic.com,gw.example.com,intranet.local";
    const home = join(root, "home");
    await writePiAccountApi(home, { key: KEY, baseUrl: "https://gw.example.com" });
    await writePiAccountProxy(home, "http://127.0.0.1:7890");
    const env = await new PiAdapter().env(home, { cwd: "/work/my project" });
    expect(env).toMatchObject({
      PI_CODING_AGENT_DIR: home,
      PI_CODING_AGENT_SESSION_DIR: join(main, "sessions", "--work-my project--"),
      HTTPS_PROXY: "http://127.0.0.1:7890",
      https_proxy: "http://127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:7890",
      http_proxy: "http://127.0.0.1:7890",
    });
    // Anthropic and the base URL stay on the proxy; the rest of the list stays as it was.
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,intranet.local");
    expect(env.no_proxy).toBe(env.NO_PROXY);
  });

  it("leaves the sessions folder alone where it's set already, and an account without a proxy goes through the shared httpProxy", async () => {
    await writeFile(join(main, "settings.json"), JSON.stringify({ sessionDir: "/somewhere", httpProxy: "http://10.0.0.1:3128" }));
    const home = join(root, "home");
    await writePiAccountApi(home, { key: KEY, baseUrl: null });
    const adapter = new PiAdapter();
    const env = await adapter.env(home, { cwd: "/work" });
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    // Pi applies httpProxy from the settings it shares; ZeroSub adds no proxy over it.
    expect(env).toEqual({ PI_CODING_AGENT_DIR: home, ...BLANK_ANTHROPIC });
    expect(await adapter.proxyState(home)).toEqual({
      own: null,
      file: null,
      inherited: { proxy: "http://10.0.0.1:3128", from: expect.stringContaining("httpProxy in") },
    });
  });

  it("leaves the CLI login as Paseo runs it without ZeroSub", async () => {
    await writeFile(join(main, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", httpProxy: "http://10.0.0.1:3128" }));
    expect(await new PiAdapter().env(null, { cwd: "/work" })).toEqual({});
  });

  it("keeps any other Anthropic key, token, headers or federation from an added account's agents, and leaves them to the CLI login's", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-daemon";
    process.env.ANTHROPIC_FEDERATION_RULE_ID = "fdrl_daemon";
    const home = join(root, "home");
    await writePiAccountApi(home, { key: KEY, baseUrl: "https://gw.example.com" });
    const adapter = new PiAdapter();
    const patch = await adapter.env(home);
    expect(patch).toEqual({ PI_CODING_AGENT_DIR: home, ...BLANK_ANTHROPIC });
    // Whether the daemon has them or the Pi provider's env in Paseo's config gives them.
    expect(
      applyEnv(patch, {
        ANTHROPIC_AUTH_TOKEN: "token-from-config",
        ANTHROPIC_CUSTOM_HEADERS: "x-api-key: sk-other",
        ANTHROPIC_ORGANIZATION_ID: "org-from-config",
        OPENAI_API_KEY: "sk-openai",
      }),
    ).toEqual({
      PI_CODING_AGENT_DIR: home,
      ...BLANK_ANTHROPIC,
      OPENAI_API_KEY: "sk-openai",
    });
    expect(await adapter.env(null)).toEqual({});
  });

  it("changes the CLI login's proxy in Pi's own settings only when asked to, and still adds nothing to its agents", async () => {
    const adapter = new PiAdapter();
    expect((await adapter.proxyState(null)).own).toBeNull();

    await adapter.setProxy(null, "http://127.0.0.1:7890");
    expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic", httpProxy: "http://127.0.0.1:7890" });
    expect((await readdir(join(root, "paseo", "zerosub", "backups"))).filter((name) => name.startsWith("pi-settings-"))).toHaveLength(1);
    expect(await adapter.proxyState(null)).toMatchObject({ own: "http://127.0.0.1:7890", file: expect.stringContaining("settings.json"), inherited: null });
    // Pi reads httpProxy itself; the CLI login's agents start as Paseo starts them.
    expect(await adapter.env(null, { cwd: "/work" })).toEqual({});

    await adapter.setProxy(null, null);
    expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic" });
  });

  it("sets no new proxy on Pi's own login while an Anthropic credential of its own, wherever Pi takes it from, would cross it over plain http://", async () => {
    const adapter = new PiAdapter();
    const remote = "http://gw.example.com";
    const keyed = { anthropic: { type: "api_key", key: "sk-main" } };
    const refused = async (label: string, auth: unknown, models: string | object, env: Record<string, string> = {}) => {
      await writeFile(join(main, "auth.json"), JSON.stringify(auth));
      await writeFile(join(main, "models.json"), typeof models === "string" ? models : JSON.stringify(models));
      Object.assign(process.env, env);
      try {
        await expect(adapter.setProxy(null, "http://10.0.0.1:3128"), label).rejects.toThrow(/Anthropic.*plain http:\/\//);
      } finally {
        for (const key of Object.keys(env)) delete process.env[key];
      }
      expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8")), label).toEqual({ defaultProvider: "anthropic" });
    };
    await refused("a stored key", keyed, { providers: { anthropic: { baseUrl: remote } } });
    await refused("a stored sign-in", { anthropic: { type: "oauth", access: "a", refresh: "r", expires: 1 } }, { providers: { anthropic: { baseUrl: remote } } });
    await refused("a key in models.json", {}, { providers: { anthropic: { baseUrl: remote, apiKey: "sk-in-models" } } });
    await refused("headers in models.json", {}, { providers: { anthropic: { baseUrl: remote, headers: { "x-api-key": "k" } } } });
    await refused("one model's base URL", keyed, { providers: { anthropic: { models: [{ id: "claude-x", baseUrl: remote }] } } });
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_FEDERATION_RULE_ID"]) {
      await refused(name, {}, { providers: { anthropic: { baseUrl: remote } } }, { [name]: "x-api-key: sk-env" });
    }
    await refused("a models.json with a comment and a byte order mark", keyed, `\uFEFF{\n  // gateway\n  "providers": { "anthropic": { "baseUrl": "${remote}" } },\n}\n`);
    // Another provider's sign-in is Pi's own login's to send too, though no added account gets it.
    await writeFile(join(main, "auth.json"), JSON.stringify({ openai: { type: "oauth", access: "a", refresh: "r", expires: 1 } }));
    await writeFile(join(main, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: remote } } }));
    await expect(adapter.setProxy(null, "http://10.0.0.1:3128")).rejects.toThrow(/openai/);
    // A models.json Pi can't read either leaves nothing to tell from, so it's refused rather than guessed at.
    await writeFile(join(main, "models.json"), "{ not json");
    await expect(adapter.setProxy(null, "http://10.0.0.1:3128")).rejects.toThrow(/models\.json/);

    // Nothing of Anthropic's to send: the proxy is set.
    await writeFile(join(main, "auth.json"), "{}");
    await writeFile(join(main, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: remote } } }));
    await adapter.setProxy(null, "http://10.0.0.1:3128");
    // A gateway on this machine is no way around it: Pi adds nothing to NO_PROXY for httpProxy, and
    // undici then sends every host through the proxy, this machine's included.
    await writeFile(join(main, "auth.json"), JSON.stringify(keyed));
    await writeFile(join(main, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: "http://127.0.0.1:4000", apiKey: "k" } } }));
    await expect(adapter.setProxy(null, "http://10.0.0.2:3128")).rejects.toThrow(/Anthropic.*plain http:\/\/.*NO_PROXY/);
    expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8")).httpProxy).toBe("http://10.0.0.1:3128");
    // Unless the environment's NO_PROXY keeps it direct.
    process.env.NO_PROXY = "127.0.0.1";
    await adapter.setProxy(null, "http://10.0.0.2:3128");
    expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8")).httpProxy).toBe("http://10.0.0.2:3128");
  });

  it("counts this machine's addresses as crossing a proxy Pi takes itself unless the no-proxy list, read as undici reads it, keeps them direct", () => {
    for (const base of ["http://127.0.0.1:4000", "http://localhost:4000", "http://[::1]:4000"]) expect(crossesInheritedProxy(base, {}), base).toBe(true);
    expect(crossesInheritedProxy("http://127.0.0.1:4000", { NO_PROXY: "localhost,127.0.0.1" })).toBe(false);
    expect(crossesInheritedProxy("http://127.0.0.1:4000", { no_proxy: "127.0.0.1:4000" })).toBe(false);
    expect(crossesInheritedProxy("http://127.0.0.1:4000", { NO_PROXY: "*" })).toBe(false);
    // undici reads no_proxy wherever it's set, even empty, and NO_PROXY only without it.
    expect(crossesInheritedProxy("http://127.0.0.1:4000", { no_proxy: "", NO_PROXY: "127.0.0.1" })).toBe(true);
    expect(crossesInheritedProxy("http://127.0.0.1:4000", { no_proxy: "intranet.example", NO_PROXY: "*" })).toBe(true);
    // Encrypted, or nothing to send: nothing a proxy could read.
    expect(crossesInheritedProxy("https://127.0.0.1:4000", {})).toBe(false);
    expect(crossesInheritedProxy(null, {})).toBe(false);
  });

  it("checks an added account's address through the proxy Pi takes while no_proxy, which Pi reads before NO_PROXY, doesn't keep Anthropic direct", async () => {
    const tunnels: string[] = [];
    const proxy = createServer().on("connect", (req, socket) => {
      tunnels.push(req.url ?? "");
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const direct = vi.fn(async () => new Response("ip=203.0.113.7\nloc=NL\n"));
    vi.stubGlobal("fetch", direct);
    try {
      const home = join(root, "home");
      await writePiAccountApi(home, { key: KEY, baseUrl: null });
      process.env.https_proxy = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
      // NO_PROXY would keep Anthropic direct, but Pi reads no_proxy in its place.
      process.env.no_proxy = "intranet.example";
      process.env.NO_PROXY = ".anthropic.com";
      await expect(new PiAdapter().egress(home)).rejects.toThrow(/refused the tunnel/);
      expect(tunnels).toEqual(["api.anthropic.com:443"]);
      expect(direct).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await new Promise((resolve) => proxy.close(resolve));
    }
  });

  it("reads Pi's own proxy past a byte order mark, as Pi does", async () => {
    await writeFile(join(main, "settings.json"), `\uFEFF${JSON.stringify({ httpProxy: "http://10.0.0.1:3128" })}`);
    const adapter = new PiAdapter();
    expect((await adapter.proxyState(null)).own).toBe("http://10.0.0.1:3128");
    const home = join(root, "home");
    await writePiAccountApi(home, { key: KEY, baseUrl: null });
    expect((await adapter.proxyState(home)).inherited?.proxy).toBe("http://10.0.0.1:3128");
  });

  it("writes a proxy password into the file Pi's settings link to, readable only by the user", async () => {
    const real = join(root, "dotfiles", "pi-settings.json");
    await mkdir(join(root, "dotfiles"));
    await writeFile(real, JSON.stringify({ defaultProvider: "anthropic" }), { mode: 0o644 });
    await rm(join(main, "settings.json"));
    await symlink(real, join(main, "settings.json"));
    const adapter = new PiAdapter();

    await adapter.setProxy(null, "http://u:secret@127.0.0.1:7890");
    expect((await lstat(join(main, "settings.json"))).isSymbolicLink()).toBe(true);
    expect(JSON.parse(await readFile(real, "utf8")).httpProxy).toBe("http://u:secret@127.0.0.1:7890");
    expect((await stat(real)).mode & 0o777).toBe(0o600);
    const backups = join(root, "paseo", "zerosub", "backups");
    for (const name of await readdir(backups)) expect((await stat(join(backups, name))).mode & 0o077).toBe(0);
  });

  it("gives an added account with a proxy its own settings with httpProxy, and the shared ones back without", async () => {
    const home = join(root, "paseo", "zerosub", "homes", "pi-bbbbbbbbbbbb");
    await writePiAccountApi(home, { key: KEY, baseUrl: null });
    await preparePiHome(home, true);
    expect((await lstat(join(home, "settings.json"))).isSymbolicLink()).toBe(true);

    await writePiAccountProxy(home, "http://u:p@127.0.0.1:7890");
    expect((await lstat(join(home, "settings.json"))).isSymbolicLink()).toBe(false);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic", httpProxy: "http://u:p@127.0.0.1:7890" });
    expect((await stat(join(home, "settings.json"))).mode & 0o777).toBe(0o600);
    // The CLI login's own settings are never written through the link.
    expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic" });
    expect((await readPiAccount(home)).proxy).toBe("http://u:p@127.0.0.1:7890");

    // Main's settings changing reach it at the next sync, and a sync doesn't link it back.
    await writeFile(join(main, "settings.json"), JSON.stringify({ defaultProvider: "openai" }));
    await preparePiHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ defaultProvider: "openai", httpProxy: "http://u:p@127.0.0.1:7890" });

    await writePiAccountProxy(home, null);
    expect(await readlink(join(home, "settings.json"))).toBe(await realpath(join(main, "settings.json")));
  });

  it("takes a cleared or changed proxy out of the account's own settings when Pi's login has none to share, or none that parse", async () => {
    const home = join(root, "paseo", "zerosub", "homes", "pi-cccccccccccc");
    await writePiAccountApi(home, { key: KEY, baseUrl: null });
    await rm(join(main, "settings.json"));
    await writePiAccountProxy(home, "http://u:p@127.0.0.1:7890");
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ httpProxy: "http://u:p@127.0.0.1:7890" });

    // Nothing to link to: the file stays, without the proxy Pi would otherwise still go through.
    await writePiAccountProxy(home, null);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({});
    await preparePiHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({});
    // Once Pi's login has settings, they're shared again.
    await writeFile(join(main, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
    await preparePiHome(home, true);
    expect(await readlink(join(home, "settings.json"))).toBe(await realpath(join(main, "settings.json")));

    // While Pi's settings don't parse, the rest of the account's stays as it was, but not its proxy.
    await writePiAccountProxy(home, "http://127.0.0.1:7890");
    await writeFile(join(main, "settings.json"), "{ not json");
    await writePiAccountProxy(home, "http://127.0.0.1:7891");
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic", httpProxy: "http://127.0.0.1:7891" });
  });

  it("counts an added account signed in while it has a key, and the CLI login always", async () => {
    const adapter = new PiAdapter();
    expect((await adapter.identity(null)).signedIn).toBe(true);
    expect((await adapter.identity(join(root, "empty"))).signedIn).toBe(false);
    await writePiAccountApi(join(root, "home"), { key: KEY, baseUrl: null });
    expect((await adapter.identity(join(root, "home"))).signedIn).toBe(true);
  });
});

describe("Pi's own login's key", () => {
  it("is set in Pi's own files only when asked to, keeping everything else and a private copy of each as it was", async () => {
    await writeFile(join(main, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://localhost" } } }));
    const adapter = new PiAdapter();
    expect(await adapter.api(null)).toMatchObject({ keyHint: "", baseUrl: null });

    await adapter.setApi(null, { key: KEY, baseUrl: "https://gw.example.com/" });
    const auth = JSON.parse(await readFile(join(main, "auth.json"), "utf8"));
    expect(auth.anthropic).toEqual({ type: "api_key", key: KEY });
    expect(auth.openrouter).toEqual({ type: "api_key", key: "sk-or" });
    expect(auth.openai).toMatchObject({ type: "oauth" });
    expect((await stat(join(main, "auth.json"))).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(join(main, "models.json"), "utf8"))).toEqual({
      providers: { ollama: { baseUrl: "http://localhost" }, anthropic: { baseUrl: "https://gw.example.com" } },
    });
    expect(await adapter.api(null)).toMatchObject({ keyHint: "4242", baseUrl: "https://gw.example.com" });
    const backups = join(root, "paseo", "zerosub", "backups");
    const names = await readdir(backups);
    expect(names.filter((name) => name.startsWith("pi-auth-"))).toHaveLength(1);
    expect(names.filter((name) => name.startsWith("pi-models-"))).toHaveLength(1);
    for (const name of names) expect((await stat(join(backups, name))).mode & 0o077).toBe(0);

    // A kept key only goes where it went before; back to Anthropic's own API with it typed again.
    await expect(adapter.setApi(null, { key: null, baseUrl: null })).rejects.toThrow(/Enter the key again/);
    await adapter.setApi(null, { key: KEY, baseUrl: null });
    expect(JSON.parse(await readFile(join(main, "models.json"), "utf8"))).toEqual({ providers: { ollama: { baseUrl: "http://localhost" } } });
  });

  it("is stored so Pi reads it as typed, and kept as it is when the same key is typed again", async () => {
    const adapter = new PiAdapter();
    await adapter.setApi(null, { key: "!echo$X", baseUrl: null });
    expect(JSON.parse(await readFile(join(main, "auth.json"), "utf8")).anthropic).toEqual({ type: "api_key", key: "$!echo$$X" });
    const backups = async () => (await readdir(join(root, "paseo", "zerosub", "backups"))).filter((name) => name.startsWith("pi-auth-")).length;
    const before = await backups();
    await adapter.setApi(null, { key: "!echo$X", baseUrl: null });
    expect(await backups()).toBe(before);
  });

  it("leaves the key as it was when models.json can't take the new base URL", async () => {
    // Pi reads comments there; written back they'd be lost, so it's left alone, and so is the key.
    const commented = `{\n  // mine\n  "providers": {}\n}\n`;
    await writeFile(join(main, "models.json"), commented);
    const before = await readFile(join(main, "auth.json"), "utf8");
    await expect(new PiAdapter().setApi(null, { key: "sk-new-key-0000000000", baseUrl: "https://gw.example.com" })).rejects.toThrow(/by hand/);
    expect(await readFile(join(main, "auth.json"), "utf8")).toBe(before);
    expect(await readFile(join(main, "models.json"), "utf8")).toBe(commented);
  });

  it("waits for Pi's own lock on its sign-ins", async () => {
    await mkdir(join(main, "auth.json.lock"));
    await expect(new PiAdapter().setApi(null, { key: KEY, baseUrl: null })).rejects.toThrow(/Pi is writing/);
  });

  it("waits for Pi's lock wherever that Pi version takes it for a linked auth.json: beside the link (to 1.5.0) or the file it points to (from 1.5.1)", async () => {
    const real = join(root, "dotfiles", "pi-auth.json");
    await mkdir(join(root, "dotfiles"));
    await writeFile(real, JSON.stringify({ anthropic: { type: "api_key", key: "sk-main" } }), { mode: 0o600 });
    await rm(join(main, "auth.json"));
    await symlink(real, join(main, "auth.json"));
    const adapter = new PiAdapter();
    for (const lock of [`${join(main, "auth.json")}.lock`, `${real}.lock`]) {
      await mkdir(lock);
      await expect(adapter.setApi(null, { key: "sk-new-key-0000000000", baseUrl: null }), lock).rejects.toThrow(/right now/);
      expect(JSON.parse(await readFile(real, "utf8")).anthropic.key, lock).toBe("sk-main");
      await rm(lock, { recursive: true });
      // Nothing of ZeroSub's own is left behind to hold Pi up.
      expect((await readdir(main)).concat(await readdir(join(root, "dotfiles"))).filter((name) => name.endsWith(".lock"))).toEqual([]);
    }
    await adapter.setApi(null, { key: "sk-new-key-0000000000", baseUrl: null });
    expect(JSON.parse(await readFile(real, "utf8")).anthropic.key).toBe("sk-new-key-0000000000");
    expect((await readdir(main)).concat(await readdir(join(root, "dotfiles"))).filter((name) => name.endsWith(".lock"))).toEqual([]);
  });

  it("never checks the CLI login's address", async () => {
    expect(await new PiAdapter().egress(null)).toBeNull();
  });
});

describe("Pi's sessions", () => {
  it("finds the sessions folder Pi names after the project's real path", async () => {
    const real = join(root, "real-project");
    await mkdir(real);
    const { symlink } = await import("node:fs/promises");
    await symlink(real, join(root, "linked-project"));
    const expected = join(main, "sessions", `--${(await realpath(real)).replace(/^\//, "").replace(/\//g, "-")}--`);
    expect(await piSessionDir(join(root, "linked-project"))).toBe(expected);
    expect(await piSessionDir("/no/such/folder")).toBe(join(main, "sessions", "--no-such-folder--"));
  });
});

describe("Pi turns", () => {
  const turn = (message: string): TurnEvent => ({ outcome: { kind: "failed", error: { message } } as never, timeline: [], turnId: null });

  it("takes Anthropic refusing the key for a sign-out, and nothing else", () => {
    expect(detectPiSignOut(turn('401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))).toMatch(/^401/);
    expect(detectPiSignOut(turn("No API key found for openai"))).toBeNull();
    expect(detectPiSignOut(turn('429 {"type":"error","error":{"type":"rate_limit_error"}}'))).toBeNull();
  });
});

describe("Pi's provider", () => {
  it("is routed unless its entry brings an agent directory of its own", () => {
    expect(familiesFromConfig({})).toMatchObject({ pi: "pi" });
    expect(familiesFromConfig({ pi: { env: { PI_CODING_AGENT_DIR: "/elsewhere" } } }).pi).toBeUndefined();
    expect(familiesFromConfig({ "pi-work": { extends: "pi" } })["pi-work"]).toBe("pi");
  });
});

class InstalledPi extends PiAdapter {
  /** Homes the process scan says Pi runs on. */
  readonly inUse = new Set<string>();
  /** Homes whose address was checked; null is the CLI login. */
  readonly egressChecks: Array<string | null> = [];
  /** Runs at each process scan, before it answers. */
  onScan: ((homes: readonly string[]) => Promise<void>) | null = null;
  override async available() {
    return { ok: true, detail: null };
  }
  override async egress(home: string | null) {
    this.egressChecks.push(home);
    return null;
  }
  // Tests never list the machine's processes.
  override async homesInUse(homes: readonly string[]) {
    await this.onScan?.(homes);
    return new Set(homes.filter((home) => this.inUse.has(home)));
  }
}

function piService(pi: PiAdapter, store: StateStore, reopener: Partial<Reopener> = { locate: async () => null }): Service {
  return new Service(
    { claude: noClaude("claude"), codex: noClaude("codex"), pi },
    store,
    { resolve: async () => ({ pi: "pi" as const }) } as unknown as FamilyResolver,
    reopener as Reopener,
  );
}

const open = (service: Service, paseo: unknown, reason = "create") =>
  service.onSessionOpen({ agentId: "agent-1", provider: "pi", cwd: "/work", reason, purpose: "interactive", env: {} } as never, { paseo } as never);

function noClaude(family: "claude" | "codex"): FamilyAdapter {
  return { ...absentPi(), family } as FamilyAdapter;
}

describe("Pi accounts in the service", () => {
  it("adds a Pi API account with its proxy, keeps it beside its script, and routes a Pi agent on it to its own directory", async () => {
    const store = new StateStore(join(root, "state.json"));
    const pi = new InstalledPi();
    const service = piService(pi, store);
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    service.attach(paseo as never);
    await service.start();
    try {
      expect((await store.read()).accounts.map((account) => [account.id, account.label])).toEqual([[MAIN_ACCOUNT_ID.pi, "Pi (CLI login)"]]);
      await expect(service.startLogin("pi", "browser")).rejects.toThrow(/API key/);
      // With no account added, nothing is checked and no script is written.
      await (service as unknown as { tick(): Promise<void> }).tick();
      expect(pi.egressChecks).toEqual([]);
      await expect(stat(join(root, "pi-config"))).rejects.toThrow();

      const id = await service.addApiAccount({ label: "Work key", key: KEY, proxy: "http://127.0.0.1:7890" });
      expect(id).toMatch(/^pi-[0-9a-f]{12}$/);
      // Set up in homes/, then kept beside its script in ~/.pi-config (ZEROSUB_PI_DIR here).
      const home = join(root, "pi-config", "pi-work-key");
      await expect(stat(join(root, "paseo", "zerosub", "homes", id))).rejects.toThrow();
      expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).anthropic).toEqual({ type: "api_key", key: KEY });
      const script = await readFile(join(root, "pi-config", "pi-work-key.sh"), "utf8");
      expect(script).toContain(`export PI_CODING_AGENT_DIR='${home}'`);
      expect(script).toContain('. "$PI_CODING_AGENT_DIR/zerosub.env"');
      expect(script).toContain('exec pi "$@"');
      const launchEnv = await readFile(join(home, "zerosub.env"), "utf8");
      expect(launchEnv).toContain("export https_proxy='http://127.0.0.1:7890'");
      expect(launchEnv).toContain("export NO_PROXY='localhost,127.0.0.1,::1'");
      // A shell's own Anthropic key never stands in for the account's, from a terminal either.
      for (const key of Object.keys(BLANK_ANTHROPIC)) expect(launchEnv).toContain(`export ${key}=''`);
      expect((await stat(join(home, "zerosub.env"))).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(await store.read())).not.toContain(KEY);
      expect(await store.read()).toMatchObject({ cleanup: {}, moves: {} });
      expect((await store.read()).accounts.find((account) => account.id === id)).toMatchObject({ family: "pi", auth: "api", home, label: "Work key" });
      await expect(service.addApiAccount({ label: "Again", key: KEY })).rejects.toThrow(/already added/);
      // Only the added account's address is checked, never the CLI login's.
      await vi.waitFor(() => expect(pi.egressChecks).toContain(home));
      expect(pi.egressChecks).not.toContain(null);

      const view = await service.view(paseo as never);
      const card = view.accounts.find((account) => account.id === id);
      expect(card).toMatchObject({
        proxy: "http://127.0.0.1:7890",
        proxyEditable: true,
        apiEditable: true,
        api: { keyHint: "4242", baseUrl: null },
        launcher: "pi-work-key.sh",
        externalHome: true,
        moving: null,
      });
      expect(view.piLaunchers).toBe(join(root, "pi-config"));
      // Pi's own login shows the Anthropic key it keeps, and can change it from its card.
      expect(view.accounts.find((account) => account.id === MAIN_ACCOUNT_ID.pi)).toMatchObject({ apiEditable: true, proxyEditable: true, api: { keyHint: "" }, egress: null });
      expect(view.warnings).toEqual(expect.not.arrayContaining([expect.stringContaining("Pi isn't installed")]));
      // Its files are still as they were: they change only when edited there.
      expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic" });
      expect(JSON.parse(await readFile(join(main, "auth.json"), "utf8")).anthropic).toEqual({ type: "api_key", key: "sk-main" });

      await service.setDefault(paseo as never, id);
      const opened = await open(service, paseo);
      expect(opened?.env).toMatchObject({
        PI_CODING_AGENT_DIR: home,
        PI_CODING_AGENT_SESSION_DIR: join(main, "sessions", "--work--"),
        HTTPS_PROXY: "http://127.0.0.1:7890",
      });

      await service.setProxy(id, "");
      const plain = await open(service, paseo, "refresh");
      expect(plain?.env.HTTPS_PROXY).toBeUndefined();
      const plainEnv = await readFile(join(home, "zerosub.env"), "utf8");
      expect(plainEnv).not.toMatch(/^export \w*proxy/im);
      for (const key of Object.keys(BLANK_ANTHROPIC)) expect(plainEnv).toContain(`export ${key}=''`);

      // Kept outside homes/, removing it only unregisters it: its folder, key and script stay.
      await service.remove(paseo as never, id);
      expect((await store.read()).accounts.some((account) => account.id === id)).toBe(false);
      expect((await store.read()).cleanup).toEqual({});
      expect((await stat(join(home, "zerosub.json"))).isFile()).toBe(true);
      expect(await readFile(join(root, "pi-config", "pi-work-key.sh"), "utf8")).toContain("# No longer managed by ZeroSub");

      // And it comes back from its folder, key, proxy and script as they were.
      await expect(service.importPiAccount(join(root, "nowhere"))).rejects.toThrow(/no folder/);
      await expect(service.importPiAccount(main)).rejects.toThrow(/isn't a Pi account's folder/);
      const back = await service.importPiAccount(home);
      expect((await store.read()).accounts.find((account) => account.id === back)).toMatchObject({ family: "pi", auth: "api", home, label: "pi-work-key" });
      await expect(service.importPiAccount(home)).rejects.toThrow(/already added/);
      expect(await readFile(join(root, "pi-config", "pi-work-key.sh"), "utf8")).toContain("# Generated by ZeroSub");
    } finally {
      await service.stop();
    }
  });

  it("sets no new proxy on the CLI login while an added account without its own sends its key over plain http://", async () => {
    const store = new StateStore(join(root, "state.json"));
    const service = piService(new InstalledPi(), store);
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    service.attach(paseo as never);
    await service.start();
    try {
      const id = await service.addApiAccount({ label: "Gateway", key: KEY, baseUrl: "http://gw.example.com" });
      const home = findAccount(await store.read(), id)!.home!;
      await expect(service.setProxy(MAIN_ACCOUNT_ID.pi, "http://127.0.0.1:7890")).rejects.toThrow(/Gateway has no proxy of its own/);
      expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic" });
      // Once it's gone, nothing would send a key through the proxy in the clear.
      await service.remove(paseo as never, id);
      await service.setProxy(MAIN_ACCOUNT_ID.pi, "http://127.0.0.1:7890");
      expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8")).httpProxy).toBe("http://127.0.0.1:7890");
      // Adding its kept folder back would put the key behind that proxy, so it's refused too.
      await expect(service.importPiAccount(home)).rejects.toThrow(/plain http:\/\//);
      expect((await store.read()).accounts.some((account) => account.home === home)).toBe(false);
    } finally {
      await service.stop();
    }
  });

  it("counts a follower's gateway on this machine as behind the CLI login's new proxy, unless NO_PROXY keeps it direct", async () => {
    const store = new StateStore(join(root, "state.json"));
    const service = piService(new InstalledPi(), store);
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    service.attach(paseo as never);
    await service.start();
    try {
      const id = await service.addApiAccount({ label: "Local", key: KEY, baseUrl: "http://127.0.0.1:4000" });
      const home = findAccount(await store.read(), id)!.home!;
      // ZeroSub gives it no NO_PROXY, and Pi adds none for httpProxy: its key would cross the proxy.
      await expect(service.setProxy(MAIN_ACCOUNT_ID.pi, "http://10.0.0.1:3128")).rejects.toThrow(/Local has no proxy of its own/);
      expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic" });
      // With the gateway in NO_PROXY, its key goes straight to it.
      process.env.NO_PROXY = "127.0.0.1";
      await service.setProxy(MAIN_ACCOUNT_ID.pi, "http://10.0.0.1:3128");
      expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8")).httpProxy).toBe("http://10.0.0.1:3128");

      // Its kept folder, added back once NO_PROXY no longer keeps it direct, would be behind that proxy.
      await service.remove(paseo as never, id);
      delete process.env.NO_PROXY;
      await expect(service.importPiAccount(home)).rejects.toThrow(/plain http:\/\//);
      expect((await store.read()).accounts.some((account) => account.home === home)).toBe(false);
      // Nor with the gateway only in NO_PROXY while no_proxy, which Pi reads in its place, leaves it out.
      process.env.no_proxy = "intranet.example";
      process.env.NO_PROXY = "127.0.0.1";
      await expect(service.importPiAccount(home)).rejects.toThrow(/plain http:\/\//);
      expect((await store.read()).accounts.some((account) => account.home === home)).toBe(false);
      delete process.env.no_proxy;
      process.env.NO_PROXY = "127.0.0.1";
      await service.importPiAccount(home);
      expect((await store.read()).accounts.some((account) => account.home === home)).toBe(true);
    } finally {
      await service.stop();
    }
  });

  it("moves a home only once nothing runs on it, and never holds a session up meanwhile", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = new StateStore(join(root, "state.json"));
    const pi = new InstalledPi();
    const service = piService(pi, store);
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    service.attach(paseo as never);
    try {
      await service.start();
      // A terminal runs Pi on every home in homes/, so a new account stays there for now.
      pi.inUse.add("*");
      const scan = pi.homesInUse.bind(pi);
      pi.homesInUse = async (homes) => (pi.inUse.has("*") ? new Set(homes.filter((home) => home.includes("/homes/"))) : scan(homes));
      const id = await service.addApiAccount({ label: "Work key", key: KEY });
      const from = join(root, "paseo", "zerosub", "homes", id);
      const to = join(root, "pi-config", "pi-work-key");
      expect(findAccount(await store.read(), id)?.home).toBe(from);
      let card = (await service.view(paseo as never)).accounts.find((account) => account.id === id);
      expect(card?.moving).toMatchObject({ to: expect.stringContaining("pi-config"), waiting: expect.stringContaining("Pi runs on it"), error: null });

      // A session opens on it straight away, where it is.
      await service.setDefault(paseo as never, id);
      expect((await open(service, paseo))?.env.PI_CODING_AGENT_DIR).toBe(from);

      // Once Pi stops there, it still waits for the agent that has just started on it.
      pi.inUse.clear();
      await service.placeHomes();
      expect(findAccount(await store.read(), id)?.home).toBe(from);
      card = (await service.view(paseo as never)).accounts.find((account) => account.id === id);
      expect(card?.moving?.waiting).toMatch(/just started/);

      vi.setSystemTime(Date.now() + 31_000);
      await service.placeHomes();
      expect(findAccount(await store.read(), id)?.home).toBe(to);
      await expect(stat(from)).rejects.toThrow();
      expect(JSON.parse(await readFile(join(to, "auth.json"), "utf8")).anthropic).toEqual({ type: "api_key", key: KEY });
      expect(await store.read()).toMatchObject({ moves: {} });
      expect((await open(service, paseo, "refresh"))?.env.PI_CODING_AGENT_DIR).toBe(to);
    } finally {
      vi.useRealTimers();
      await service.stop();
    }
  });

  it("gives way, folder and all, to a session routed to the home while it was moving, which never opens without the account's proxy", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = new StateStore(join(root, "state.json"));
    const pi = new InstalledPi();
    const service = piService(pi, store);
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    service.attach(paseo as never);
    try {
      await service.start();
      pi.inUse.add("held");
      const scan = pi.homesInUse.bind(pi);
      pi.homesInUse = async (homes) => (pi.inUse.has("held") ? new Set(homes) : scan(homes));
      const proxy = "http://127.0.0.1:7890";
      const id = await service.addApiAccount({ label: "Work key", key: KEY, proxy });
      await service.setDefault(paseo as never, id);
      const from = join(root, "paseo", "zerosub", "homes", id);
      const to = join(root, "pi-config", "pi-work-key");
      pi.inUse.clear();
      vi.setSystemTime(Date.now() + 31_000);

      // The scan made once the folder is at its new place: a session opens on the account just then.
      let routed: Record<string, unknown> | null | undefined;
      pi.onScan = async () => {
        if (!(await stat(to).catch(() => null)) || routed !== undefined) return;
        // It's answered at once, without waiting for the move. A routing error opens it on the CLI
        // login, as the session_open hook does (index.server.ts): null here.
        routed = ((await open(service, paseo).catch(() => undefined))?.env as Record<string, unknown> | undefined) ?? null;
      };
      await service.placeHomes();
      pi.onScan = null;

      // Its folder's settings can't be read just then, so it either has the account's proxy or doesn't
      // open on the account at all (it opens on the CLI login): never the account without its proxy.
      expect(routed).not.toBeUndefined();
      if (routed?.PI_CODING_AGENT_DIR !== undefined) expect(routed.HTTPS_PROXY).toBe(proxy);
      expect((await store.read()).sessions["agent-1"]?.accountId).not.toBe(id);
      expect(findAccount(await store.read(), id)?.home).toBe(from);
      expect((await stat(join(from, "zerosub.json"))).isFile()).toBe(true);
      await expect(stat(to)).rejects.toThrow();
      expect(await store.read()).toMatchObject({ moves: {} });
      const card = (await service.view(paseo as never)).accounts.find((account) => account.id === id);
      expect(card?.moving?.waiting).toMatch(/just started/);
    } finally {
      vi.useRealTimers();
      await service.stop();
    }
  });

  it("keeps the account on the folder with its key when Pi makes the old folder again during the check", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = new StateStore(join(root, "state.json"));
    const pi = new InstalledPi();
    const service = piService(pi, store);
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    service.attach(paseo as never);
    try {
      await service.start();
      pi.inUse.add("held");
      const scan = pi.homesInUse.bind(pi);
      pi.homesInUse = async (homes) => (pi.inUse.has("held") ? new Set(homes) : scan(homes));
      const id = await service.addApiAccount({ label: "Work key", key: KEY });
      const from = join(root, "paseo", "zerosub", "homes", id);
      const to = join(root, "pi-config", "pi-work-key");
      pi.inUse.clear();
      vi.setSystemTime(Date.now() + 31_000);

      // While the folder is at its new place, Pi starts on the old one (a terminal with its old
      // script, say) and makes it again: the move gives way, and the folder can't go back.
      pi.onScan = async () => {
        if (!(await stat(to).catch(() => null)) || pi.inUse.has(from)) return;
        await mkdir(join(from, "sessions"), { recursive: true });
        await writeFile(join(from, "settings.json"), "{}\n");
        pi.inUse.add(from);
      };
      await service.placeHomes();
      pi.onScan = null;
      expect((await stat(join(to, "zerosub.json"))).isFile()).toBe(true);
      await expect(stat(join(from, "zerosub.json"))).rejects.toThrow();
      // Whatever the card says, it never tells you to delete the folder with the key.
      const said = (await service.view(paseo as never)).accounts.find((account) => account.id === id)?.moving;
      expect(`${said?.error ?? ""} ${said?.waiting ?? ""}`).not.toMatch(new RegExp(`delete [^.]*${to.split("/").pop()}`));

      // The next pass finishes the move to the folder with the key, and leaves the one Pi made alone.
      pi.inUse.clear();
      await service.placeHomes();
      const state = await store.read();
      expect(findAccount(state, id)?.home).toBe(to);
      expect(state.moves).toEqual({});
      expect(JSON.parse(await readFile(join(to, "auth.json"), "utf8")).anthropic).toEqual({ type: "api_key", key: KEY });
      expect((await stat(join(from, "settings.json"))).isFile()).toBe(true);
      await service.setDefault(paseo as never, id);
      expect((await open(service, paseo))?.env.PI_CODING_AGENT_DIR).toBe(to);
    } finally {
      vi.useRealTimers();
      await service.stop();
    }
  });

  it("keeps an account's own proxy while clearing it would send its plain-http:// key through the CLI login's", async () => {
    const store = new StateStore(join(root, "state.json"));
    const service = piService(new InstalledPi(), store);
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    service.attach(paseo as never);
    await service.start();
    try {
      const id = await service.addApiAccount({ label: "Gateway", key: KEY, baseUrl: "http://gw.example.com", proxy: "http://127.0.0.1:7890" });
      const home = findAccount(await store.read(), id)!.home!;
      // The CLI login has a proxy of its own, which an account without one goes through.
      await writeFile(join(main, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", httpProxy: "http://alice:S3cr3tPw@10.0.0.1:3128" }));
      const refused = await service.setProxy(id, "").then(() => null, (error: unknown) => String(error));
      expect(refused).toMatch(/plain http:\/\//);
      // The message names the proxy without its password, as the card does.
      expect(refused).not.toContain("S3cr3tPw");
      expect(JSON.parse(await readFile(join(home, "zerosub.json"), "utf8")).proxy).toBe("http://127.0.0.1:7890");
      // Without one there, the key goes straight to the gateway, as it would without ZeroSub.
      await writeFile(join(main, "settings.json"), JSON.stringify({ defaultProvider: "anthropic" }));
      await service.setProxy(id, "");
      expect(JSON.parse(await readFile(join(home, "zerosub.json"), "utf8")).proxy).toBeUndefined();
    } finally {
      await service.stop();
    }
  });

  it("keeps an account's own proxy while clearing it would send its key to a gateway on this machine through the CLI login's", async () => {
    const store = new StateStore(join(root, "state.json"));
    const service = piService(new InstalledPi(), store);
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    service.attach(paseo as never);
    await service.start();
    try {
      // Its own proxy keeps this machine direct (ZeroSub's NO_PROXY); the CLI login's doesn't.
      const id = await service.addApiAccount({ label: "Local", key: KEY, baseUrl: "http://127.0.0.1:4000", proxy: "http://127.0.0.1:7890" });
      const home = findAccount(await store.read(), id)!.home!;
      await writeFile(join(main, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", httpProxy: "http://10.0.0.1:3128" }));
      await expect(service.setProxy(id, "")).rejects.toThrow(/plain http:\/\//);
      expect(JSON.parse(await readFile(join(home, "zerosub.json"), "utf8")).proxy).toBe("http://127.0.0.1:7890");
      // Nor with the gateway only in NO_PROXY while no_proxy, which Pi reads in its place, leaves it out.
      process.env.no_proxy = "intranet.example";
      process.env.NO_PROXY = "127.0.0.1";
      await expect(service.setProxy(id, "")).rejects.toThrow(/plain http:\/\//);
      expect(JSON.parse(await readFile(join(home, "zerosub.json"), "utf8")).proxy).toBe("http://127.0.0.1:7890");
      delete process.env.no_proxy;
      // With the gateway in NO_PROXY, the key goes straight to it.
      process.env.NO_PROXY = "127.0.0.1";
      await service.setProxy(id, "");
      expect(JSON.parse(await readFile(join(home, "zerosub.json"), "utf8")).proxy).toBeUndefined();
    } finally {
      await service.stop();
    }
  });

  it("sets no new proxy on the CLI login while a follower's folder is being moved, and says to try again", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const store = new StateStore(join(root, "state.json"));
    const pi = new InstalledPi();
    const service = piService(pi, store);
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    service.attach(paseo as never);
    try {
      await service.start();
      pi.inUse.add("held");
      const scan = pi.homesInUse.bind(pi);
      pi.homesInUse = async (homes) => (pi.inUse.has("held") ? new Set(homes) : scan(homes));
      await service.addApiAccount({ label: "Gateway", key: KEY, baseUrl: "http://gw.example.com" });
      const to = join(root, "pi-config", "pi-gateway");
      pi.inUse.clear();
      vi.setSystemTime(Date.now() + 31_000);
      const before = await readFile(join(main, "settings.json"), "utf8");

      // While its folder is away for the check, its settings can't be read: it isn't taken for safe.
      let refused: unknown;
      pi.onScan = async () => {
        if (!(await stat(to).catch(() => null)) || refused !== undefined) return;
        refused = await service.setProxy(MAIN_ACCOUNT_ID.pi, "http://127.0.0.1:7890").then(() => null, (error: unknown) => error);
      };
      await service.placeHomes();
      pi.onScan = null;
      expect(String(refused)).toMatch(/try again/i);
      expect(await readFile(join(main, "settings.json"), "utf8")).toBe(before);
      // Once it's where it'll stay, it's checked as ever.
      await expect(service.setProxy(MAIN_ACCOUNT_ID.pi, "http://127.0.0.1:7890")).rejects.toThrow(/Gateway has no proxy of its own/);
    } finally {
      vi.useRealTimers();
      await service.stop();
    }
  });

  it("finishes a move a restart cut short after the folder moved, and undoes one cut short before", async () => {
    const store = new StateStore(join(root, "state.json"));
    const pi = new InstalledPi();
    pi.inUse.add("held");
    const scan = pi.homesInUse.bind(pi);
    pi.homesInUse = async (homes) => (pi.inUse.has("held") ? new Set(homes) : scan(homes));
    const first = piService(pi, store);
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    first.attach(paseo as never);
    await first.start();
    const moved = await first.addApiAccount({ label: "Moved", key: KEY });
    const stayed = await first.addApiAccount({ label: "Stayed", key: `${KEY}-2` });
    await first.stop();
    const homes = join(root, "paseo", "zerosub", "homes");
    const movedTo = join(root, "pi-config", "moved");
    // Stopped after the folder was renamed but before the account's new home was saved, and stopped
    // before the other's folder moved at all.
    await mkdir(join(root, "pi-config"), { recursive: true });
    await rename(join(homes, moved), movedTo);
    const at = new Date().toISOString();
    await store.update((draft) => {
      draft.moves[moved] = { from: join(homes, moved), to: movedTo, at };
      draft.moves[stayed] = { from: join(homes, stayed), to: join(root, "pi-config", "stayed"), at };
    });

    const second = piService(pi, store);
    second.attach(paseo as never);
    try {
      await second.start();
      await second.placeHomes();
      const state = await store.read();
      expect(findAccount(state, moved)?.home).toBe(movedTo);
      expect(findAccount(state, stayed)?.home).toBe(join(homes, stayed));
      expect(state.moves).toEqual({});
      expect(await readFile(join(root, "pi-config", "pi-moved.sh"), "utf8")).toContain(`export PI_CODING_AGENT_DIR='${movedTo}'`);
      // Pi still runs on the one left behind, so it moves later.
      expect((await second.view(paseo as never)).accounts.find((account) => account.id === stayed)?.moving?.waiting).toMatch(/Pi runs on it/);
    } finally {
      await second.stop();
    }
  });

  it("leaves an agent whose key was refused where it is, without moving it to the CLI login or continuing it", async () => {
    const store = new StateStore(join(root, "state.json"));
    const service = piService(new InstalledPi(), store, {
      locate: async () => "/usr/local/bin/paseo",
      reopen: async (agentId: string) => (reopened.push(agentId), { ok: true as const }),
    } as unknown as Reopener);
    const reopened: string[] = [];
    const sent: string[] = [];
    const created: unknown[] = [];
    const agent = { id: "agent-1", provider: "pi", status: "idle", archived: false, hasHistory: true, cwd: "/work" };
    const paseo = {
      agents: {
        list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
        get: async () => agent,
        create: async (input: unknown) => void created.push(input),
        ref: () => ({
          send: async (prompt: string) => void sent.push(prompt),
          refresh: async () => ({ agent }),
          reload: async () => null,
          timeline: { refetch: async () => ({ entries: [] }), append: async () => null },
        }),
      },
    };
    service.attach(paseo as never);
    await service.start();
    try {
      const id = await service.addApiAccount({ label: "Work key", key: KEY });
      await service.setDefault(paseo as never, id);
      await service.onSessionOpen({ agentId: "agent-1", provider: "pi", cwd: "/work", reason: "create", purpose: "interactive", env: {} } as never, { paseo } as never);
      reopened.length = 0;
      const refused = { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } };
      await service.onTurnEnded(
        { agent, turnId: null, outcome: { kind: "failed", error: { message: `401 ${JSON.stringify(refused)}` } }, timeline: [] } as never,
        { paseo } as never,
      );
      const state = await store.read();
      expect(state.accounts.find((account) => account.id === id)?.signedIn).toBe(false);
      expect(state.sessions["agent-1"]?.accountId).toBe(id);
      expect(state.bindings["agent-1"]?.accountId).not.toBe(MAIN_ACCOUNT_ID.pi);
      expect(sent).toEqual([]);
      expect(created).toEqual([]);
      expect(reopened).toEqual([]);
      // Reopened, it stays on its account rather than going to the CLI login's bill.
      const again = await service.onSessionOpen({ agentId: "agent-1", provider: "pi", reason: "refresh", purpose: "interactive", env: {} } as never, { paseo } as never);
      expect(again?.env.PI_CODING_AGENT_DIR).toBe(findAccount(await store.read(), id)?.home);
    } finally {
      await service.stop();
    }
  });

  it("can't disable a Pi account, and deletes a home an add left unsaved before a restart", async () => {
    const store = new StateStore(join(root, "state.json"));
    // An add cut short after its key was written: the home is on the cleanup list, and no account has it.
    const left = join(root, "paseo", "zerosub", "homes", "pi-cccccccccccc");
    await writePiAccountApi(left, { key: KEY, baseUrl: null });
    await store.update((draft) => {
      draft.cleanup[left] = { family: "pi", accountId: "pi-cccccccccccc", why: "unfinished", at: new Date().toISOString() };
    });
    const service = new Service(
      { claude: noClaude("claude"), codex: noClaude("codex"), pi: new InstalledPi() },
      store,
      { resolve: async () => ({ pi: "pi" as const }) } as unknown as FamilyResolver,
      { locate: async () => null } as unknown as Reopener,
    );
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false } }) } };
    service.attach(paseo as never);
    await service.start();
    try {
      await service.cleanUpHomes(paseo as never);
      await expect(stat(left)).rejects.toThrow();
      expect((await store.read()).cleanup).toEqual({});

      const id = await service.addApiAccount({ label: "Work key", key: KEY });
      await expect(service.setAccountEnabled(paseo as never, id, false)).rejects.toThrow(/can't be disabled/);
      expect((await store.read()).accounts.find((account) => account.id === id)?.disabled).toBe(false);

      // Saving without a new key keeps a refused one refused; a new key is tried again.
      await store.update((draft) => {
        const target = draft.accounts.find((account) => account.id === id);
        if (target) target.signedIn = false;
      });
      await service.updateApiAccount(id, {});
      expect((await store.read()).accounts.find((account) => account.id === id)?.signedIn).toBe(false);
      await service.updateApiAccount(id, { key: "sk-ant-api03-qqqqqqqqqqqqqqqqqqqqqqqq-5151" });
      expect((await store.read()).accounts.find((account) => account.id === id)?.signedIn).toBe(true);

      // The same key added twice at once is added once.
      const other = "sk-ant-api03-rrrrrrrrrrrrrrrrrrrrrrrr-6262";
      const both = await Promise.allSettled([service.addApiAccount({ label: "A", key: other }), service.addApiAccount({ label: "B", key: other })]);
      expect(both.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect((await store.read()).accounts.filter((account) => account.label === "A" || account.label === "B")).toHaveLength(1);
      expect((await store.read()).cleanup).toEqual({});
    } finally {
      await service.stop();
    }
  });
});
