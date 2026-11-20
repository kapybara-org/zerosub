import { mkdir, mkdtemp, readdir, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter, LoginHandle } from "./adapter";
import type { FamilyResolver } from "./families";
import { ProgressEmitter } from "./adapter";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore, type StoredState } from "./state";
import { absentPi } from "./fakes.test-support";

let root: string;
let previousHome: string | undefined;
/** The services the current test made, stopped once it ends. */
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-cleanup-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  // Stopping saves a pending reading now, while PASEO_HOME is still this test's folder.
  await Promise.all(services.splice(0).map((service) => service.stop()));
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const homes = () => join(root, "zerosub", "homes");
const home = (name: string) => join(homes(), name);
const exists = (path: string) => stat(path).then(() => true, () => false);

/** A sign-in that ends however the test says. */
class FakeLogin extends ProgressEmitter implements LoginHandle {
  finish!: (result: { ok: boolean; message: string | null }) => void;
  readonly finished = new Promise<{ ok: boolean; message: string | null }>((resolve) => (this.finish = resolve));
  async submitCode(): Promise<void> {}
  cancel(): void {
    this.finish({ ok: false, message: "canceled" });
  }
}

async function setUp(state: Partial<StoredState>, options: { signedIn?: (home: string | null) => boolean; apiKey?: (home: string) => boolean; signingOut?: (store: StateStore) => Promise<void> } = {}) {
  const store = new StateStore(join(root, "zerosub", "state.json"));
  await store.update((draft) => Object.assign(draft, state));
  const loggedOut: string[] = [];
  const logins: FakeLogin[] = [];
  const adapter: FamilyAdapter = {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async (path: string) => void (await mkdir(path, { recursive: true })),
    env: async () => ({}),
    identity: async (path: string | null) => ({ signedIn: options.signedIn?.(path) ?? false, email: null, plan: null, organization: null, identity: null }),
    api: async (path: string | null) => (path && options.apiKey?.(path) ? { keyHint: "abcd", baseUrl: null } : null),
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      const login = new FakeLogin();
      logins.push(login);
      return login;
    },
    logout: async (path: string) => {
      loggedOut.push(path);
      await options.signingOut?.(store);
    },
    detectLimit: () => null,
    detectSignOut: () => null,
  };
  const paseo = {
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({ refresh: async () => null }),
    },
  };
  const service = new Service(
    { claude: adapter, codex: { ...adapter, family: "codex" }, pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  services.push(service);
  return { service, store, loggedOut, logins, paseo: paseo as never };
}

const account = (id: string) => ({ id, family: "claude" as const, label: id, kind: "managed" as const, home: home(id), createdAt: "2026-10-01T00:00:00Z" });

describe("cleaning up homes", () => {
  it("never signs out or deletes a home just because the registry doesn't list its account", async () => {
    await mkdir(home("claude-aaaaaaaaaaaa"), { recursive: true });
    // A damaged or hand-edited registry that lost the account.
    const { service, loggedOut, paseo } = await setUp({ accounts: [] });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await service.cleanUpHomes(paseo);
    expect(loggedOut).toEqual([]);
    expect(await exists(home("claude-aaaaaaaaaaaa"))).toBe(true);
    expect(await service.strayHomes()).toEqual(["claude-aaaaaaaaaaaa"]);
    errors.mockRestore();
  });

  it("signs out and deletes a removed account's home", async () => {
    await mkdir(home("claude-aaaaaaaaaaaa"), { recursive: true });
    const { service, store, loggedOut, paseo } = await setUp({ accounts: [account("claude-aaaaaaaaaaaa")] as never });
    await service.remove(paseo, "claude-aaaaaaaaaaaa");
    await service.cleanUpHomes(paseo);
    expect(loggedOut).toEqual([home("claude-aaaaaaaaaaaa")]);
    expect(await exists(home("claude-aaaaaaaaaaaa"))).toBe(false);
    expect((await store.read()).cleanup).toEqual({});
  });

  it.each([
    ["an account uses it again", (draft: StoredState): void => void draft.accounts.push(account("claude-aaaaaaaaaaaa") as never)],
    ["its entry is gone", (draft: StoredState): void => void delete draft.cleanup[home("claude-aaaaaaaaaaaa")]],
  ] as const)("never signs out or deletes a home when, while it waited, %s", async (_, change) => {
    await mkdir(home("claude-aaaaaaaaaaaa"), { recursive: true });
    const { service, store, loggedOut } = await setUp({
      cleanup: { [home("claude-aaaaaaaaaaaa")]: { family: "claude", accountId: "claude-aaaaaaaaaaaa", why: "removed", at: "x" } },
      sessions: { "agent-1": { accountId: "claude-aaaaaaaaaaaa", family: "claude", openedAt: "x" } } as never,
    });
    // Asking Paseo whether the account's last agent still runs takes a while; the registry changes meanwhile.
    const paseo = {
      agents: {
        list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
        ref: () => ({
          refresh: async (): Promise<null> => {
            await store.update(change);
            return null;
          },
        }),
      },
    };
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await service.cleanUpHomes(paseo as never);
    expect(loggedOut).toEqual([]);
    expect(await exists(home("claude-aaaaaaaaaaaa"))).toBe(true);
  });

  it("never deletes a home an account uses again by the time it's signed out", async () => {
    await mkdir(home("claude-aaaaaaaaaaaa"), { recursive: true });
    const { service, store, paseo } = await setUp(
      { cleanup: { [home("claude-aaaaaaaaaaaa")]: { family: "claude", accountId: "claude-aaaaaaaaaaaa", why: "removed", at: "x" } } },
      {
        signingOut: async (store) => {
          await store.update((draft) => void draft.accounts.push(account("claude-aaaaaaaaaaaa") as never));
        },
      },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await service.cleanUpHomes(paseo);
    expect(await exists(home("claude-aaaaaaaaaaaa"))).toBe(true);
    expect((await store.read()).cleanup).toEqual({});
  });

  it("never signs out or deletes a listed path that isn't one of its own homes", async () => {
    const elsewhere = join(root, "elsewhere", "claude-aaaaaaaaaaaa");
    const victim = join(root, "zerosub", "victim");
    await mkdir(elsewhere, { recursive: true });
    await mkdir(victim, { recursive: true });
    await mkdir(home("claude-bbbbbbbbbbbb"), { recursive: true });
    // Starts with the homes folder, but resolves to `zerosub/victim`.
    const traversal = [home("claude-bbbbbbbbbbbb"), "..", "..", "victim"].join(sep);
    const removed = (accountId: string) => ({ family: "claude" as const, accountId, why: "removed" as const, at: "x" });
    const { service, store, loggedOut, paseo } = await setUp({
      cleanup: { [elsewhere]: removed("claude-aaaaaaaaaaaa"), [traversal]: removed("claude-bbbbbbbbbbbb") },
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await service.cleanUpHomes(paseo);
    expect(loggedOut).toEqual([]);
    expect(await exists(elsewhere)).toBe(true);
    expect(await exists(victim)).toBe(true);
    expect((await store.read()).cleanup).toEqual({});
    errors.mockRestore();
  });

  describe("a removed account's folder kept outside homes/", () => {
    const outside = () => join(root, "elsewhere", "claude-work");
    const kept = () => ({ ...account("claude-aaaaaaaaaaaa"), home: outside() });

    it("stays signed in unless the user asks to sign it out", async () => {
      await mkdir(outside(), { recursive: true });
      const { service, store, loggedOut, paseo } = await setUp({ accounts: [kept()] as never });
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await service.remove(paseo, "claude-aaaaaaaaaaaa");
      await service.cleanUpHomes(paseo);
      expect(loggedOut).toEqual([]);
      expect(await exists(outside())).toBe(true);
      expect((await store.read()).cleanup).toEqual({});
    });

    it("is signed out when asked, and never deleted", async () => {
      await mkdir(outside(), { recursive: true });
      const { service, store, loggedOut, paseo } = await setUp({ accounts: [kept()] as never });
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await service.remove(paseo, "claude-aaaaaaaaaaaa", true);
      expect((await store.read()).cleanup[outside()]).toMatchObject({ why: "removed", signOutOnly: true });
      await service.cleanUpHomes(paseo);
      expect(loggedOut).toEqual([outside()]);
      expect(await exists(outside())).toBe(true);
      expect((await store.read()).cleanup).toEqual({});
    });

    it("keeps its folder even once signing out keeps failing", async () => {
      await mkdir(outside(), { recursive: true });
      const { service, store, paseo } = await setUp({ accounts: [kept()] as never }, { signingOut: async () => Promise.reject(new Error("no network")) });
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await service.remove(paseo, "claude-aaaaaaaaaaaa", true);
      for (let pass = 0; pass < 5; pass++) await service.cleanUpHomes(paseo);
      expect(await exists(outside())).toBe(true);
      expect((await store.read()).cleanup).toEqual({});
    });

    it("gives up, keeping its folder, when it still reads as signed in after signing out", async () => {
      await mkdir(outside(), { recursive: true });
      // `claude auth logout` failing on Linux, say, without throwing.
      const { service, store, loggedOut, paseo } = await setUp({ accounts: [kept()] as never }, { signedIn: () => true });
      const logs = vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      await service.remove(paseo, "claude-aaaaaaaaaaaa", true);
      for (let pass = 0; pass < 2; pass++) await service.cleanUpHomes(paseo);
      expect((await store.read()).cleanup[outside()]).toMatchObject({ signOutOnly: true });
      expect(logs.mock.calls.flat().join("\n")).not.toContain(`signed out ${outside()}`);
      await service.cleanUpHomes(paseo);
      expect(loggedOut).toEqual([outside(), outside(), outside()]);
      expect(logs.mock.calls.flat().join("\n")).toContain(`gave up signing out ${outside()}, so its sign-in may still be valid; its folder stays`);
      expect(await exists(outside())).toBe(true);
      expect((await store.read()).cleanup).toEqual({});
    });

    it("records nothing to sign out for a Claude API account, whose key is in the folder", async () => {
      await mkdir(outside(), { recursive: true });
      const { service, store, loggedOut, paseo } = await setUp({ accounts: [{ ...kept(), auth: "api" }] as never });
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      await service.remove(paseo, "claude-aaaaaaaaaaaa", true);
      expect((await store.read()).cleanup).toEqual({});
      await service.cleanUpHomes(paseo);
      expect(loggedOut).toEqual([]);
      expect(await exists(outside())).toBe(true);
    });

    it("never signs out a CLI's own login through a link to it", async () => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      const cli = join(root, "cli-claude");
      const link = join(root, "elsewhere", "claude-link");
      process.env.CLAUDE_CONFIG_DIR = cli;
      try {
        await mkdir(cli, { recursive: true });
        await mkdir(join(root, "elsewhere"), { recursive: true });
        await symlink(cli, link);
        // Removed with "Also sign it out": nothing is recorded.
        const { service, store, loggedOut, paseo } = await setUp({ accounts: [{ ...kept(), home: link }] as never });
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        await service.remove(paseo, "claude-aaaaaaaaaaaa", true);
        expect((await store.read()).cleanup).toEqual({});
        // Listed anyway (a hand edit, say): the entry is dropped.
        await store.update((draft) => {
          draft.cleanup[link] = { family: "claude", accountId: "claude-aaaaaaaaaaaa", why: "removed", at: "x", signOutOnly: true };
        });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await service.cleanUpHomes(paseo);
        expect(loggedOut).toEqual([]);
        expect(await exists(cli)).toBe(true);
        expect((await store.read()).cleanup).toEqual({});
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });

    it("never signs out a CLI's own login, even listed to be", async () => {
      const previous = process.env.CLAUDE_CONFIG_DIR;
      const cli = join(root, "cli-claude");
      process.env.CLAUDE_CONFIG_DIR = cli;
      try {
        await mkdir(cli, { recursive: true });
        const { service, store, loggedOut, paseo } = await setUp({
          cleanup: { [cli]: { family: "claude", accountId: "claude-aaaaaaaaaaaa", why: "removed", at: "x", signOutOnly: true } },
        });
        vi.spyOn(console, "error").mockImplementation(() => undefined);
        await service.cleanUpHomes(paseo);
        expect(loggedOut).toEqual([]);
        expect(await exists(cli)).toBe(true);
        expect((await store.read()).cleanup).toEqual({});
      } finally {
        if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = previous;
      }
    });
  });

  it("drops the entry, signing nothing out, once an account uses the home again", async () => {
    await mkdir(home("claude-aaaaaaaaaaaa"), { recursive: true });
    const { service, store, loggedOut, paseo } = await setUp({
      accounts: [account("claude-aaaaaaaaaaaa")] as never,
      cleanup: { [home("claude-aaaaaaaaaaaa")]: { family: "claude", accountId: "claude-aaaaaaaaaaaa", why: "removed", at: "x" } },
    });
    await service.cleanUpHomes(paseo);
    expect(loggedOut).toEqual([]);
    expect((await store.read()).cleanup).toEqual({});
  });

  it("deletes an earlier run's unfinished sign-in only when it isn't signed in", async () => {
    await mkdir(home("claude-aaaaaaaaaaaa"), { recursive: true });
    await mkdir(home("claude-bbbbbbbbbbbb"), { recursive: true });
    const unfinished = (id: string) => ({ family: "claude" as const, accountId: id, why: "unfinished" as const, at: "x" });
    const { service, store, loggedOut, paseo } = await setUp(
      {
        cleanup: {
          [home("claude-aaaaaaaaaaaa")]: unfinished("claude-aaaaaaaaaaaa"),
          [home("claude-bbbbbbbbbbbb")]: unfinished("claude-bbbbbbbbbbbb"),
        },
      },
      { signedIn: (path) => path === home("claude-bbbbbbbbbbbb") },
    );
    await service.cleanUpHomes(paseo);
    expect(loggedOut).toEqual([]);
    expect(await exists(home("claude-aaaaaaaaaaaa"))).toBe(false);
    // Signed in: it may be an account the registry lost, so it stays.
    expect(await exists(home("claude-bbbbbbbbbbbb"))).toBe(true);
    expect((await store.read()).cleanup).toEqual({});
  });

  it("deletes an earlier run's unfinished API account, key and all, though Claude Code calls a key signed in", async () => {
    await mkdir(home("claude-cccccccccccc"), { recursive: true });
    const { service, store, paseo } = await setUp(
      { cleanup: { [home("claude-cccccccccccc")]: { family: "claude", accountId: "claude-cccccccccccc", why: "unfinished", at: "x" } } },
      { signedIn: () => true, apiKey: (path) => path === home("claude-cccccccccccc") },
    );
    await service.cleanUpHomes(paseo);
    // Saved, its entry would have gone in the same write: it never became an account.
    expect(await exists(home("claude-cccccccccccc"))).toBe(false);
    expect((await store.read()).cleanup).toEqual({});
  });

  it("lists a new sign-in for cleanup until its account is saved, and cleans up one that failed", async () => {
    let signedIn = false;
    const { service, store, logins, loggedOut, paseo } = await setUp({}, { signedIn: () => signedIn });
    service.attach(paseo);
    const first = await service.startLogin("claude", "browser");
    const firstHome = Object.keys((await store.read()).cleanup)[0]!;
    expect((await store.read()).cleanup[firstHome]).toMatchObject({ why: "unfinished", accountId: `claude-${first.id}` });
    logins[0]!.finish({ ok: false, message: "nope" });
    await vi.waitFor(async () => expect((await service.view(paseo)).logins[0]?.step).toBe("failed"));
    // Cleanup leaves a sign-in alone for a moment after it ends.
    await new Promise((resolve) => setTimeout(resolve, 3_100));
    await service.cleanUpHomes(paseo);
    expect(loggedOut).toEqual([firstHome]);
    expect(await readdir(homes())).toEqual([]);

    await service.startLogin("claude", "browser");
    const secondHome = Object.keys((await store.read()).cleanup)[0]!;
    signedIn = true;
    logins[1]!.finish({ ok: true, message: null });
    // Signed in fine: the account is saved and its home is off the list.
    await vi.waitFor(async () => expect((await store.read()).accounts.some((entry) => entry.home === secondHome)).toBe(true));
    expect((await store.read()).cleanup).toEqual({});
  }, 15_000);
});
