import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FamilyAdapter, TurnEvent } from "./adapter";
import { absentPi } from "./fakes.test-support";
import { familiesFromConfig, type FamilyResolver } from "./families";
import { piAuth, piModels, preparePiHome, readPiAccount, readPiAccountApi, sentInTheClear, writePiAccountApi, writePiAccountProxy } from "./homes";
import { detectPiSignOut } from "./limits";
import { PiAdapter, piSessionDir } from "./pi";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

const KEY = "sk-ant-api03-pppppppppppppppppppppppp-4242";
const SAVED = ["PASEO_HOME", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "NO_PROXY", "no_proxy", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"] as const;

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
    // Pi applies httpProxy from the settings it shares; ZeroSub adds nothing over it.
    expect(env).toEqual({ PI_CODING_AGENT_DIR: home });
    expect(await adapter.proxyState(home)).toEqual({
      own: null,
      inherited: { proxy: "http://10.0.0.1:3128", from: expect.stringContaining("httpProxy in") },
    });
  });

  it("leaves the CLI login as Paseo runs it without ZeroSub", async () => {
    await writeFile(join(main, "settings.json"), JSON.stringify({ defaultProvider: "anthropic", httpProxy: "http://10.0.0.1:3128" }));
    expect(await new PiAdapter().env(null, { cwd: "/work" })).toEqual({});
  });

  it("keeps an added account's proxy in its own zerosub.json, and its settings linked to the CLI login's", async () => {
    const home = join(root, "paseo", "zerosub", "homes", "pi-bbbbbbbbbbbb");
    await writePiAccountApi(home, { key: KEY, baseUrl: null });
    await preparePiHome(home, true);
    await writePiAccountProxy(home, "http://u:p@127.0.0.1:7890");
    await preparePiHome(home, true);
    expect(await readlink(join(home, "settings.json"))).toBe(await realpath(join(main, "settings.json")));
    expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic" });
    expect((await readPiAccount(home)).proxy).toBe("http://u:p@127.0.0.1:7890");
  });

  it("counts an added account signed in while it has a key, and the CLI login always", async () => {
    const adapter = new PiAdapter();
    expect((await adapter.identity(null)).signedIn).toBe(true);
    expect((await adapter.identity(join(root, "empty"))).signedIn).toBe(false);
    await writePiAccountApi(join(root, "home"), { key: KEY, baseUrl: null });
    expect((await adapter.identity(join(root, "home"))).signedIn).toBe(true);
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
  override async available() {
    return { ok: true, detail: null };
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
      const home = join(root, "paseo", "zerosub", "homes", id);
      expect(JSON.parse(await readFile(join(home, "auth.json"), "utf8")).anthropic).toEqual({ type: "api_key", key: KEY });
      expect(JSON.stringify(await store.read())).not.toContain(KEY);
      expect(await store.read()).toMatchObject({ cleanup: {} });
      expect((await store.read()).accounts.find((account) => account.id === id)).toMatchObject({ family: "pi", auth: "api", home, label: "Work key" });
      await expect(service.addApiAccount({ label: "Again", key: KEY })).rejects.toThrow(/already added/);

      const view = await service.view(paseo as never);
      const card = view.accounts.find((account) => account.id === id);
      expect(card).toMatchObject({ proxy: "http://127.0.0.1:7890", proxyEditable: true, apiEditable: true, api: { keyHint: "4242", baseUrl: null } });
      // The CLI login is Pi's own, which ZeroSub leaves alone.
      expect(view.accounts.find((account) => account.id === MAIN_ACCOUNT_ID.pi)).toMatchObject({ apiEditable: false, proxyEditable: false, api: null });
      await expect(service.setProxy(MAIN_ACCOUNT_ID.pi, "http://127.0.0.1:7890")).rejects.toThrow(/added Pi accounts/);
      await expect(service.updateApiAccount(MAIN_ACCOUNT_ID.pi, { key: KEY })).rejects.toThrow(/subscription/);
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

      await service.setProxy(id, "");
      const plain = await service.onSessionOpen({ agentId: "agent-1", provider: "pi", reason: "refresh", purpose: "interactive", env: {} } as never, { paseo } as never);
      expect(plain?.env.HTTPS_PROXY).toBeUndefined();

      // Pi's own files are never written.
      expect(JSON.parse(await readFile(join(main, "settings.json"), "utf8"))).toEqual({ defaultProvider: "anthropic" });
      expect(JSON.parse(await readFile(join(main, "auth.json"), "utf8")).anthropic).toEqual({ type: "api_key", key: "sk-main" });
      await expect(stat(join(main, "models.json"))).rejects.toThrow();

      // Removing it puts its home on the cleanup list, and the cleanup pass deletes it.
      await service.remove(paseo as never, id);
      expect((await store.read()).accounts.some((account) => account.id === id)).toBe(false);
      await service.cleanUpHomes(paseo as never);
      await expect(stat(home)).rejects.toThrow();
      expect((await store.read()).cleanup).toEqual({});
    } finally {
      await service.stop();
    }
  });

  it("leaves an agent whose key was refused where it is, without moving it to the CLI login or continuing it", async () => {
    const store = new StateStore(join(root, "state.json"));
    const service = new Service(
      { claude: noClaude("claude"), codex: noClaude("codex"), pi: new InstalledPi() },
      store,
      { resolve: async () => ({ pi: "pi" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo", reopen: async (agentId: string) => (reopened.push(agentId), { ok: true as const }) } as unknown as Reopener,
    );
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
      expect(again?.env.PI_CODING_AGENT_DIR).toBe(join(root, "paseo", "zerosub", "homes", id));
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
