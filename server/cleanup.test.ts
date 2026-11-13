import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter, Identity, LoginHandle } from "./adapter";
import type { FamilyResolver } from "./families";
import { renderLauncher } from "./launchers";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";
import { absentPi } from "./fakes.test-support";

let root: string;
let previousHome: string | undefined;
let previousLaunchers: string | undefined;
/** The services the current test made, stopped once it ends. */
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-cleanup-"));
  previousHome = process.env.PASEO_HOME;
  previousLaunchers = process.env.ZEROSUB_LAUNCHER_DIR;
  process.env.ZEROSUB_LAUNCHER_DIR = join(root, "launchers");
  process.env.PASEO_HOME = root; // the registry, its backups and the homes all land here
});

afterEach(async () => {
  // Stopping saves a pending reading now, while PASEO_HOME is still this test's folder.
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  if (previousLaunchers === undefined) delete process.env.ZEROSUB_LAUNCHER_DIR;
  else process.env.ZEROSUB_LAUNCHER_DIR = previousLaunchers;
  // Retried: a write the test set off in the background can still be landing in it.
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const homes = () => join(root, "zerosub", "homes");
const statePath = () => join(root, "zerosub", "state.json");

interface Fake {
  calls: string[];
  /** Which homes `identity` reports as signed in. */
  signedIn: Set<string>;
  /** `logout` throws while this is set. */
  failLogout: boolean;
  /** Settles the sign-in in progress. */
  finish: (result: { ok: boolean; message: string | null }) => void;
}

/** A Claude adapter that records what it's asked to do, and makes homes as the real one does. */
function fakeAdapter(fake: Fake): FamilyAdapter {
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async (home: string) => {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "settings.account.json"), "{}");
    },
    env: async () => ({}),
    identity: async (home: string | null): Promise<Identity> => {
      fake.calls.push(`identity ${home}`);
      const signedIn = home !== null && fake.signedIn.has(home);
      return { signedIn, email: signedIn ? "new@example.com" : null, plan: null, organization: null, identity: signedIn ? "personal|new@example.com" : null };
    },
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async (): Promise<LoginHandle> => ({
      progress: { step: "waiting", url: "https://claude.ai/oauth", codeUrl: null, userCode: null, message: null },
      onProgress: () => undefined,
      submitCode: async () => undefined,
      cancel: () => undefined,
      finished: new Promise((resolve) => {
        fake.finish = resolve;
      }),
    }),
    logout: async (home: string) => {
      fake.calls.push(`logout ${home}`);
      if (fake.failLogout) throw new Error("claude is not installed");
    },
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

/** Paseo, with agents in the given states. */
function fakePaseo(statuses: Record<string, string> = {}) {
  return {
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () =>
          statuses[id] ? { agent: { id, provider: "claude", status: statuses[id], archivedAt: null, lastUserMessageAt: null } } : null,
      }),
    },
  } as never;
}

/** A service on the registry in `$PASEO_HOME`, as the plugin makes it on (re)start. */
function start(fake: Fake = newFake()) {
  const store = new StateStore();
  const adapter = fakeAdapter(fake);
  const service = new Service(
    { claude: adapter, codex: adapter, pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  services.push(service);
  return { service, store, fake };
}

function newFake(): Fake {
  return { calls: [], signedIn: new Set(), failLogout: false, finish: () => undefined };
}

function managed(id: string, home: string) {
  return { id, family: "claude" as const, label: id, kind: "managed" as const, home, createdAt: "2026-10-27T00:00:00.000Z" };
}

const main = { id: MAIN_ACCOUNT_ID.claude, family: "claude" as const, label: "CLI", kind: "main" as const, home: null, createdAt: "2026-10-27T00:00:00.000Z" };

/** A home with an account's own settings in it. */
async function makeHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "settings.account.json"), '{"env":{"ANTHROPIC_API_KEY":"sk-keep"}}');
}

async function exists(path: string): Promise<boolean> {
  return readdir(path).then(
    () => true,
    () => false,
  );
}

async function seed(state: Partial<StoredState>): Promise<void> {
  await new StateStore().update((draft) => Object.assign(draft, state));
}

describe("a damaged registry", () => {
  const work = () => managed("claude-work01", join(homes(), "claude-work01"));
  /** Moved out of homes/ by hand. */
  const mine = () => managed("claude-mine01", join(root, "claude-config", "claude-mine"));

  it.each([
    ["not JSON", '{ "accounts": [ ,'],
    ["empty", ""],
    ["missing", null],
    ["partly invalid", JSON.stringify({ accounts: [{ id: "claude-hand", family: "claude", kind: "managed" }] })],
  ])("is restored from its backup, and no home is signed out or deleted (%s)", async (_, damage) => {
    await makeHome(work().home);
    await makeHome(mine().home);
    await seed({ accounts: [main, work(), mine()] as never });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    if (damage === null) await rm(statePath());
    else await writeFile(statePath(), damage);

    const { service, store, fake } = start();
    expect((await store.read()).accounts.map((account) => account.id)).toEqual([main.id, "claude-work01", "claude-mine01"]);
    await service.cleanUpHomes(fakePaseo());

    expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual([]);
    expect(await readFile(join(work().home, "settings.account.json"), "utf8")).toContain("sk-keep");
    expect(await exists(mine().home)).toBe(true);
    // The restored registry is saved, and a damaged file kept for the record.
    expect(JSON.parse(await readFile(statePath(), "utf8")).accounts).toHaveLength(3);
    const kept = (await readdir(join(root, "zerosub"))).filter((name) => name.startsWith("state.json.bad-"));
    expect(kept).toHaveLength(damage === null ? 0 : 1);
  });

  it("without a backup keeps what it could read, and leaves the dropped account's home alone", async () => {
    // Written by hand, so there's no snapshot; the hand-registered account lacks `createdAt`.
    const hand = join(homes(), "claude-hand01");
    await makeHome(work().home);
    await makeHome(hand);
    await mkdir(join(root, "zerosub"), { recursive: true });
    const { createdAt: _, ...broken } = managed("claude-hand01", hand);
    await writeFile(statePath(), JSON.stringify({ accounts: [main, work(), broken] }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const { service, store, fake } = start();
    expect((await store.read()).accounts.map((account) => account.id)).toEqual([main.id, "claude-work01"]);
    await service.cleanUpHomes(fakePaseo());

    expect(fake.calls).toEqual([]);
    expect(await readFile(join(hand, "settings.account.json"), "utf8")).toContain("sk-keep");
  });

  it("doesn't touch folders no account uses, and names them", async () => {
    await makeHome(work().home);
    await makeHome(join(homes(), "claude-lost01"));
    await seed({ accounts: [main, work()] as never });

    const { service, fake } = start();
    expect(await service.strayHomes()).toEqual(["claude-lost01"]);
    await service.cleanUpHomes(fakePaseo());
    expect(fake.calls).toEqual([]);
    expect(await exists(join(homes(), "claude-lost01"))).toBe(true);
  });
});

/** Every file in `home` with its content, and every link with its target. */
async function contents(home: string): Promise<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const name of await readdir(home)) {
    const path = join(home, name);
    found[name] = (await lstat(path)).isSymbolicLink() ? `-> ${await readlink(path)}` : await readFile(path, "utf8");
  }
  return found;
}

/** A Claude home as one kept in `~/.claude-config` looks: its own settings and identity, and links into main. */
async function makeFullHome(home: string): Promise<void> {
  await makeHome(home);
  await writeFile(join(home, ".claude.json"), '{"oauthAccount":{"emailAddress":"mine@example.com"}}');
  await writeFile(join(home, "settings.json"), '{"env":{"ANTHROPIC_API_KEY":"sk-keep"}}');
  await mkdir(join(root, "dot-claude", "skills"), { recursive: true });
  await symlink(join(root, "dot-claude", "skills"), join(home, "skills"));
}

const launchers = () => join(root, "launchers");
/** Moved out of homes/ by hand. */
const external = () => join(root, "claude-config", "claude-mine");

describe("removing an account", () => {
  it("kept outside homes/ only unregisters it: no sign-out, and its files and launcher stay", async () => {
    await makeFullHome(external());
    await seed({ accounts: [main, managed("claude-mine01", external())] as never });
    const { service, store, fake } = start();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await service.rename("claude-mine01", "Mine"); // writes its launcher, as any refresh does
    const before = await contents(external());
    const view = await service.view(fakePaseo());
    expect(view.accounts.map((account) => [account.id, account.externalHome, account.launcher])).toEqual([
      [main.id, false, null],
      ["claude-mine01", true, "claude-mine.sh"],
    ]);

    await service.remove(fakePaseo(), "claude-mine01");
    await service.cleanUpHomes(fakePaseo());
    await service.cleanUpHomes(fakePaseo());

    expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual([]);
    expect(await contents(external())).toEqual(before);
    // The launcher still starts the account; only its marker line changed, so it's the user's now.
    const script = await readFile(join(launchers(), "claude-mine.sh"), "utf8");
    const lines = renderLauncher({ id: "claude-mine01", label: "Mine", home: external() }).split("\n");
    expect(script.split("\n")[1]).toMatch(/^# No longer managed by ZeroSub/);
    expect(script.split("\n").filter((_, index) => index !== 1)).toEqual(lines.filter((_, index) => index !== 1));
    expect((await stat(join(launchers(), "claude-mine.sh"))).mode & 0o111).not.toBe(0);
    const state = await store.read();
    expect(state.accounts.map((account) => account.id)).toEqual([main.id]);
    expect(state.cleanup).toEqual({});
  });

  it("leaves a home in homes/ that links elsewhere as it is", async () => {
    await makeFullHome(external());
    const link = join(homes(), "claude-link01");
    await mkdir(homes(), { recursive: true });
    await symlink(external(), link);
    await seed({ accounts: [main, managed("claude-link01", link)] as never });
    const { service, store, fake } = start();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const before = await contents(external());

    await service.remove(fakePaseo(), "claude-link01");
    await service.cleanUpHomes(fakePaseo());

    expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual([]);
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await contents(external())).toEqual(before);
    expect((await store.read()).cleanup).toEqual({});
  });

  it("signs out and deletes a home in homes/, and its launcher", async () => {
    const home = join(homes(), "claude-work01");
    await makeHome(home);
    await seed({ accounts: [main, managed("claude-work01", home)] as never });
    const { service, store, fake } = start();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await service.rename("claude-work01", "Work");
    expect((await service.view(fakePaseo())).accounts.find((account) => account.id === "claude-work01")?.externalHome).toBe(false);
    expect(await readdir(launchers())).toEqual(["claude-work.sh"]);

    await service.remove(fakePaseo(), "claude-work01");
    await service.cleanUpHomes(fakePaseo());

    expect(fake.calls).toEqual([`logout ${home}`]);
    expect(await exists(home)).toBe(false);
    expect(await readdir(launchers())).toEqual([]);
    expect((await store.read()).cleanup).toEqual({});
  });
});

describe("the CLI's own login", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env.CLAUDE_CONFIG_DIR;
  });
  afterEach(() => {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
  });

  it.each([
    ["where it usually is", () => join(root, "dot-claude")],
    // As odd as it gets: the CLI's own directory inside homes/.
    ["even inside homes/", () => join(homes(), "claude-cli")],
  ])("is never signed out or deleted, even when listed for cleanup (%s)", async (_, where) => {
    const cli = where();
    process.env.CLAUDE_CONFIG_DIR = cli;
    await makeHome(cli);
    await seed({
      accounts: [main] as never,
      cleanup: { [cli]: { family: "claude", accountId: "claude-cli", why: "removed", at: new Date().toISOString() } },
    });
    const { service, store, fake } = start();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await expect(service.remove(fakePaseo(), main.id)).rejects.toThrow("can't be removed");
    await service.cleanUpHomes(fakePaseo());

    expect(fake.calls).toEqual([]);
    expect(await readFile(join(cli, "settings.account.json"), "utf8")).toContain("sk-keep");
    expect((await store.read()).cleanup).toEqual({});
  });

  it("is never signed out when registered by hand as an added account and removed", async () => {
    const cli = join(root, "dot-claude");
    process.env.CLAUDE_CONFIG_DIR = cli;
    await makeHome(cli);
    await seed({ accounts: [main, managed("claude-cli01", cli)] as never });
    const { service, fake } = start();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await service.remove(fakePaseo(), "claude-cli01");
    await service.cleanUpHomes(fakePaseo());

    expect(fake.calls).toEqual([]);
    expect(await readFile(join(cli, "settings.account.json"), "utf8")).toContain("sk-keep");
  });
});

describe("the cleanup list", () => {
  const home = () => join(homes(), "claude-work01");
  const removed = () => ({ [home()]: { family: "claude" as const, accountId: "claude-work01", why: "removed" as const, at: new Date().toISOString() } });

  it("waits until no live agent runs on the home", async () => {
    await makeHome(home());
    await seed({ accounts: [main] as never, cleanup: removed(), sessions: { a1: { accountId: "claude-work01", family: "claude", openedAt: new Date().toISOString() } } });
    const { service, store, fake } = start();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await service.cleanUpHomes(fakePaseo({ a1: "running" }));
    expect(fake.calls).toEqual([]);
    expect(await exists(home())).toBe(true);

    await service.cleanUpHomes(fakePaseo({ a1: "closed" }));
    expect(fake.calls).toEqual([`logout ${home()}`]);
    expect(await exists(home())).toBe(false);
    expect((await store.read()).sessions).toEqual({});
  });

  it("waits while Paseo can't say whether an agent still runs on the home", async () => {
    await makeHome(home());
    await seed({ accounts: [main] as never, cleanup: removed(), sessions: { a1: { accountId: "claude-work01", family: "claude", openedAt: new Date().toISOString() } } });
    const { service, store, fake } = start();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const unreachable = {
      agents: {
        ref: () => ({
          refresh: async () => {
            throw new Error("Timeout waiting for message (30000ms)");
          },
        }),
      },
    } as never;

    // More passes than a failed sign-out gets: an unanswered lookup never counts against the home.
    for (let pass = 0; pass < 4; pass += 1) await service.cleanUpHomes(unreachable);
    expect(fake.calls).toEqual([]);
    expect(await exists(home())).toBe(true);
    expect(Object.keys((await store.read()).cleanup)).toEqual([home()]);

    // An agent Paseo no longer knows runs nowhere.
    await service.cleanUpHomes(fakePaseo());
    expect(fake.calls).toEqual([`logout ${home()}`]);
    expect(await exists(home())).toBe(false);
  });

  it("never signs out a home an account uses again", async () => {
    await makeHome(home());
    await seed({ accounts: [main, managed("claude-work01", home())] as never, cleanup: removed() });
    const { service, store, fake } = start();

    await service.cleanUpHomes(fakePaseo());
    expect(fake.calls).toEqual([]);
    expect(await exists(home())).toBe(true);
    expect((await store.read()).cleanup).toEqual({});
  });

  it("tries a failed sign-out again, and deletes the home once it gives up", async () => {
    await makeHome(home());
    await seed({ accounts: [main] as never, cleanup: removed() });
    const { service, store, fake } = start();
    fake.failLogout = true;
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await service.cleanUpHomes(fakePaseo());
    await service.cleanUpHomes(fakePaseo());
    expect(await exists(home())).toBe(true);
    expect(Object.keys((await store.read()).cleanup)).toEqual([home()]);

    await service.cleanUpHomes(fakePaseo());
    expect(fake.calls).toHaveLength(3);
    expect(await exists(home())).toBe(false);
    expect((await store.read()).cleanup).toEqual({});
  });

  it.each(["removed", "unfinished"] as const)(
    "drops an entry for a home outside homes/ without signing it out or deleting anything (%s)",
    async (why) => {
      // An older version listed removed accounts' homes wherever they were.
      await makeFullHome(external());
      await seed({
        accounts: [main] as never,
        cleanup: { [external()]: { family: "claude", accountId: "claude-mine01", why, at: new Date().toISOString() } },
      });
      const { service, store, fake } = start();
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const before = await contents(external());

      await service.cleanUpHomes(fakePaseo());

      expect(fake.calls).toEqual([]);
      expect(await contents(external())).toEqual(before);
      expect((await store.read()).cleanup).toEqual({});
    },
  );

  it("restored from an older snapshot still never signs out a home outside homes/", async () => {
    await makeFullHome(external());
    await seed({
      accounts: [main] as never,
      cleanup: { [external()]: { family: "claude", accountId: "claude-mine01", why: "removed", at: new Date().toISOString() } },
    });
    await writeFile(statePath(), "{ ,"); // damaged, so the snapshot above comes back
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service, store, fake } = start();
    expect(Object.keys((await store.read()).cleanup)).toEqual([external()]);
    const before = await contents(external());

    await service.cleanUpHomes(fakePaseo());

    expect(fake.calls).toEqual([]);
    expect(await contents(external())).toEqual(before);
    expect((await store.read()).cleanup).toEqual({});
  });
});

describe("signing an account in again as someone else", () => {
  it.each([
    ["kept outside homes/", external, false],
    ["in homes/", () => join(homes(), "claude-work01"), true],
  ])("signs it out only when it's in homes/ (%s)", async (_, where, signsOut) => {
    const home = where();
    await makeHome(home);
    const account = { ...managed("claude-work01", home), email: "old@example.com", identity: "personal|old@example.com" };
    await seed({ accounts: [main, account] as never });
    const { service, fake } = start();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const login = await service.startLogin("claude", "code", account.id);
    fake.signedIn.add(home);
    fake.finish({ ok: true, message: null });
    let message: string | null = null;
    await vi.waitFor(async () => {
      const view = (await service.view(fakePaseo())).logins.find((entry) => entry.id === login.id);
      expect(view?.step).toBe("failed");
      message = view?.message ?? null;
    });

    expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual(signsOut ? [`logout ${home}`] : []);
    expect(message).toContain("You signed in as new@example.com, but this is old@example.com.");
    if (!signsOut) expect(message).toContain("didn't sign it out");
    expect(await exists(home)).toBe(true);
  });
});

describe("a sign-in into an account that's being removed", () => {
  const work = () => managed("claude-work01", join(homes(), "claude-work01"));
  const stepOf = async (service: ReturnType<typeof start>["service"], id: string) =>
    (await service.view(fakePaseo())).logins.find((entry) => entry.id === id);

  it("is canceled by the removal, and never adds the account back", async () => {
    await makeHome(work().home);
    await seed({ accounts: [main, work()] as never });
    const { service, store, fake } = start();
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const login = await service.startLogin("claude", "code", work().id);
    await service.remove(fakePaseo(), work().id);
    expect((await stepOf(service, login.id))?.step).toBe("canceled");

    fake.signedIn.add(work().home);
    fake.finish({ ok: true, message: null });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await store.read()).accounts.map((account) => account.id)).toEqual([main.id]);
    expect((await stepOf(service, login.id))?.step).toBe("canceled");
  });

  it("that's removed as the sign-in is saved says so, and stays removed", async () => {
    await makeHome(work().home);
    await seed({ accounts: [main, work()] as never });
    const { service, store, fake } = start();
    const login = await service.startLogin("claude", "code", work().id);
    const update = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementationOnce((change) =>
      update((draft) => {
        draft.accounts = draft.accounts.filter((account) => account.id !== work().id);
        change(draft);
      }),
    );

    fake.signedIn.add(work().home);
    fake.finish({ ok: true, message: null });
    await vi.waitFor(async () => expect((await stepOf(service, login.id))?.step).toBe("failed"));
    expect((await stepOf(service, login.id))?.message).toBe("That account was removed while you were signing in, so it wasn't added back.");
    expect((await store.read()).accounts.map((account) => account.id)).toEqual([main.id]);
  });

  it("whose account can't be saved ends as failed, rather than verifying for ever", async () => {
    const { service, store, fake } = start();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const login = await service.startLogin("claude", "code");
    const home = join(homes(), `claude-${login.id}`);
    vi.spyOn(store, "update").mockRejectedValueOnce(new Error("disk full"));

    fake.signedIn.add(home);
    fake.finish({ ok: true, message: null });
    await vi.waitFor(async () => expect((await stepOf(service, login.id))?.step).toBe("failed"));
    expect((await stepOf(service, login.id))?.message).toBe("Signed in, but ZeroSub couldn't save the account: disk full");
    // Still listed for cleanup, as any failed sign-in.
    expect(Object.keys((await store.read()).cleanup)).toEqual([home]);
  });
});

describe("an abandoned sign-in", () => {
  it("is left alone while it runs, then signed out and deleted once it ends", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, store, fake } = start();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const login = await service.startLogin("claude", "code");
    const home = join(homes(), `claude-${login.id}`);
    expect(Object.keys((await store.read()).cleanup)).toEqual([home]);
    fake.calls.length = 0; // Starting checked the CLI's own login.

    await service.cleanUpHomes(fakePaseo());
    await service.cancelLogin(login.id);
    await service.cleanUpHomes(fakePaseo()); // The CLI gets a moment to exit.
    expect(fake.calls).toEqual([]);
    expect(await exists(home)).toBe(true);

    vi.setSystemTime(Date.now() + 5_000);
    await service.cleanUpHomes(fakePaseo());
    expect(fake.calls).toEqual([`logout ${home}`]);
    expect(await exists(home)).toBe(false);
    expect((await store.read()).cleanup).toEqual({});
  });

  it("left by an earlier run is deleted when it isn't signed in", async () => {
    const login = await start().service.startLogin("claude", "code");
    const home = join(homes(), `claude-${login.id}`);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { service, store, fake } = start();
    await service.cleanUpHomes(fakePaseo());
    expect(fake.calls).toEqual([`identity ${home}`]);
    expect(await exists(home)).toBe(false);
    expect((await store.read()).cleanup).toEqual({});
  });

  it("left by an earlier run is kept when it's signed in, as it may be an account the registry lost", async () => {
    const login = await start().service.startLogin("claude", "code");
    const home = join(homes(), `claude-${login.id}`);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const { service, store, fake } = start();
    fake.signedIn.add(home);
    await service.cleanUpHomes(fakePaseo());
    expect(fake.calls).toEqual([`identity ${home}`]);
    expect(await exists(home)).toBe(true);
    expect((await store.read()).cleanup).toEqual({});
  });

  it("isn't taken for abandoned while its account is being saved, however long that takes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, store, fake } = start();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const login = await service.startLogin("claude", "code");
    const home = join(homes(), `claude-${login.id}`);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let saving = false;
    const update = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementationOnce(async (change) => {
      saving = true;
      await held; // a slow disk, say
      return update(change);
    });

    fake.signedIn.add(home);
    fake.finish({ ok: true, message: null });
    await vi.waitFor(() => expect(saving).toBe(true));
    vi.setSystemTime(Date.now() + 5_000);
    await service.cleanUpHomes(fakePaseo());
    expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual([]);
    expect(await exists(home)).toBe(true);

    release();
    await vi.waitFor(async () => expect((await store.read()).accounts.map((account) => account.home)).toContain(home));
    expect((await store.read()).cleanup).toEqual({});
    expect(await exists(home)).toBe(true);
  });

  it("that finishes becomes an account and comes off the list", async () => {
    const { service, store, fake } = start();
    const login = await service.startLogin("claude", "code");
    const home = join(homes(), `claude-${login.id}`);
    fake.signedIn.add(home);
    fake.finish({ ok: true, message: null });
    await vi.waitFor(async () => expect((await store.read()).accounts.map((account) => account.home)).toContain(home));

    expect((await store.read()).cleanup).toEqual({});
    await service.cleanUpHomes(fakePaseo());
    expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual([]);
    expect(await exists(home)).toBe(true);
  });
});
