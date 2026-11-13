import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import type { ApiConfig } from "./homes";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore } from "./state";
import { absentPi } from "./fakes.test-support";

const OFF = { disableTelemetry: false, disableErrorReporting: false, disableNonessentialTraffic: false };

let root: string;
let previousHome: string | undefined;
let previousLaunchers: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-api-"));
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

/** A Claude adapter that records what the service asks of it; `failApi` makes storing the key fail. */
function recordingAdapter(calls: string[], failApi: { now: boolean }): FamilyAdapter {
  return {
    family: "claude",
    portable: true,
    usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async (home: string) => void calls.push(`prepare ${home}`),
    env: async () => ({}),
    identity: async (home: string | null) => {
      calls.push(`identity ${home}`);
      return { signedIn: true, email: null, plan: null, organization: null, identity: null };
    },
    usage: async (home: string | null) => {
      calls.push(`usage ${home}`);
      return { fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null };
    },
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
    login: async (home: string | null) => {
      calls.push(`login ${home}`);
      throw new Error("not in tests");
    },
    logout: async () => undefined,
    detectLimit: () => null,
    detectSignOut: () => null,
    proxy: async () => null,
    setProxy: async (home: string, proxy: string | null) => void calls.push(`proxy ${home} ${proxy}`),
    api: async () => null,
    setApi: async (home: string, config: ApiConfig) => {
      // The real one creates the home's overrides before it can fail.
      await mkdir(home, { recursive: true });
      if (failApi.now) throw new Error("Claude Code is writing this account's settings right now. Try again in a moment.");
      calls.push(`api ${home} ${JSON.stringify(config)}`);
    },
  } as unknown as FamilyAdapter;
}

async function setUp() {
  const store = new StateStore(join(root, "state.json"));
  const calls: string[] = [];
  const failApi = { now: false };
  const adapter = recordingAdapter(calls, failApi);
  const service = new Service(
    { claude: adapter, codex: { ...adapter, family: "codex" } as FamilyAdapter, pi: absentPi() },
    store,
    { resolve: async () => ({ claude: "claude" as const }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  return { service, store, calls, failApi };
}

const KEY = "sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa-1111";

describe("adding an API account", () => {
  it("sets the proxy, then the key, then the home, and stores a named API account", async () => {
    const { service, store, calls } = await setUp();
    const id = await service.addApiAccount({
      label: " Gateway ",
      keyKind: "auth_token",
      key: ` ${KEY} `,
      baseUrl: "https://gw.example.com/",
      proxy: "http://127.0.0.1:7890",
      disableTelemetry: true,
    });
    const home = join(root, "zerosub", "homes", id);
    expect(calls).toEqual([
      `proxy ${home} http://127.0.0.1:7890`,
      `api ${home} ${JSON.stringify({ ...OFF, disableTelemetry: true, keyKind: "auth_token", key: KEY, baseUrl: "https://gw.example.com" })}`,
      `prepare ${home}`,
    ]);
    const account = (await store.read()).accounts.find((entry) => entry.id === id);
    expect(account).toMatchObject({ auth: "api", label: "Gateway", autoLabel: false, kind: "managed", home, signedIn: true });
    // The key itself is never kept in ZeroSub's state, and the saved account is off the cleanup list.
    expect(JSON.stringify(await store.read())).not.toContain(KEY);
    expect((await store.read()).cleanup).toEqual({});
  });

  it("refuses the same key twice for the same endpoint, but not for another one", async () => {
    const { service } = await setUp();
    await service.addApiAccount({ label: "One", keyKind: "api_key", key: KEY });
    await expect(service.addApiAccount({ label: "Two", keyKind: "api_key", key: KEY })).rejects.toThrow(/already added as "One"/);
    await expect(service.addApiAccount({ label: "Two", keyKind: "api_key", key: KEY, baseUrl: "https://gw.example.com" })).resolves.toMatch(
      /^claude-/,
    );
  });

  it("checks the base URL and proxy before creating anything", async () => {
    const { service, store, calls } = await setUp();
    await expect(service.addApiAccount({ label: "x", keyKind: "api_key", key: KEY, baseUrl: "gw.example.com" })).rejects.toThrow();
    await expect(service.addApiAccount({ label: "x", keyKind: "api_key", key: KEY, proxy: "socks5://127.0.0.1:7891" })).rejects.toThrow(/socks5/);
    expect(calls).toEqual([]);
    expect((await store.read()).accounts.filter((entry) => entry.auth === "api")).toEqual([]);
  });

  it("removes the half-made home when storing the key fails", async () => {
    const { service, store, failApi } = await setUp();
    failApi.now = true;
    await expect(service.addApiAccount({ label: "x", keyKind: "api_key", key: KEY })).rejects.toThrow(/Try again/);
    expect(await readdir(join(root, "zerosub", "homes")).catch(() => [])).toEqual([]);
    expect((await store.read()).accounts.filter((entry) => entry.auth === "api")).toEqual([]);
    expect((await store.read()).cleanup).toEqual({});
  });
});

describe("an API account", () => {
  it("has no sign-in, usage windows or banked resets", async () => {
    const { service, calls } = await setUp();
    const id = await service.addApiAccount({ label: "Gateway", keyKind: "api_key", key: KEY });
    calls.length = 0;
    await expect(service.startLogin("claude", "code", id)).rejects.toThrow(/API key/);
    await service.refreshUsage(id, true);
    await expect(service.redeem({} as never, id)).rejects.toThrow(/no banked resets/);
    expect(calls.filter((call) => /^(login|usage) /.test(call))).toEqual([]);
  });

  it("takes a new key, and spots a duplicate when it moves to another account's endpoint", async () => {
    const { service, store, calls } = await setUp();
    const first = await service.addApiAccount({ label: "One", keyKind: "api_key", key: KEY, baseUrl: "https://a.example.com" });
    const second = await service.addApiAccount({ label: "Two", keyKind: "api_key", key: KEY, baseUrl: "https://b.example.com" });
    await expect(service.updateApiAccount(second, { keyKind: "api_key", key: KEY, baseUrl: "https://a.example.com/" })).rejects.toThrow(
      /already added as "One"/,
    );

    await store.update((draft) => {
      const target = draft.accounts.find((entry) => entry.id === first);
      if (target) target.signedIn = false;
    });
    calls.length = 0;
    // Saving without a key keeps it, and tries the account again.
    await service.updateApiAccount(first, { keyKind: "api_key", baseUrl: "https://a.example.com", disableNonessentialTraffic: true });
    expect(calls).toEqual([
      `api ${join(root, "zerosub", "homes", first)} ${JSON.stringify({ ...OFF, disableNonessentialTraffic: true, keyKind: "api_key", key: null, baseUrl: "https://a.example.com" })}`,
    ]);
    expect((await store.read()).accounts.find((entry) => entry.id === first)?.signedIn).toBe(true);
    // Once the first one has a new key, the second may take its old one there.
    await service.updateApiAccount(first, { keyKind: "api_key", key: `${KEY}-new`, baseUrl: "https://a.example.com" });
    await expect(service.updateApiAccount(second, { keyKind: "api_key", key: KEY, baseUrl: "https://a.example.com" })).resolves.toBeUndefined();
  });

  it("stays marked as refused through the background check-ups, which can't tell a working key", async () => {
    const { service, store, calls } = await setUp();
    const id = await service.addApiAccount({ label: "Gateway", keyKind: "api_key", key: KEY });
    const other = await service.addApiAccount({ label: "Other", keyKind: "api_key", key: `${KEY}-2` });
    await store.update((draft) => {
      for (const entry of draft.accounts) if (entry.id === id) entry.signedIn = false;
      // A subscription account checked in the same round, to know the round has run.
      for (const entry of draft.accounts) if (entry.id === other) entry.auth = "subscription";
    });
    await service.start();
    try {
      const otherHome = join(root, "zerosub", "homes", other);
      await vi.waitFor(() => expect(calls).toContain(`identity ${otherHome}`));
      expect(calls).not.toContain(`identity ${join(root, "zerosub", "homes", id)}`);
      expect((await store.read()).accounts.find((entry) => entry.id === id)?.signedIn).toBe(false);
    } finally {
      await service.stop();
    }
  });

  it("can't be turned into one by editing a subscription account", async () => {
    const { service, store } = await setUp();
    await store.update((draft) => {
      draft.accounts.push({
        id: "claude-sub",
        family: "claude",
        label: "Work",
        autoLabel: false,
        kind: "managed",
        auth: "subscription",
        home: join(root, "zerosub", "homes", "claude-sub"),
        email: null,
        plan: null,
        organization: null,
        identity: null,
        signedIn: true,
        disabled: false,
        limitedUntil: null,
        limitKind: null,
        limitedAt: null,
        createdAt: new Date().toISOString(),
      });
    });
    await expect(service.updateApiAccount("claude-sub", { keyKind: "api_key", key: KEY })).rejects.toThrow(/subscription/);
  });
});
