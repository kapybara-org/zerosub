import { link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter, Identity, LoginHandle } from "./adapter";
import type { FamilyResolver } from "./families";
import { claudeHomeHoldsAccount } from "./homes";
import { chooseHomesDir } from "./placement";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, findAccount, type StoredState } from "./state";
import { absentPi } from "./fakes.test-support";

// Added Claude accounts are signed in inside ZeroSub's own homes/, then kept in a folder of the
// user's (~/.claude-config unless they pick another), moved there with their Keychain entry once
// nothing runs on them. Changing the folder moves them all again.

let root: string;
const saved: Record<string, string | undefined> = {};
/** The services a test started, whose moves run on after it unless they're waited for. */
const started: Service[] = [];
const VARIABLES = ["PASEO_HOME", "ZEROSUB_LAUNCHER_DIR", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME", "GROK_HOME", "CURSOR_CONFIG_DIR", "XDG_CONFIG_HOME"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-placement-"));
  for (const key of VARIABLES) saved[key] = process.env[key];
  process.env.PASEO_HOME = root;
  process.env.ZEROSUB_LAUNCHER_DIR = join(root, "claude-config");
  process.env.CLAUDE_CONFIG_DIR = join(root, "main");
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  process.env.CODEX_HOME = join(root, "codex");
  process.env.GROK_HOME = join(root, "grok");
  process.env.XDG_CONFIG_HOME = join(root, "xdg");
  delete process.env.CURSOR_CONFIG_DIR;
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  // A move still under way would carry on in the folders the variables point to once they're put back.
  await Promise.all(started.splice(0).map((service) => service.placeHomes().catch(() => undefined)));
  vi.restoreAllMocks();
  for (const key of VARIABLES) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  // Retried: a write the test set off in the background can still be landing in it.
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const homes = () => join(root, "zerosub", "homes");
const kept = () => join(root, "claude-config");

interface Fake {
  calls: string[];
  /** Keychain entries, by the home they're for. */
  keychain: Map<string, string>;
  /** Homes Claude Code runs on. */
  inUse: Set<string>;
  signedIn: Set<string>;
  /** Who a signed-in home is signed in as, when not ada@example.com; null for an API key. */
  emails: Map<string, string | null>;
  /** Copying a sign-in waits for this while it's set. */
  holdCopy: Promise<void> | null;
  copying: () => void;
  finish: (result: { ok: boolean; message: string | null }) => void;
}

function newFake(): Fake {
  return { calls: [], keychain: new Map(), inUse: new Set(), signedIn: new Set(), emails: new Map(), holdCopy: null, copying: () => undefined, finish: () => undefined };
}

/** The longest sign-in the fake Keychain copies: the real one's is what fits on a line of `security -i`. */
const LONGEST_SIGN_IN = 1_900;
const TOO_LONG = "its Keychain sign-in is too long to copy without showing it in the process list";

/** A Claude adapter with the real one's rules for moving a sign-in, over an in-memory Keychain. */
function fakeAdapter(fake: Fake): FamilyAdapter {
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async (home: string, wanted?: () => Promise<boolean>) => {
      if (wanted && !(await wanted())) return;
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "settings.account.json"), "{}");
    },
    env: async (home: string | null) => (home ? { CLAUDE_CONFIG_DIR: home } : {}),
    identity: async (home: string | null): Promise<Identity> => {
      fake.calls.push(`identity ${home}`);
      const signedIn = home !== null && fake.signedIn.has(home);
      const email = !signedIn ? null : fake.emails.has(home) ? fake.emails.get(home)! : "ada@example.com";
      return { signedIn, email, plan: null, organization: null, identity: email ? `personal|${email}` : null };
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
    logout: async (home: string) => void fake.calls.push(`logout ${home}`),
    setApi: async (home: string) => {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "settings.account.json"), '{"env":{"ANTHROPIC_API_KEY":"sk-test"}}');
    },
    homesInUse: async (list: readonly string[]) => {
      fake.calls.push(`scan ${list.join(" ")}`);
      return new Set(list.filter((home) => fake.inUse.has(home)));
    },
    homeStays: async (home: string) => {
      fake.calls.push(`stays ${home}`);
      return (fake.keychain.get(home)?.length ?? 0) > LONGEST_SIGN_IN ? TOO_LONG : null;
    },
    copyCredentials: async (from: string, to: string) => {
      fake.calls.push(`copy ${from} ${to}`);
      fake.copying();
      if (fake.holdCopy) await fake.holdCopy;
      const secret = fake.keychain.get(from);
      if (secret === undefined) return;
      const there = fake.keychain.get(to);
      if (there === secret) return;
      if (there !== undefined) throw new Error(`the Keychain entry for ${to} already holds another one`);
      if (secret.length > LONGEST_SIGN_IN) throw new Error(`the sign-in is too long to write to the Keychain entry for ${to} without showing it in the process list`);
      fake.keychain.set(to, secret);
    },
    dropCopiedCredentials: async (from: string, to: string) => {
      fake.calls.push(`uncopy ${to}`);
      if (fake.keychain.has(to) && fake.keychain.get(to) === fake.keychain.get(from)) fake.keychain.delete(to);
    },
    holdsAccount: (home: string) => claudeHomeHoldsAccount(home),
    dropOldCredentials: async (from: string, to: string) => {
      fake.calls.push(`drop ${from}`);
      if (!fake.keychain.has(to)) return !fake.keychain.has(from);
      fake.keychain.delete(from);
      return true;
    },
    detectLimit: () => null,
    detectSignOut: () => null,
  } as unknown as FamilyAdapter;
}

const paseo = {
  config: { get: async () => ({ config: { providers: {} } }) },
  agents: {
    list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
    ref: () => ({ refresh: async () => null }),
  },
} as never;

function start(fake: Fake = newFake()) {
  const store = new StateStore();
  const adapter = fakeAdapter(fake);
  const service = new Service(
    { claude: adapter, codex: { ...adapter, family: "codex", homesInUse: undefined, copyCredentials: undefined, dropCopiedCredentials: undefined, dropOldCredentials: undefined } as never, pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  started.push(service);
  return { service, store, fake };
}

const main = { id: MAIN_ACCOUNT_ID.claude, family: "claude" as const, label: "CLI", kind: "main" as const, home: null, createdAt: "2026-10-29T00:00:00.000Z" };

function managed(id: string, label: string, home: string) {
  return { id, family: "claude" as const, label, autoLabel: false, kind: "managed" as const, home, createdAt: "2026-10-29T00:00:00.000Z" };
}

/** A home signed in to an account: what a sync, or Claude Code merely starting on a folder, doesn't make. */
async function makeHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "settings.account.json"), '{"env":{"FOO":"1"}}');
  await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "ada@example.com" } }));
}

/** Records as a hand-edited registry has them: what's left out takes its default. */
async function seed(state: Record<string, unknown>): Promise<void> {
  await new StateStore().update((draft) => Object.assign(draft, state as Partial<StoredState>));
}

const there = (path: string) => lstat(path).then(
  () => true,
  () => false,
);

const homeOf = async (store: StateStore, id: string) => (await store.read()).accounts.find((account) => account.id === id)?.home;

describe("a new Claude account", () => {
  it("is signed in inside homes/, then kept in ~/.claude-config under its name, beside its script", async () => {
    const { service, store, fake } = start();
    await seed({ accounts: [main] });
    const login = await service.startLogin("claude", "code");
    const staged = join(homes(), `claude-${login.id}`);
    fake.keychain.set(staged, '{"claudeAiOauth":{"accessToken":"t"}}');
    fake.signedIn.add(staged);
    fake.finish({ ok: true, message: null });

    const placed = join(kept(), "claude-ada");
    await vi.waitFor(async () => expect(await homeOf(store, `claude-${login.id}`)).toBe(placed));
    // The pass that moved it is done (a call during one gets that one).
    await service.placeHomes();
    expect(await readFile(join(kept(), "claude-ada.sh"), "utf8")).toContain(`CLAUDE_CONFIG_DIR='${placed}'`);
    expect(await readFile(join(placed, "settings.account.json"), "utf8")).toBe("{}");
    expect(await there(staged)).toBe(false);
    // Its sign-in moved with it.
    expect([...fake.keychain]).toEqual([[placed, '{"claudeAiOauth":{"accessToken":"t"}}']]);
    expect((await store.read()).moves).toEqual({});

    // Kept outside homes/, removing it only takes it out of ZeroSub.
    const view = await service.view(paseo);
    expect(view.claudeHomes).toEqual({ dir: kept(), isDefault: true });
    expect(view.accounts.find((account) => account.home === placed)).toMatchObject({ externalHome: true, moving: null });
    await service.remove(paseo, `claude-${login.id}`);
    expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual([]);
    expect(await there(placed)).toBe(true);
    expect(fake.keychain.has(placed)).toBe(true);
  });

  it("set up with an API key is kept there too", async () => {
    const { service, store } = start();
    await seed({ accounts: [main] });
    const id = await service.addApiAccount({ label: "Gateway", key: "sk-test-123456789", keyKind: "api_key" });
    expect(await homeOf(store, id)).toBe(join(kept(), "claude-gateway"));
    expect(await readdir(homes()).catch(() => [])).toEqual([]);
  });
});

describe("moving an account's home", () => {
  it("waits while Claude Code runs on it, saying why, and moves once that stops", async () => {
    const { service, store, fake } = start();
    const home = join(homes(), "claude-aaaaaaaaaaaa");
    await makeHome(home);
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", home)] });
    fake.inUse.add(home);

    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(home);
    const waiting = (await service.view(paseo)).accounts.find((account) => account.id === "claude-aaaaaaaaaaaa")?.moving;
    expect(waiting).toEqual({ to: kept(), waiting: "Claude Code runs on it (an agent or a terminal); it moves once that stops", error: null, stays: null });

    fake.inUse.clear();
    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(join(kept(), "claude-work"));
    expect((await service.view(paseo)).accounts.find((account) => account.id === "claude-aaaaaaaaaaaa")?.moving).toBeNull();
  });

  it("leaves Grok and Cursor accounts in homes/, with no move, script or outside folder", async () => {
    const { service, store } = start();
    const home = join(homes(), "claude-aaaaaaaaaaaa");
    const grok = join(homes(), "grok-bbbbbbbbbbbb");
    const cursor = join(homes(), "cursor-cccccccccccc");
    await makeHome(home);
    for (const other of [grok, cursor]) await mkdir(other, { recursive: true });
    const other = (id: string, family: "grok" | "cursor", at: string) => ({ ...managed(id, family === "grok" ? "Grok work" : "Cursor work", at), family });
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", home), other("grok-bbbbbbbbbbbb", "grok", grok), other("cursor-cccccccccccc", "cursor", cursor)] });

    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(join(kept(), "claude-work"));
    expect(await homeOf(store, "grok-bbbbbbbbbbbb")).toBe(grok);
    expect(await homeOf(store, "cursor-cccccccccccc")).toBe(cursor);
    expect(await there(grok)).toBe(true);
    expect(await there(cursor)).toBe(true);
    expect((await store.read()).moves).toEqual({});
    expect((await readdir(kept())).filter((name) => name.endsWith(".sh"))).toEqual(["claude-work.sh"]);
    const others = (await service.view(paseo)).accounts.filter((account) => account.family === "grok" || account.family === "cursor");
    expect(others).toHaveLength(2);
    for (const view of others) expect(view).toMatchObject({ moving: null, launcher: null, externalHome: false, proxyEditable: false });
  });

  it("gives way to a session routed to the home while it was moving, which opens where the account is, and moves at a later pass", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, store, fake } = start();
    const home = join(homes(), "claude-aaaaaaaaaaaa");
    await makeHome(home);
    fake.keychain.set(home, "token");
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", home)], defaults: { claude: "claude-aaaaaaaaaaaa", codex: null, pi: null } });
    let release = () => undefined as void;
    fake.holdCopy = new Promise<void>((resolve) => (release = resolve));
    const copying = new Promise<void>((resolve) => (fake.copying = resolve));
    try {
      const placing = service.placeHomes();
      await copying;
      // Answered at once, on the folder the account has until the move is saved.
      const opened = await service.onSessionOpen(
        { agentId: "agent-1", workspaceId: null, provider: "claude", cwd: root, reason: "create", purpose: "interactive", env: {} } as never,
        { paseo } as never,
      );
      expect(opened?.env.CLAUDE_CONFIG_DIR).toBe(home);

      release();
      await placing;
      expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(home);
      expect(await there(join(home, ".claude.json"))).toBe(true);
      expect(await there(join(kept(), "claude-work"))).toBe(false);
      // The copy of its sign-in went with the move.
      expect([...fake.keychain]).toEqual([[home, "token"]]);
      expect((await store.read()).moves).toEqual({});
      expect((await service.view(paseo)).accounts.find((account) => account.id === "claude-aaaaaaaaaaaa")?.moving?.waiting).toMatch(/just started/);

      vi.setSystemTime(Date.now() + 31_000);
      fake.holdCopy = null;
      await service.placeHomes();
      expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(join(kept(), "claude-work"));
      expect([...fake.keychain]).toEqual([[join(kept(), "claude-work"), "token"]]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("won't sign an account in again while its folder is moving, or while a move of it is on record", async () => {
    const { service, store, fake } = start();
    const home = join(homes(), "claude-aaaaaaaaaaaa");
    await makeHome(home);
    fake.keychain.set(home, "token");
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", home)] });
    let release = () => undefined as void;
    fake.holdCopy = new Promise<void>((resolve) => (release = resolve));
    const copying = new Promise<void>((resolve) => (fake.copying = resolve));

    const placing = service.placeHomes();
    await copying;
    // A new sign-in would land in the folder the account is leaving, and be lost with it.
    await expect(service.startLogin("claude", "code", "claude-aaaaaaaaaaaa")).rejects.toThrow(/being moved/);
    release();
    await placing;
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(join(kept(), "claude-work"));

    // A move a stop left on record that can't be finished yet: nothing makes its old folder again.
    const from = join(kept(), "claude-work");
    const to = join(root, "elsewhere", "claude-work");
    await makeHome(to);
    await rm(from, { recursive: true });
    fake.keychain.set(from, "other");
    fake.keychain.set(to, "clash");
    await store.update((draft) => void (draft.moves["claude-aaaaaaaaaaaa"] = { from, to, at: "2026-10-29T00:00:00.000Z", family: "claude" }));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(service.startLogin("claude", "code", "claude-aaaaaaaaaaaa")).rejects.toThrow(/being moved/);
    expect(await there(from)).toBe(false);
  });

  it("leaves the account where it was when its sign-in can't be copied, and says why", async () => {
    const { service, store, fake } = start();
    const home = join(homes(), "claude-aaaaaaaaaaaa");
    await makeHome(home);
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", home)] });
    fake.keychain.set(home, "mine");
    fake.keychain.set(join(kept(), "claude-work"), "someone else's");
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(home);
    expect(await there(join(home, "settings.account.json"))).toBe(true);
    expect(fake.keychain.get(home)).toBe("mine");
    expect(fake.keychain.get(join(kept(), "claude-work"))).toBe("someone else's");
    expect((await store.read()).moves).toEqual({});
    expect((await service.view(paseo)).accounts.find((account) => account.id === "claude-aaaaaaaaaaaa")?.moving?.error).toContain("already holds another one");
  });

  it("leaves an account whose Keychain sign-in is too long to copy where it is, without an error or a try every pass, and moves it once it fits", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { service, store, fake } = start();
    const home = join(homes(), "claude-aaaaaaaaaaaa");
    await makeHome(home);
    // Claude Code's records of MCP servers' sign-ins (`mcpOAuth`) make it this long.
    const long = JSON.stringify({ claudeAiOauth: { accessToken: "t" }, mcpOAuth: { "plugin:x": { discoveryState: "x".repeat(LONGEST_SIGN_IN) } } });
    fake.keychain.set(home, long);
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", home)] });
    const logged = vi.mocked(console.log);
    const said = () => logged.mock.calls.filter(([line]) => String(line).includes(`the home of Work stays in ${home}: ${TOO_LONG}`)).length;
    const moving = async () => (await service.view(paseo)).accounts.find((account) => account.id === "claude-aaaaaaaaaaaa")?.moving;
    try {
      await service.placeHomes();
      expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(home);
      expect(await there(join(home, ".claude.json"))).toBe(true);
      expect([...fake.keychain]).toEqual([[home, long]]);
      expect((await store.read()).moves).toEqual({});
      expect(await moving()).toEqual({ to: kept(), waiting: null, error: null, stays: TOO_LONG });
      // Asked once nothing ran on it, and not tried: nothing copied, nothing written down.
      expect(fake.calls).toEqual([`scan ${home}`, `stays ${home}`]);
      expect(said()).toBe(1);

      // Passes after that leave it be, without even a look at what runs on it, or asking again for half an hour.
      fake.calls.length = 0;
      vi.setSystemTime(Date.now() + 29 * 60_000);
      await service.placeHomes();
      expect(fake.calls).toEqual([]);
      expect((await moving())?.stays).toBe(TOO_LONG);
      // Then it's asked again, and still stays, which the log already said.
      vi.setSystemTime(Date.now() + 2 * 60_000);
      await service.placeHomes();
      expect(fake.calls).toEqual([`stays ${home}`]);
      expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(home);
      expect(said()).toBe(1);

      // Once the sign-in fits, the next time it's asked, the folder moves with it.
      const short = JSON.stringify({ claudeAiOauth: { accessToken: "t" } });
      fake.keychain.set(home, short);
      vi.setSystemTime(Date.now() + 31 * 60_000);
      await service.placeHomes();
      expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(join(kept(), "claude-work"));
      expect([...fake.keychain]).toEqual([[join(kept(), "claude-work"), short]]);
      expect(await moving()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes a move the plugin stopped in the middle of", async () => {
    const { service, store, fake } = start();
    const from = join(homes(), "claude-aaaaaaaaaaaa");
    const to = join(kept(), "claude-work");
    // The folder had moved, but the registry still had it where it was.
    await makeHome(to);
    fake.keychain.set(from, "token");
    fake.keychain.set(to, "token");
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", from)], moves: { "claude-aaaaaaaaaaaa": { from, to, at: "2026-10-29T00:00:00.000Z" } } });

    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(to);
    expect([...fake.keychain]).toEqual([[to, "token"]]);
    expect((await store.read()).moves).toEqual({});
  });

  it("finishes one that stopped after the folder moved, though a sync made the old folder again meanwhile", async () => {
    const { service, store, fake } = start();
    const from = join(homes(), "claude-aaaaaaaaaaaa");
    const to = join(kept(), "claude-work");
    // Stopped after the rename, before the registry was saved: the sign-in is in `to`, the Keychain
    // entry still under `from`, and an upkeep before the fix made `from` again, empty.
    await makeHome(to);
    await mkdir(from, { recursive: true });
    await writeFile(join(from, "settings.account.json"), "{}");
    fake.keychain.set(from, "token");
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", from)], moves: { "claude-aaaaaaaaaaaa": { from, to, at: "2026-10-29T00:00:00.000Z", family: "claude" } } });

    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(to);
    expect([...fake.keychain]).toEqual([[to, "token"]]);
    expect((await store.read()).moves).toEqual({});
    // The one made again is left for the user, and nothing says to delete the folder with the sign-in.
    expect(await there(from)).toBe(true);
    expect((await service.view(paseo)).accounts.find((account) => account.id === "claude-aaaaaaaaaaaa")?.moving ?? null).toBeNull();
  });

  it("finishes a move on record before an upkeep or a session touches the old folder", async () => {
    const { service, store, fake } = start();
    const from = join(homes(), "claude-aaaaaaaaaaaa");
    const to = join(kept(), "claude-work");
    await makeHome(to);
    fake.keychain.set(from, "token");
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", from)], defaults: { claude: "claude-aaaaaaaaaaaa", codex: null, pi: null }, moves: { "claude-aaaaaaaaaaaa": { from, to, at: "2026-10-29T00:00:00.000Z", family: "claude" } } });

    const opened = await service.onSessionOpen(
      { agentId: "agent-1", workspaceId: null, provider: "claude", cwd: root, reason: "create", purpose: "interactive", env: {} },
      { paseo } as never,
    );
    expect(opened?.env.CLAUDE_CONFIG_DIR).toBe(to);
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(to);
    expect(await there(from)).toBe(false);
    expect([...fake.keychain]).toEqual([[to, "token"]]);
  });

  it("finishes a move on record at startup before the homes are brought in step with main", async () => {
    const { service, store, fake } = start();
    const from = join(homes(), "claude-aaaaaaaaaaaa");
    const to = join(kept(), "claude-work");
    await makeHome(to);
    fake.keychain.set(from, "token");
    // A record of an earlier version, without the family.
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", from)], moves: { "claude-aaaaaaaaaaaa": { from, to, at: "2026-10-29T00:00:00.000Z" } } });
    service.attach(paseo);
    await service.start();
    try {
      // The first upkeep runs in the background.
      await vi.waitFor(async () => expect((await store.read()).moves).toEqual({}));
      expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(to);
      // Nothing made the old folder again, so nothing's left over for the user.
      expect(await there(from)).toBe(false);
      expect((await store.read()).moves).toEqual({});
    } finally {
      await service.stop();
    }
  });

  it("finishes a move on record before an upkeep checks the account, which stays signed in", async () => {
    const { service, store, fake } = start();
    const from = join(homes(), "claude-aaaaaaaaaaaa");
    const to = join(kept(), "claude-work");
    // Stopped after the rename, before the registry was saved: the sign-in is in `to` now.
    await makeHome(to);
    fake.keychain.set(from, "token");
    fake.signedIn.add(to);
    await seed({
      accounts: [main, { ...managed("claude-aaaaaaaaaaaa", "Work", from), signedIn: true, email: "ada@example.com" }],
      moves: { "claude-aaaaaaaaaaaa": { from, to, at: "2026-10-29T00:00:00.000Z", family: "claude" } },
    });

    await (service as unknown as { tick(): Promise<void> }).tick();
    // The checks it set off in the background read the folder the account is in by then.
    await vi.waitFor(() => expect(fake.calls).toContain(`identity ${to}`));
    expect(fake.calls).not.toContain(`identity ${from}`);
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(to);
    expect(findAccount(await store.read(), "claude-aaaaaaaaaaaa")?.signedIn).toBe(true);
  });

  it("keeps the account on the old folder, and says to delete the new one, when only the old one holds the sign-in", async () => {
    const { service, store } = start();
    const from = join(homes(), "claude-aaaaaaaaaaaa");
    const to = join(kept(), "claude-work");
    await makeHome(from);
    await mkdir(to, { recursive: true });
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", from)], moves: { "claude-aaaaaaaaaaaa": { from, to, at: "2026-10-29T00:00:00.000Z", family: "claude" } } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(from);
    expect(await there(from)).toBe(true);
    const moving = (await service.view(paseo)).accounts.find((account) => account.id === "claude-aaaaaaaaaaaa")?.moving;
    expect(moving?.error).toContain(`delete ${to}`);
  });

  it("tries one again that stopped before the folder moved", async () => {
    const { service, store, fake } = start();
    const from = join(homes(), "claude-aaaaaaaaaaaa");
    const to = join(kept(), "claude-work");
    await makeHome(from);
    fake.keychain.set(from, "token");
    fake.keychain.set(to, "token");
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", from)], moves: { "claude-aaaaaaaaaaaa": { from, to, at: "2026-10-29T00:00:00.000Z" } } });

    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(to);
    expect([...fake.keychain]).toEqual([[to, "token"]]);
  });

  it("leaves both folders alone when both are there after a stop, and says so", async () => {
    const { service, store } = start();
    const from = join(homes(), "claude-aaaaaaaaaaaa");
    const to = join(kept(), "claude-work");
    await makeHome(from);
    await makeHome(to);
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", from)], moves: { "claude-aaaaaaaaaaaa": { from, to, at: "2026-10-29T00:00:00.000Z" } } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(from);
    expect(await there(from)).toBe(true);
    expect(await there(to)).toBe(true);
    const moving = (await service.view(paseo)).accounts.find((account) => account.id === "claude-aaaaaaaaaaaa")?.moving;
    expect(moving?.to).toBe(to);
    expect(moving?.error).toContain("both are there now");
    expect(moving?.error).toContain(`delete ${to}`);

    // Once the unfinished copy is gone, the move starts again.
    await rm(to, { recursive: true });
    await service.placeHomes();
    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(to);
    expect(await there(from)).toBe(false);
  });

  it("keeps the old folder when it's still there after the account moved, and logs it", async () => {
    const { service, store } = start();
    const from = join(homes(), "claude-aaaaaaaaaaaa");
    const to = join(kept(), "claude-work");
    await makeHome(from);
    await makeHome(to);
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", to)], moves: { "claude-aaaaaaaaaaaa": { from, to, at: "2026-10-29T00:00:00.000Z" } } });
    const logged = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(to);
    expect(await there(from)).toBe(true);
    expect((await store.read()).moves).toEqual({});
    expect(logged.mock.calls.some(([line]) => String(line).includes(`${from} is still there`))).toBe(true);
  });
});

describe("changing where accounts are kept", () => {
  it("moves every account kept before, and any still in homes/, keeping names that are taken apart", async () => {
    const { service, store, fake } = start();
    const elsewhere = join(root, "elsewhere");
    const mine = join(kept(), "claude-mine");
    const fresh = join(homes(), "claude-bbbbbbbbbbbb");
    await makeHome(mine);
    await makeHome(fresh);
    fake.keychain.set(mine, "a");
    fake.keychain.set(fresh, "b");
    // Someone else's folder already has the name.
    await mkdir(join(elsewhere, "claude-mine"), { recursive: true });
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Mine", mine), managed("claude-bbbbbbbbbbbb", "Fresh", fresh)] });

    expect(await service.setClaudeHomesDir(elsewhere)).toEqual({ dir: elsewhere, moving: 2 });
    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(join(elsewhere, "claude-mine-aaaaaa"));
    expect(await homeOf(store, "claude-bbbbbbbbbbbb")).toBe(join(elsewhere, "claude-fresh"));
    expect(new Map(fake.keychain)).toEqual(new Map([[join(elsewhere, "claude-mine-aaaaaa"), "a"], [join(elsewhere, "claude-fresh"), "b"]]));
    expect(await there(mine)).toBe(false);
    expect(await readdir(join(elsewhere, "claude-mine"))).toEqual([]);
    const scripts = async () => (await readdir(kept())).filter((name) => name.endsWith(".sh")).sort();
    const starts = async (script: string) => /^export CLAUDE_CONFIG_DIR='(.*)'$/m.exec(await readFile(join(kept(), script), "utf8"))?.[1];
    expect(await scripts()).toEqual(["claude-fresh.sh", "claude-mine.sh"]);
    expect(await starts("claude-mine.sh")).toBe(join(elsewhere, "claude-mine-aaaaaa"));

    // Once nothing's left there, the folder picked before isn't looked at again.
    await service.placeHomes();
    expect((await store.read()).claudeHomes).toEqual({ dir: elsewhere, from: [] });

    // Back to the default: they move back.
    expect(await service.setClaudeHomesDir("")).toEqual({ dir: kept(), moving: 2 });
    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(join(kept(), "claude-mine-aaaaaa"));
    expect(await homeOf(store, "claude-bbbbbbbbbbbb")).toBe(join(kept(), "claude-fresh"));
    expect((await store.read()).claudeHomes.dir).toBeNull();
    // Each account's script follows its home, under the same name.
    expect(await scripts()).toEqual(["claude-fresh.sh", "claude-mine.sh"]);
    expect(await starts("claude-mine.sh")).toBe(join(kept(), "claude-mine-aaaaaa"));
    expect(await starts("claude-fresh.sh")).toBe(join(kept(), "claude-fresh"));
  });

  it("refuses a folder that can't hold accounts", async () => {
    const accounts = [managed("claude-aaaaaaaaaaaa", "Work", join(kept(), "claude-work"))] as never;
    await writeFile(join(root, "a-file"), "");
    await expect(chooseHomesDir("accounts", accounts)).rejects.toThrow("Enter a full path");
    await expect(chooseHomesDir("~", accounts)).rejects.toThrow("not ~ itself");
    await expect(chooseHomesDir(join(root, "zerosub", "x"), accounts)).rejects.toThrow("inside ZeroSub's own folder");
    await expect(chooseHomesDir(join(root, "main", "accounts"), accounts)).rejects.toThrow("a CLI's own folder");
    await expect(chooseHomesDir(join(kept(), "claude-work", "x"), accounts)).rejects.toThrow("inside the folder of Work");
    await expect(chooseHomesDir(join(root, "a-file"), accounts)).rejects.toThrow("is a file");
    expect(await chooseHomesDir(` ${kept()} `, accounts)).toBeNull();
    expect(await chooseHomesDir(join(root, "new", "place"), accounts)).toBe(join(root, "new", "place"));
    expect(await there(join(root, "new", "place"))).toBe(true);
  });

  it("refuses Grok's and Cursor's own folders, which their accounts mirror or share", async () => {
    // Claude accounts kept in ~/.config would be linked into every Cursor account's XDG_CONFIG_HOME, sign-ins and all.
    for (const dir of [join(root, "grok", "accounts"), join(root, "xdg", "claude-accounts"), join(root, "xdg", "cursor", "accounts")]) {
      await expect(chooseHomesDir(dir, [])).rejects.toThrow("a CLI's own folder");
    }
    process.env.CURSOR_CONFIG_DIR = join(root, "cursor-settings");
    await expect(chooseHomesDir(join(root, "cursor-settings", "accounts"), [])).rejects.toThrow("a CLI's own folder");
  });

  it("doesn't count an account whose folder stays where it is among those that move", async () => {
    const { service, store, fake } = start();
    const stays = join(homes(), "claude-aaaaaaaaaaaa");
    const moves = join(homes(), "claude-bbbbbbbbbbbb");
    await makeHome(stays);
    await makeHome(moves);
    fake.keychain.set(stays, "x".repeat(LONGEST_SIGN_IN + 1));
    fake.inUse.add(moves);
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Long", stays), managed("claude-bbbbbbbbbbbb", "Busy", moves)] });
    await service.placeHomes();

    const elsewhere = join(root, "elsewhere");
    expect(await service.setClaudeHomesDir(elsewhere)).toEqual({ dir: elsewhere, moving: 1 });
    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(stays);
    const card = (await service.view(paseo)).accounts.find((account) => account.id === "claude-aaaaaaaaaaaa")?.moving;
    expect(card).toEqual({ to: elsewhere, waiting: null, error: null, stays: TOO_LONG });
    // One waiting for what runs on it isn't asked meanwhile: asking reads its Keychain entry.
    expect(fake.calls).not.toContain(`stays ${moves}`);
  });

  it("leaves accounts kept anywhere else where they are", async () => {
    const { service, store } = start();
    const own = join(root, "somewhere", "claude-own");
    await makeHome(own);
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Own", own)] });
    await service.setClaudeHomesDir(join(root, "elsewhere"));
    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(own);
  });
});

describe("adding a folder that's already signed in", () => {
  it("adds it as it is, where it is, and removing it only takes it out again", async () => {
    const { service, store, fake } = start();
    const folder = join(root, "elsewhere", "claude-mine");
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, ".claude.json"), "{}");
    await writeFile(join(folder, "settings.json"), '{"model":"opus"}');
    fake.signedIn.add(folder);
    fake.emails.set(folder, "mine@example.com");
    await seed({ accounts: [main] });

    const id = await service.importAccount(`${folder}/`);
    expect((await store.read()).accounts.find((account) => account.id === id)).toMatchObject({
      home: folder,
      label: "mine",
      email: "mine@example.com",
      kind: "managed",
      auth: "subscription",
      signedIn: true,
    });
    // Neither in homes/ nor in a folder picked before, so it stays where it is, as it is.
    await service.placeHomes();
    expect(await homeOf(store, id)).toBe(folder);
    expect(await readFile(join(folder, "settings.json"), "utf8")).toBe('{"model":"opus"}');
    expect(await readFile(join(kept(), "claude-mine.sh"), "utf8")).toContain(`CLAUDE_CONFIG_DIR='${folder}'`);
    expect((await service.view(paseo)).accounts.find((account) => account.id === id)).toMatchObject({ externalHome: true });

    await service.remove(paseo, id);
    expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual([]);
    expect(await there(folder)).toBe(true);
    // Nothing is even listed for cleanup: the folder is the user's.
    expect((await store.read()).cleanup).toEqual({});
    // So it can be added again the same way.
    const again = await service.importAccount(folder);
    expect(await homeOf(store, again)).toBe(folder);
  });

  it("imports the CLI subscription into an isolated home and keeps one entry enabled", async () => {
    const { service, store, fake } = start();
    const folder = join(root, "elsewhere", "claude-isolated");
    const duplicate = join(root, "elsewhere", "claude-duplicate");
    for (const home of [folder, duplicate]) {
      await makeHome(home);
      await writeFile(join(home, ".claude.json"), "{}");
      fake.signedIn.add(home);
    }
    const limitedUntil = new Date(Date.now() + 60_000).toISOString();
    await seed({
      accounts: [{ ...main, email: "ada@example.com", identity: "personal|ada@example.com", limitedUntil }],
      bindings: { agent: { accountId: main.id, source: "user", at: main.createdAt } },
    });

    const id = await service.importAccount(folder);
    const state = await store.read();
    expect(state.defaults.claude).toBe(id);
    expect(state.bindings.agent?.accountId).toBe(id);
    expect(state.accounts.find((account) => account.id === id)).toMatchObject({ home: folder, disabled: false, limitedUntil });
    expect(state.accounts.find((account) => account.id === main.id)).toMatchObject({ signedIn: true, disabled: true });
    await expect(service.importAccount(duplicate)).rejects.toThrow("already added");
    expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual([]);

    await service.setAccountEnabled(paseo, main.id, true);
    const switchedBack = await store.read();
    expect(switchedBack.defaults.claude).toBe(main.id);
    expect(switchedBack.bindings.agent?.accountId).toBe(main.id);
    expect(switchedBack.accounts.filter((account) => !account.disabled).map((account) => account.id)).toEqual([main.id]);
  });

  it.each([false, true])("restores the CLI routing on removal only if ZeroSub paused it (manually disabled: %s)", async (disabled) => {
    const { service, store, fake } = start();
    const folder = join(root, "elsewhere", "claude-isolated");
    await makeHome(folder);
    fake.signedIn.add(folder);
    const binding = { accountId: main.id, source: "user", at: main.createdAt };
    await seed({
      accounts: [{ ...main, signedIn: true, email: "ada@example.com", identity: "personal|ada@example.com", disabled }],
      bindings: { agent: binding },
    });

    const id = await service.importAccount(folder);
    expect(findAccount(await store.read(), main.id)?.pausedFor).toBe(disabled ? undefined : id);
    expect((await store.read()).bindings.agent?.accountId).toBe(id);

    await service.remove(paseo, id);
    const state = await store.read();
    expect(findAccount(state, main.id)).toMatchObject({ disabled, signedIn: true });
    expect(findAccount(state, main.id)?.pausedFor).toBeUndefined();
    expect(state.defaults.claude).toBe(disabled ? null : main.id);
    expect(state.bindings.agent).toEqual(disabled ? undefined : binding);
  });

  it("leaves existing matching logins and pins alone during identity refresh", async () => {
    const { service, store, fake } = start();
    const folder = join(root, "elsewhere", "claude-isolated");
    await makeHome(folder);
    fake.signedIn.add(folder);
    const id = "claude-aaaaaaaaaaaa";
    const identity = { signedIn: true, email: "ada@example.com", identity: "personal|ada@example.com" };
    await seed({
      accounts: [{ ...main, ...identity }, { ...managed(id, "Isolated", folder), ...identity }],
      bindings: { agent: { accountId: main.id, source: "user", at: main.createdAt } },
    });

    await service.view(paseo, true, id);
    const state = await store.read();
    expect(fake.calls).toContain(`identity ${folder}`);
    expect(state.accounts.filter((account) => !account.disabled).map((account) => account.id)).toEqual([main.id, id]);
    expect(state.defaults.claude).toBeNull();
    expect(state.bindings.agent?.accountId).toBe(main.id);
  });

  it("refuses to import an alias of the CLI login folder", async () => {
    const { service, fake } = start();
    const cli = join(root, "main");
    const alias = join(root, "cli-alias");
    await makeHome(cli);
    await symlink(cli, alias, "junction");
    await expect(service.importAccount(alias)).rejects.toThrow("the CLI login's own folder");
    expect(fake.calls).not.toContain(`identity ${alias}`);
  });

  it.skipIf(process.platform === "darwin").each([
    ["copy", true], ["hard link", true], ["symbolic link", true], ["separate sign-in", true],
    ["copy", false], ["hard link", false], ["symbolic link", false], ["separate sign-in", false],
    ["link to separate sign-in", true], ["link to separate sign-in", false],
  ] as const)(
    "checks a Claude import with a %s (saved CLI identity matches: %s)",
    async (kind, matching) => {
      const { service, store, fake } = start();
      const cli = join(root, "main");
      const folder = join(root, "elsewhere", "claude-isolated");
      await makeHome(cli);
      await makeHome(folder);
      fake.signedIn.add(folder);
      const email = matching ? "ada@example.com" : "previous@example.com";
      await seed({ accounts: [{ ...main, signedIn: true, email, identity: `personal|${email}` }] });
      const cliFile = join(cli, ".credentials.json");
      const importFile = join(folder, ".credentials.json");
      const credentials = (refreshToken: string, accessToken: string) => JSON.stringify({ claudeAiOauth: { refreshToken, accessToken } });
      await writeFile(cliFile, credentials("cli-refresh", "cli-access"));
      switch (kind) {
        case "hard link": await link(cliFile, importFile); break;
        case "symbolic link": await symlink(cliFile, importFile, "file"); break;
        case "copy": await writeFile(importFile, credentials("cli-refresh", "different-access")); break;
        case "separate sign-in": await writeFile(importFile, credentials("isolated-refresh", "isolated-access")); break;
        case "link to separate sign-in": {
          const separate = join(root, "separate-credentials.json");
          await writeFile(separate, credentials("isolated-refresh", "isolated-access"));
          await symlink(separate, importFile, "file");
          break;
        }
      }

      if (kind === "separate sign-in" || (kind === "link to separate sign-in" && !matching)) {
        const id = await service.importAccount(folder);
        expect(findAccount(await store.read(), main.id)?.pausedFor).toBe(matching ? id : undefined);
      } else {
        await expect(service.importAccount(folder)).rejects.toThrow("Use Add account → Claude sign-in");
        expect((await store.read()).accounts).toHaveLength(1);
        expect(findAccount(await store.read(), main.id)?.disabled).toBe(false);
      }
    },
  );

  it("refuses a folder it can't add, saying why", async () => {
    const { service, store, fake } = start();
    const work = join(kept(), "claude-work");
    await makeHome(work);
    const elsewhere = (name: string) => join(root, "elsewhere", name);
    for (const name of ["out", "api", "twin", "project"]) await mkdir(elsewhere(name), { recursive: true });
    for (const name of ["out", "api", "twin"]) await writeFile(join(elsewhere(name), ".claude.json"), "{}");
    fake.signedIn.add(elsewhere("api"));
    fake.emails.set(elsewhere("api"), null);
    fake.signedIn.add(elsewhere("twin"));
    await writeFile(join(root, "a-file"), "");
    await seed({ accounts: [main, { ...managed("claude-aaaaaaaaaaaa", "Work", work), email: "ada@example.com", identity: "personal|ada@example.com" }] });

    const refusal = (input: string) => service.importAccount(input).then(() => "added", (error: Error) => error.message);
    expect(await refusal("claude-work")).toContain("Enter a full path");
    expect(await refusal(join(root, "nowhere"))).toContain("There's no folder at");
    expect(await refusal(join(root, "a-file"))).toContain("is a file");
    expect(await refusal(join(root, "main"))).toContain("the CLI login's own folder");
    expect(await refusal(work)).toContain("is already added, as Work");
    expect(await refusal(join(work, "projects"))).toContain("inside the folder of Work");
    expect(await refusal(kept())).toContain("holds the folder of Work");
    expect(await refusal(join(root, "zerosub"))).toContain("ZeroSub's own folder");
    expect(await refusal(homes())).toContain("ZeroSub's own folder");
    expect(await refusal("~")).toContain("isn't a Claude Code folder");
    // Not a folder Claude Code was started with: it isn't even asked, so it writes nothing there.
    expect(await refusal(elsewhere("project"))).toContain("there's no .claude.json in it");
    expect(fake.calls).not.toContain(`identity ${elsewhere("project")}`);
    expect(await readdir(elsewhere("project"))).toEqual([]);
    expect(await refusal(elsewhere("out"))).toContain("isn't signed in");
    expect(await refusal(elsewhere("api"))).toContain("API key or token");
    expect(await refusal(elsewhere("twin"))).toContain('already added as "Work"');
    expect((await store.read()).accounts).toHaveLength(2);
  });

  it("takes a removed account's folder kept in homes/ back under its ID, then keeps it where accounts are kept", async () => {
    const { service, store, fake } = start();
    const folder = join(homes(), "claude-aaaaaaaaaaaa");
    await makeHome(folder);
    await writeFile(join(folder, ".claude.json"), "{}");
    fake.signedIn.add(folder);
    fake.keychain.set(folder, "token");
    await seed({
      accounts: [main],
      cleanup: { [folder]: { family: "claude", accountId: "claude-aaaaaaaaaaaa", why: "removed", at: "2026-10-29T00:00:00.000Z" } },
    });

    expect(await service.importAccount(folder)).toBe("claude-aaaaaaaaaaaa");
    // No longer cleaned up as a removed account's.
    expect((await store.read()).cleanup).toEqual({});
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(join(kept(), "claude-ada"));
    expect([...fake.keychain]).toEqual([[join(kept(), "claude-ada"), "token"]]);
  });
});
