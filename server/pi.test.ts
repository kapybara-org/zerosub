import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FamilyAdapter, TurnEvent } from "./adapter";
import { absentPi } from "./fakes.test-support";
import { familiesFromConfig, type FamilyResolver } from "./families";
import { piAuth, piModels, preparePiHome, readPiAccount, readPiAccountApi, writePiAccountApi, writePiAccountProxy } from "./homes";
import { detectPiSignOut } from "./limits";
import { PiAdapter, piSessionDir } from "./pi";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

const KEY = "sk-ant-api03-pppppppppppppppppppppppp-4242";
const SAVED = ["PASEO_HOME", "ZEROSUB_LAUNCHER_DIR", "ZEROSUB_PI_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "NO_PROXY", "no_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

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
  process.env.ZEROSUB_LAUNCHER_DIR = join(root, "launchers");
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

  it("leaves the sessions folder alone where it's set already, and an account without a proxy goes through the CLI login's", async () => {
    await writeFile(join(main, "settings.json"), JSON.stringify({ sessionDir: "/somewhere", httpProxy: "http://10.0.0.1:3128" }));
    const home = join(root, "home");
    await writePiAccountApi(home, { key: KEY, baseUrl: null });
    const adapter = new PiAdapter();
    const env = await adapter.env(home, { cwd: "/work" });
    expect(env.PI_CODING_AGENT_SESSION_DIR).toBeUndefined();
    expect(env).toMatchObject({ PI_CODING_AGENT_DIR: home, HTTPS_PROXY: "http://10.0.0.1:3128", https_proxy: "http://10.0.0.1:3128" });
    expect(await adapter.proxyState(home)).toEqual({
      own: null,
      file: null,
      inherited: { proxy: "http://10.0.0.1:3128", from: expect.stringContaining("the CLI login (httpProxy in") },
    });
  });

  it("keeps the CLI login's proxy as httpProxy in Pi's own settings, keeping the rest and a copy as it was", async () => {
    const adapter = new PiAdapter();
    expect(await adapter.env(null)).toEqual({ PI_CODING_AGENT_DIR: null });
    expect((await adapter.proxyState(null)).own).toBeNull();

    await adapter.setProxy(null, "http://127.0.0.1:7890");
    expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic", httpProxy: "http://127.0.0.1:7890" });
    expect((await readdir(join(root, "paseo", "zerosub", "backups"))).filter((name) => name.startsWith("pi-settings-"))).toHaveLength(1);
    expect(await adapter.env(null)).toMatchObject({ PI_CODING_AGENT_DIR: null, HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost,127.0.0.1,::1" });
    expect(await adapter.proxyState(null)).toMatchObject({ own: "http://127.0.0.1:7890", file: expect.stringContaining("settings.json"), inherited: null });

    await adapter.setProxy(null, null);
    expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic" });
    expect(await adapter.env(null)).toEqual({ PI_CODING_AGENT_DIR: null });
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

    // Main's settings changing reach it at the next sync, and a sync doesn't link it back.
    await writeFile(join(main, "settings.json"), JSON.stringify({ defaultProvider: "openai" }));
    await preparePiHome(home, true);
    expect(JSON.parse(await readFile(join(home, "settings.json"), "utf8"))).toEqual({ defaultProvider: "openai", httpProxy: "http://u:p@127.0.0.1:7890" });

    await writePiAccountProxy(home, null);
    expect(await readlink(join(home, "settings.json"))).toBe(await realpath(join(main, "settings.json")));
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

  it("is set in Pi's own files, keeping everything else and a copy of each as it was", async () => {
    await writeFile(join(main, "models.json"), JSON.stringify({ providers: { ollama: { baseUrl: "http://localhost" } } }));
    const adapter = new PiAdapter();
    expect(await adapter.api(null)).toMatchObject({ keyHint: "", baseUrl: null });

    await adapter.setApi(null, { key: KEY, baseUrl: "https://gw.example.com/" });
    const auth = JSON.parse(await readFile(join(main, "auth.json"), "utf8"));
    expect(auth.anthropic).toEqual({ type: "api_key", key: KEY });
    expect(auth.openrouter).toEqual({ type: "api_key", key: "sk-or" });
    expect(auth.openai).toMatchObject({ type: "oauth" });
    expect(JSON.parse(await readFile(join(main, "models.json"), "utf8"))).toEqual({
      providers: { ollama: { baseUrl: "http://localhost" }, anthropic: { baseUrl: "https://gw.example.com" } },
    });
    expect(await adapter.api(null)).toMatchObject({ keyHint: "4242", baseUrl: "https://gw.example.com" });
    const backups = await readdir(join(root, "paseo", "zerosub", "backups"));
    expect(backups.filter((name) => name.startsWith("pi-auth-"))).toHaveLength(1);
    expect(backups.filter((name) => name.startsWith("pi-models-"))).toHaveLength(1);

    // A kept key only goes where it went before; back to Anthropic's own API with it typed again.
    await expect(adapter.setApi(null, { key: null, baseUrl: null })).rejects.toThrow(/Enter the key again/);
    await adapter.setApi(null, { key: KEY, baseUrl: null });
    expect(JSON.parse(await readFile(join(main, "models.json"), "utf8"))).toEqual({ providers: { ollama: { baseUrl: "http://localhost" } } });
  });

  it("finds the sessions folder Pi names after the project's real path", async () => {
    const real = join(root, "real-project");
    await mkdir(real);
    const { symlink } = await import("node:fs/promises");
    await symlink(real, join(root, "linked-project"));
    const expected = join(main, "sessions", `--${(await realpath(real)).replace(/^\//, "").replace(/\//g, "-")}--`);
    expect(await piSessionDir(join(root, "linked-project"))).toBe(expected);
    expect(await piSessionDir("/no/such/folder")).toBe(join(main, "sessions", "--no-such-folder--"));
  });

  it("waits for Pi's own lock on its sign-ins", async () => {
    await mkdir(join(main, "auth.json.lock"));
    await expect(new PiAdapter().setApi(null, { key: KEY, baseUrl: null })).rejects.toThrow(/Pi is writing/);
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
  override async available() {
    return { ok: true, detail: null };
  }
  override async egress() {
    return null;
  }
  // Tests never list the machine's processes.
  override async homesInUse() {
    return new Set<string>();
  }
}

function noClaude(family: "claude" | "codex"): FamilyAdapter {
  return { ...absentPi(), family } as FamilyAdapter;
}

describe("Pi accounts in the service", () => {
  it("adds a Pi API account with its proxy, and routes a Pi agent on it to its own directory", async () => {
    const store = new StateStore(join(root, "state.json"));
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
      expect((await store.read()).accounts.map((account) => [account.id, account.label])).toEqual([[MAIN_ACCOUNT_ID.pi, "Pi (CLI login)"]]);
      await expect(service.startLogin("pi", "browser")).rejects.toThrow(/API key/);

      const id = await service.addApiAccount({ label: "Work key", key: KEY, proxy: "http://127.0.0.1:7890" });
      expect(id).toMatch(/^pi-[0-9a-f]{12}$/);
      // Set up in homes/, then kept beside its script in ~/.pi-config (ZEROSUB_PI_DIR here).
      const home = join(root, "pi-config", "pi-work-key");
      await expect(stat(join(root, "paseo", "zerosub", "homes", id))).rejects.toThrow();
      const script = await readFile(join(root, "pi-config", "pi-work-key.sh"), "utf8");
      expect(script).toContain(`export PI_CODING_AGENT_DIR='${home}'`);
      expect(script).toContain('. "$PI_CODING_AGENT_DIR/zerosub.env"');
      expect(script).toContain('exec pi "$@"');
      const launchEnv = await readFile(join(home, "zerosub.env"), "utf8");
      expect(launchEnv).toContain("export https_proxy='http://127.0.0.1:7890'");
      expect(launchEnv).toContain("export NO_PROXY='localhost,127.0.0.1,::1'");
      expect((await stat(join(home, "zerosub.env"))).mode & 0o777).toBe(0o600);
      expect(JSON.stringify(await store.read())).not.toContain(KEY);
      expect((await store.read()).accounts.find((account) => account.id === id)).toMatchObject({ family: "pi", auth: "api", home, label: "Work key" });
      await expect(service.addApiAccount({ label: "Again", key: KEY })).rejects.toThrow(/already added/);

      const view = await service.view(paseo as never);
      const card = view.accounts.find((account) => account.id === id);
      expect(card).toMatchObject({ proxy: "http://127.0.0.1:7890", proxyEditable: true, apiEditable: true, api: { keyHint: "4242", baseUrl: null } });
      // Pi's own login shows the Anthropic key it keeps, and can change it.
      expect(view.accounts.find((account) => account.id === MAIN_ACCOUNT_ID.pi)).toMatchObject({ apiEditable: true, api: { keyHint: "" } });
      expect(view.warnings).toEqual(expect.not.arrayContaining([expect.stringContaining("Pi isn't installed")]));

      await service.setDefault(paseo as never, id);
      const opened = await service.onSessionOpen(
        { agentId: "agent-1", provider: "pi", cwd: "/work", reason: "create", purpose: "interactive", env: {} } as never,
        { paseo } as never,
      );
      expect(opened?.env).toMatchObject({
        PI_CODING_AGENT_DIR: home,
        PI_CODING_AGENT_SESSION_DIR: join(main, "sessions", "--work--"),
        HTTPS_PROXY: "http://127.0.0.1:7890",
      });
      expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).anthropic).toEqual({ type: "api_key", key: KEY });

      await service.setProxy(id, "");
      const plain = await service.onSessionOpen({ agentId: "agent-1", provider: "pi", reason: "refresh", purpose: "interactive", env: {} } as never, { paseo } as never);
      expect(plain?.env.HTTPS_PROXY).toBeUndefined();
      expect(await readFile(join(home, "zerosub.env"), "utf8")).not.toContain("export");

      // Kept outside homes/, removing it only unregisters it: its folder, key and script stay.
      await service.remove(paseo as never, id);
      expect((await store.read()).accounts.some((account) => account.id === id)).toBe(false);
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
});
