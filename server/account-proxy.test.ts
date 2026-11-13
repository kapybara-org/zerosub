import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter, LoginHandle } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";
import { absentPi } from "./fakes.test-support";

let root: string;
let previousHome: string | undefined;
let previousLaunchers: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-proxy-"));
  previousHome = process.env.PASEO_HOME;
  previousLaunchers = process.env.ZEROSUB_LAUNCHER_DIR;
  process.env.ZEROSUB_LAUNCHER_DIR = join(root, "launchers");
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  if (previousLaunchers === undefined) delete process.env.ZEROSUB_LAUNCHER_DIR;
  else process.env.ZEROSUB_LAUNCHER_DIR = previousLaunchers;
  // Retried: a write the test set off in the background can still be landing in it.
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A Claude adapter that records the order of what the service asks of it. */
function recordingAdapter(calls: string[], family: "claude" | "codex" = "claude"): FamilyAdapter {
  const handle: LoginHandle = {
    progress: { step: "waiting", url: "https://claude.ai/oauth", codeUrl: null, userCode: null, message: null },
    onProgress: () => undefined,
    submitCode: async () => undefined,
    cancel: () => undefined,
    finished: new Promise(() => undefined),
  };
  const adapter = {
    family,
    portable: family === "claude",
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async (home: string) => void calls.push(`prepare ${home}`),
    env: async () => ({}),
    identity: async () => ({ signedIn: false, email: null, plan: null, organization: null, identity: null }),
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async (home: string | null) => {
      calls.push(`login ${home}`);
      return handle;
    },
    logout: async () => undefined,
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
  if (family === "claude") {
    // The CLI login's proxy is kept in main's settings, which an added account without one goes through.
    adapter.proxyState = async (home: string | null) =>
      home
        ? { own: null, file: null, inherited: { proxy: "http://me:secret@127.0.0.1:1133", from: "~/.claude/settings.json" }, blocked: null }
        : { own: "http://me:secret@127.0.0.1:1133", file: "~/.claude/settings.json", inherited: null, blocked: "not now" };
    adapter.setProxy = async (home: string | null, proxy: string | null) => void calls.push(`proxy ${home} ${proxy}`);
  }
  return adapter;
}

async function setUp(state: Partial<StoredState> = {}) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => Object.assign(draft, state));
  const calls: string[] = [];
  const service = new Service(
    { claude: recordingAdapter(calls), codex: recordingAdapter(calls, "codex"), pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  return { service, store, calls };
}

function managed(id: string, label: string) {
  return { id, family: "claude" as const, label, kind: "managed" as const, home: join(root, "zerosub", "homes", id), createdAt: "2026-10-27T00:00:00.000Z" };
}

describe("a new account's proxy", () => {
  it("is in place before the CLI starts signing in", async () => {
    const { service, calls } = await setUp();
    const login = await service.startLogin("claude", "code", undefined, " http://127.0.0.1:7890/ ");
    expect(login.step).toBe("waiting");
    const home = join(root, "zerosub", "homes", `claude-${login.id}`);
    expect(calls).toEqual([`proxy ${home} http://127.0.0.1:7890`, `prepare ${home}`, `login ${home}`]);
  });

  it("stops the sign-in before anything starts when it isn't usable", async () => {
    const { service, calls } = await setUp();
    await expect(service.startLogin("claude", "code", undefined, "socks5://127.0.0.1:1080")).rejects.toThrow("socks5");
    expect(calls).toEqual([]);
  });

  it("is left out when signing an existing account back in", async () => {
    const work = managed("claude-work01", "Work");
    const { service, calls } = await setUp({ accounts: [work] as never });
    await service.startLogin("claude", "code", work.id, "http://127.0.0.1:9999");
    expect(calls).toEqual([`prepare ${work.home}`, `login ${work.home}`]);
  });

  it("can't be set for providers without per-account proxies", async () => {
    const { service, calls } = await setUp();
    await expect(service.startLogin("codex", "code", undefined, "http://127.0.0.1:7890")).rejects.toThrow("can't be set");
    expect(calls).toEqual([]);
  });
});

describe("setProxy", () => {
  it("normalizes, masks the password in its answer, and clears with an empty value", async () => {
    const work = managed("claude-work01", "Work");
    const { service, calls } = await setUp({ accounts: [work] as never });
    expect(await service.setProxy(work.id, "http://me:secret@10.0.0.1:3128/")).toBe("http://me:•••@10.0.0.1:3128");
    expect(await service.setProxy(work.id, "  ")).toBeNull();
    expect(calls).toEqual([`proxy ${work.home} http://me:secret@10.0.0.1:3128`, `proxy ${work.home} null`]);
  });

  it("sets the CLI's own login's too, remaking the added homes when it's kept in main's settings", async () => {
    const main = { id: MAIN_ACCOUNT_ID.claude, family: "claude" as const, label: "CLI", kind: "main" as const, home: null, createdAt: "2026-10-27T00:00:00.000Z" };
    const work = managed("claude-work01", "Work");
    const { service, calls } = await setUp({ accounts: [main, work] as never });
    expect(await service.setProxy(main.id, "http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
    await vi.waitFor(() => expect(calls).toEqual(["proxy null http://127.0.0.1:7890", `prepare ${work.home}`]));
  });

  it("can't be set for providers without per-account proxies", async () => {
    const main = { id: MAIN_ACCOUNT_ID.codex, family: "codex" as const, label: "CLI", kind: "main" as const, home: null, createdAt: "2026-10-27T00:00:00.000Z" };
    const { service, calls } = await setUp({ accounts: [main] as never });
    await expect(service.setProxy(main.id, "http://127.0.0.1:7890")).rejects.toThrow("only be set for Claude and Pi accounts");
    expect(calls).toEqual([]);
  });
});

describe("the accounts' proxies, as the app shows them", () => {
  it("give each its own, the one it goes through otherwise, and why one can't be set, passwords hidden", async () => {
    const main = { id: MAIN_ACCOUNT_ID.claude, family: "claude" as const, label: "CLI", kind: "main" as const, home: null, createdAt: "2026-10-27T00:00:00.000Z" };
    const work = managed("claude-work01", "Work");
    const { service } = await setUp({ accounts: [main, work] as never });
    const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) } } as never;
    const accounts = (await service.view(paseo)).accounts;
    expect(accounts.find((account) => account.id === main.id)).toMatchObject({
      proxy: "http://me:•••@127.0.0.1:1133",
      proxyEditable: true,
      inheritedProxy: null,
      proxyBlocked: "not now",
      proxyFile: "~/.claude/settings.json",
      proxyFollowers: ["Work"],
    });
    expect(accounts.find((account) => account.id === work.id)).toMatchObject({
      proxy: null,
      proxyEditable: true,
      inheritedProxy: { proxy: "http://me:•••@127.0.0.1:1133", from: "~/.claude/settings.json" },
      proxyBlocked: null,
      proxyFile: null,
      proxyFollowers: [],
    });
  });
});

describe("shell launchers", () => {
  it("follow the accounts' names", async () => {
    const work = managed("claude-work01", "Work");
    const { service } = await setUp({ accounts: [work] as never });
    await service.rename(work.id, "Personal");
    const directory = join(root, "launchers");
    expect(await readdir(directory)).toEqual(["claude-personal.sh"]);
    expect(await readFile(join(directory, "claude-personal.sh"), "utf8")).toContain(`export CLAUDE_CONFIG_DIR='${work.home}'`);
  });
});
