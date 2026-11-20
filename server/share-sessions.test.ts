import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import { claudeSessionsShared, shareClaudeSessions } from "./homes";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";
import { absentPi } from "./fakes.test-support";

// An added Claude account keeps its own sessions folder unless the user shares it with the CLI's.

let root: string;
const saved: Record<string, string | undefined> = {};
const VARIABLES = ["PASEO_HOME", "ZEROSUB_LAUNCHER_DIR", "CLAUDE_CONFIG_DIR"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-sessions-"));
  for (const key of VARIABLES) saved[key] = process.env[key];
  process.env.PASEO_HOME = root;
  process.env.ZEROSUB_LAUNCHER_DIR = join(root, "launchers");
  process.env.CLAUDE_CONFIG_DIR = join(root, "main");
});

afterEach(async () => {
  for (const key of VARIABLES) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const paseo = { agents: { list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }) } } as never;

function adapter(family: "claude" | "codex"): FamilyAdapter {
  const base = {
    family,
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async (home: string) => void (await mkdir(home, { recursive: true })),
    env: async () => ({}),
    identity: async () => ({ signedIn: true, email: null, plan: null, organization: null, identity: null }),
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    logout: async () => undefined,
    // A sign-in that waits for the user, and keys kept as given: enough to make a new account's home.
    login: async () => ({ progress: {}, onProgress: () => undefined, submitCode: async () => undefined, cancel: () => undefined, finished: new Promise(() => undefined) }),
    setApi: async () => undefined,
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
  if (family === "claude") {
    base.sessionsShared = claudeSessionsShared;
    base.shareSessions = shareClaudeSessions;
  }
  return base;
}

async function setUp(state: Partial<StoredState>) {
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => Object.assign(draft, state));
  const service = new Service(
    { claude: adapter("claude"), codex: adapter("codex"), pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  return { service };
}

const at = "2026-10-27T00:00:00.000Z";
const main = { id: MAIN_ACCOUNT_ID.claude, family: "claude" as const, label: "CLI", kind: "main" as const, home: null, createdAt: at };
const work = () => ({ id: "claude-work01", family: "claude" as const, label: "Work", kind: "managed" as const, home: join(root, "zerosub", "homes", "claude-work01"), createdAt: at });

describe("an added Claude account's sessions", () => {
  it("are its own until shared, and its own again once unshared", async () => {
    const account = work();
    await mkdir(account.home, { recursive: true });
    const { service } = await setUp({ accounts: [main, account] as never });
    const shown = async () => (await service.view(paseo)).accounts.map((view) => [view.id, view.sessionsShared]);

    expect(await shown()).toEqual([
      [main.id, null],
      [account.id, false],
    ]);
    expect(await service.setSessionsShared(account.id, true)).toBe(true);
    expect((await lstat(join(account.home, "sessions"))).isSymbolicLink()).toBe(true);
    expect(await shown()).toEqual([
      [main.id, null],
      [account.id, true],
    ]);
    expect(await service.setSessionsShared(account.id, false)).toBe(false);
    expect((await lstat(join(account.home, "sessions"))).isDirectory()).toBe(true);
  });

  it("can't be shared for the CLI login or another provider's account", async () => {
    const codex = { id: "codex-work01", family: "codex" as const, label: "Codex", kind: "managed" as const, home: join(root, "codex-work01"), createdAt: at };
    const { service } = await setUp({ accounts: [main, codex] as never });
    await expect(service.setSessionsShared(main.id, true)).rejects.toThrow("only be shared for added Claude accounts");
    await expect(service.setSessionsShared(codex.id, true)).rejects.toThrow("only be shared for added Claude accounts");
    await expect(service.setSessionsShared("claude-gone", true)).rejects.toThrow("no longer exists");
  });
});

describe("a new Claude account's sessions", () => {
  const sessionsOf = (home: string) => lstat(join(home, "sessions")).catch(() => null);

  it("are shared from the start when asked as it signs in, before the CLI starts", async () => {
    const { service } = await setUp({ accounts: [main] as never });
    const shared = await service.startLogin("claude", "code", undefined, undefined, true);
    expect((await sessionsOf(join(root, "zerosub", "homes", `claude-${shared.id}`)))?.isSymbolicLink()).toBe(true);
    const own = await service.startLogin("claude", "code");
    expect((await sessionsOf(join(root, "zerosub", "homes", `claude-${own.id}`)))?.isSymbolicLink() ?? false).toBe(false);
  });

  it("are left as they are when an account signs in again", async () => {
    const account = work();
    await mkdir(account.home, { recursive: true });
    const { service } = await setUp({ accounts: [main, account] as never });
    await service.startLogin("claude", "code", account.id, undefined, true);
    expect(await claudeSessionsShared(account.home)).toBe(false);
  });

  it("are shared from the start for an API key account when asked", async () => {
    const { service } = await setUp({ accounts: [main] as never });
    const shared = await service.addApiAccount({ family: "claude", keyKind: "api_key", label: "Key", key: "sk-ant-one", shareSessions: true });
    const own = await service.addApiAccount({ family: "claude", keyKind: "api_key", label: "Other", key: "sk-ant-two" });
    const view = await service.view(paseo);
    expect(view.accounts.find((entry) => entry.id === shared)?.sessionsShared).toBe(true);
    expect(view.accounts.find((entry) => entry.id === own)?.sessionsShared).toBe(false);
  });

  it("can't be asked for another provider's new account", async () => {
    const { service } = await setUp({ accounts: [main] as never });
    await expect(service.startLogin("codex", "code", undefined, undefined, true)).rejects.toThrow("only be shared for Claude accounts");
  });
});
