import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
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

async function setUp(state: Partial<StoredState>, options: { signedIn?: (home: string | null) => boolean } = {}) {
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
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async () => {
      const login = new FakeLogin();
      logins.push(login);
      return login;
    },
    logout: async (path: string) => void loggedOut.push(path),
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
