import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter, Identity, LoginHandle } from "./adapter";
import type { FamilyResolver } from "./families";
import { chooseHomesDir } from "./placement";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";
import { absentPi } from "./fakes.test-support";

// Added Claude accounts are signed in inside ZeroSub's own homes/, then kept in a folder of the
// user's (~/.claude-config unless they pick another), moved there with their Keychain entry once
// nothing runs on them. Changing the folder moves them all again.

let root: string;
const saved: Record<string, string | undefined> = {};
/** The services a test started, whose moves run on after it unless they're waited for. */
const started: Service[] = [];
const VARIABLES = ["PASEO_HOME", "ZEROSUB_LAUNCHER_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-placement-"));
  for (const key of VARIABLES) saved[key] = process.env[key];
  process.env.PASEO_HOME = root;
  process.env.ZEROSUB_LAUNCHER_DIR = join(root, "claude-config");
  process.env.CLAUDE_CONFIG_DIR = join(root, "main");
  process.env.CODEX_HOME = join(root, "codex");
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
    homesInUse: async (list: readonly string[]) => new Set(list.filter((home) => fake.inUse.has(home))),
    copyCredentials: async (from: string, to: string) => {
      fake.calls.push(`copy ${from} ${to}`);
      fake.copying();
      if (fake.holdCopy) await fake.holdCopy;
      const secret = fake.keychain.get(from);
      if (secret === undefined) return;
      const there = fake.keychain.get(to);
      if (there === secret) return;
      if (there !== undefined) throw new Error(`the Keychain entry for ${to} already holds another one`);
      fake.keychain.set(to, secret);
    },
    dropCopiedCredentials: async (from: string, to: string) => {
      fake.calls.push(`uncopy ${to}`);
      if (fake.keychain.has(to) && fake.keychain.get(to) === fake.keychain.get(from)) fake.keychain.delete(to);
    },
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

async function makeHome(home: string): Promise<void> {
  await mkdir(home, { recursive: true });
  await writeFile(join(home, "settings.account.json"), '{"env":{"FOO":"1"}}');
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
    expect(waiting).toEqual({ to: kept(), waiting: "Claude Code runs on it (an agent or a terminal); it moves once that stops", error: null });

    fake.inUse.clear();
    await service.placeHomes();
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(join(kept(), "claude-work"));
    expect((await service.view(paseo)).accounts.find((account) => account.id === "claude-aaaaaaaaaaaa")?.moving).toBeNull();
  });

  it("holds new sessions until it's done, and opens them in the new home", async () => {
    const { service, store, fake } = start();
    const home = join(homes(), "claude-aaaaaaaaaaaa");
    await makeHome(home);
    await seed({ accounts: [main, managed("claude-aaaaaaaaaaaa", "Work", home)], defaults: { claude: "claude-aaaaaaaaaaaa", codex: null, pi: null } });
    let release = () => undefined as void;
    fake.holdCopy = new Promise<void>((resolve) => (release = resolve));
    const copying = new Promise<void>((resolve) => (fake.copying = resolve));

    const placing = service.placeHomes();
    await copying;
    let opened: { env: Record<string, string> } | undefined;
    const context = { paseo } as never;
    const opening = service
      .onSessionOpen({ agentId: "agent-1", provider: "claude", reason: "create", purpose: "interactive", env: {} } as never, context)
      .then((request) => (opened = request as never));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(opened).toBeUndefined();

    release();
    await placing;
    await opening;
    expect(opened?.env.CLAUDE_CONFIG_DIR).toBe(join(kept(), "claude-work"));
    expect(await homeOf(store, "claude-aaaaaaaaaaaa")).toBe(join(kept(), "claude-work"));
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
    // So it can be added again the same way.
    const again = await service.importAccount(folder);
    expect(await homeOf(store, again)).toBe(folder);
  });

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
