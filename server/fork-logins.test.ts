// ZeroSub's own behavior around signing an account in again, kept apart from upstream's cleanup tests.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Family } from "../shared/model";
import type { FamilyAdapter, Identity, LoginHandle } from "./adapter";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { chooseAccount } from "./routing";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";
import { absentPi } from "./fakes.test-support";

let root: string;
let previousHome: string | undefined;
let previousLaunchers: string | undefined;
/** The services the current test made, stopped once it ends. */
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-logins-"));
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

interface Fake {
  mainSignedIn?: boolean;
  identityKey?: string;
  calls: string[];
  /** Which homes `identity` reports as signed in. */
  signedIn: Set<string>;
  /** Which homes hold an API key. */
  keyed: Set<string>;
  /** `logout` throws while this is set. */
  failLogout: boolean;
  /** Settles the sign-in in progress. */
  finish: (result: { ok: boolean; message: string | null }) => void;
}

/** A sign-in adapter that records what it is asked to do and makes separate homes. */
function fakeAdapter(fake: Fake, family: Family): FamilyAdapter {
  return {
    family,
    portable: family === "claude",
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async (home: string) => {
      await mkdir(home, { recursive: true });
      await writeFile(join(home, "settings.account.json"), "{}");
    },
    env: async () => ({}),
    identity: async (home: string | null): Promise<Identity> => {
      fake.calls.push(`identity ${home}`);
      const signedIn = home === null ? fake.mainSignedIn === true : fake.signedIn.has(home);
      return { signedIn, email: signedIn ? "new@example.com" : null, plan: null, organization: null, identity: signedIn ? (fake.identityKey ?? "personal|new@example.com") : null };
    },
    api: async (home: string | null) => (home !== null && fake.keyed.has(home) ? { keyHint: "abcd", baseUrl: null } : null),
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
function fakePaseo(statuses: Record<string, string> = {}, family: Family = "claude") {
  return {
    agents: {
      list: async () => ({ entries: [], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: (id: string) => ({
        refresh: async () =>
          statuses[id] ? { agent: { id, provider: family, status: statuses[id], archivedAt: null, lastUserMessageAt: null } } : null,
      }),
    },
  } as never;
}

/** A service on the registry in `$PASEO_HOME`, as the plugin makes it on (re)start. */
function start(fake: Fake = newFake(), family: Family = "claude") {
  const store = new StateStore();
  const adapter = fakeAdapter(fake, family);
  const service = new Service(
    { claude: adapter, codex: adapter, pi: absentPi(), [family]: adapter },
    store,
    { resolve: async () => ({ [family]: family }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  services.push(service);
  return { service, store, fake };
}

function newFake(): Fake {
  return { calls: [], signedIn: new Set(), keyed: new Set(), failLogout: false, finish: () => undefined };
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
const external = () => join(root, "claude-config", "claude-mine");

it("adds a new Claude sign-in in its own home even if the CLI already uses that subscription", async () => {
  await seed({ accounts: [{ ...main, email: "new@example.com", identity: "personal|new@example.com" }] as never });
  const { service, store, fake } = start({ ...newFake(), mainSignedIn: true });
  const login = await service.startLogin("claude", "code");
  const home = join(homes(), `claude-${login.id}`);
  fake.signedIn.add(home);
  fake.finish({ ok: true, message: null });

  await vi.waitFor(async () => {
    const view = await service.view(fakePaseo());
    expect(view.logins.find((entry) => entry.id === login.id)?.step).toBe("done");
  });
  const state = await store.read();
  expect(state.accounts.find((account) => account.id === main.id)).toMatchObject({ disabled: true, signedIn: true });
  expect(state.accounts.find((account) => account.id === state.defaults.claude)).toMatchObject({ kind: "managed", home, disabled: false });
  expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual([]);
});

it.each([
  ["codex", "chatgpt|workspace|new@example.com"],
  ["cursor", "cursor|team|member"],
  ["grok", "grok|team|member"],
  ["antigravity", "antigravity|new@example.com"],
] as const)("adds a matching %s login without moving its existing conversations", async (family, identity) => {
  const cli = { ...main, id: MAIN_ACCOUNT_ID[family], family, email: "new@example.com", identity };
  const thread = { accountId: cli.id, family, openedAt: cli.createdAt };
  await seed({
    accounts: [cli] as never,
    bindings: { pinned: { accountId: cli.id, source: "thread", at: cli.createdAt } },
    sessions: { recorded: thread },
  });
  const { service, store, fake } = start({ ...newFake(), mainSignedIn: true, identityKey: identity }, family);
  const paseo = fakePaseo({ pinned: "idle", recorded: "idle" }, family);
  const signIn = async (step: "done" | "failed") => {
    const login = await service.startLogin(family, "code");
    fake.signedIn.add(join(homes(), `${family}-${login.id}`));
    fake.finish({ ok: true, message: null });
    return vi.waitFor(async () => {
      const result = (await service.view(paseo)).logins.find((entry) => entry.id === login.id);
      expect(result?.step).toBe(step);
      return result;
    });
  };

  const added = (await signIn("done"))!.accountId!;
  const paired = await store.read();
  expect(paired.defaults[family]).toBe(added);
  expect(paired.accounts.find((account) => account.id === cli.id)).toMatchObject({ disabled: true, pausedFor: added, signedIn: true });
  expect(paired.accounts.find((account) => account.id === added)).toMatchObject({
    disabled: false, home: join(homes(), added), signedIn: true,
  });

  const route = (agentId: string, reason: "create" | "resume") =>
    chooseAccount(paired, { agentId, family, reason, now: Date.now(), autoSwitch: true, balanceNewAgents: false, portable: false, usageOf: () => null })?.account.id;
  expect(route("new", "create")).toBe(added);
  for (const id of ["pinned", "recorded", "never-routed"]) expect(route(id, "resume")).toBe(cli.id);

  expect((await signIn("failed"))?.message).toContain("already added");
  await service.setAccountEnabled(paseo, cli.id, true);
  expect((await store.read()).accounts.find((account) => account.id === added)?.pausedFor).toBe(cli.id);
  await service.setAccountEnabled(paseo, added, true);
  await service.remove(paseo, added);
  const restored = await store.read();
  expect(restored.defaults[family]).toBe(cli.id);
  expect(restored.accounts.find((account) => account.id === cli.id)).toMatchObject({ disabled: false, signedIn: true });
  expect(restored.bindings.pinned?.accountId).toBe(cli.id);
  expect(restored.bindings.recorded?.accountId).toBe(cli.id);
  expect(fake.calls).not.toContain("logout null");
});

it("pairs existing Antigravity entries when the user selects a new default", async () => {
  const family = "antigravity";
  const identity = "antigravity|new@example.com";
  const cli = { ...main, id: MAIN_ACCOUNT_ID[family], family, signedIn: true, identity };
  const added = { ...managed("antigravity-existing", join(homes(), "antigravity-existing")), family, signedIn: true, identity };
  await seed({ accounts: [cli, added] as never });
  const { service, store } = start({ ...newFake(), mainSignedIn: true, identityKey: identity }, family);

  await service.setDefault(fakePaseo(), added.id);
  const state = await store.read();
  expect(state.defaults.antigravity).toBe(added.id);
  expect(state.accounts.find((account) => account.id === cli.id)).toMatchObject({ disabled: true, pausedFor: added.id, signedIn: true });
  expect(state.accounts.find((account) => account.id === added.id)?.disabled).toBe(false);
});

it("does not pair ChatGPT sign-ins when the workspace could not be verified", async () => {
  const identity = "chatgpt-email|new@example.com|plus";
  const cli = { ...main, id: MAIN_ACCOUNT_ID.codex, family: "codex" as const, email: "new@example.com", identity: "chatgpt|workspace|new@example.com" };
  await seed({ accounts: [cli] as never });
  const { service, store, fake } = start({ ...newFake(), mainSignedIn: true, identityKey: identity }, "codex");
  const login = await service.startLogin("codex", "code");
  fake.signedIn.add(join(homes(), `codex-${login.id}`));
  fake.finish({ ok: true, message: null });

  await vi.waitFor(async () => {
    const result = (await service.view(fakePaseo())).logins.find((entry) => entry.id === login.id);
    expect(result?.step).toBe("failed");
  });
  expect((await store.read()).accounts).toMatchObject([{ id: cli.id, disabled: false }]);
});

describe("signing an account in again as someone else", () => {
  it.each([
    // Outside homes/ is where Claude accounts are kept since #69. Kept signed in as someone else, the
    // next identity check would adopt that login, maybe as a second account on one subscription.
    ["kept outside homes/", external],
    ["in homes/", () => join(homes(), "claude-work01")],
  ])("signs out the login it just wrote, wherever the home is (%s)", async (_, where) => {
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

    expect(fake.calls.filter((call) => call.startsWith("logout"))).toEqual([`logout ${home}`]);
    expect(message).toContain("You signed in as new@example.com, but this is old@example.com.");
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
