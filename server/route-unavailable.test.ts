import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Family } from "../shared/model";
import type { FamilyAdapter } from "./adapter";
import { CursorAdapter } from "./cursor";
import { absentPi } from "./fakes.test-support";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { type Binding, StateStore, type StoredAccount } from "./state";

// A session of a family that isn't available here runs on the CLI login whatever the agent is bound
// to (Cursor off Linux gives an added account no env of its own), so routing leaves it alone and
// doesn't record it under the added account. Families that are available, or not checked yet, are
// routed as before.

let root: string;
const KEYS = ["HOME", "XDG_CONFIG_HOME", "CURSOR_CONFIG_DIR", "CURSOR_API_KEY", "CURSOR_AUTH_TOKEN", "PASEO_HOME"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-route-unavailable-")));
  process.env.PASEO_HOME = join(root, "paseo");
  process.env.HOME = join(root, "me");
  for (const key of KEYS) if (key !== "PASEO_HOME" && key !== "HOME") delete process.env[key];
  await mkdir(join(root, "me", ".config"), { recursive: true });
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

const AGENT = "agent-1";
const EARLIER = new Date(Date.now() - 60_000).toISOString();

function account(family: Family, id: string, kind: "main" | "managed"): StoredAccount {
  return {
    id,
    family,
    label: id,
    autoLabel: false,
    kind,
    auth: "subscription",
    home: kind === "main" ? null : join(root, "paseo", "zerosub", "homes", id),
    email: null,
    plan: null,
    organization: null,
    identity: id,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    createdAt: EARLIER,
  };
}

/** A stand-in `cursor-agent` a Paseo provider in the daemon's config runs. */
async function fakeCursor(): Promise<void> {
  const path = join(root, "bin", "cursor-agent");
  await mkdir(join(root, "bin"), { recursive: true });
  await writeFile(path, "#!/bin/sh\necho 2026.11.13\n");
  await chmod(path, 0o755);
  await mkdir(join(root, "paseo"), { recursive: true });
  await writeFile(
    join(root, "paseo", "config.json"),
    JSON.stringify({ agents: { providers: { cursor: { extends: "acp", label: "Cursor", command: [path, "acp"], env: {} } } } }),
  );
}

/** A Claude/Codex stand-in whose availability the test sets; an account's home goes into `HOME_VAR`. */
function fakeAdapter(family: "claude" | "codex", availability: { ok: boolean }): FamilyAdapter {
  return {
    ...absentPi(),
    family,
    portable: true,
    available: async () => ({ ok: availability.ok, detail: availability.ok ? null : "not installed (test)" }),
    env: async (home: string | null) => ({ HOME_VAR: home }),
  };
}

/**
 * A service with the CLI login and an added account of `family`, and agent 1 bound to the added
 * account, whose last session was recorded there (the registry was last used where it worked).
 */
async function setUp(family: Family, adapters: Partial<Record<Family, FamilyAdapter>>) {
  const store = new StateStore(join(root, "paseo", "zerosub", "state.json"));
  const binding: Binding = { accountId: `${family}-a`, source: "user", at: EARLIER };
  await store.update((draft) => {
    draft.accounts.push(account(family, `${family}-main`, "main"), account(family, `${family}-a`, "managed"));
    draft.bindings[AGENT] = binding;
    draft.sessions[AGENT] = { accountId: `${family}-a`, family, openedAt: EARLIER };
  });
  const service = new Service(
    { claude: fakeAdapter("claude", { ok: false }), codex: fakeAdapter("codex", { ok: false }), pi: absentPi(), ...adapters },
    store,
    { resolve: async () => ({ [family]: family }) } as unknown as FamilyResolver,
    { locate: async () => null } as unknown as Reopener,
  );
  const paseo = { agents: { ref: () => ({ refresh: async () => ({ agent: { id: AGENT, provider: family, status: "idle", labels: {} } }) }) } };
  const open = (purpose: "interactive" | "title" = "interactive") =>
    service.onSessionOpen({ agentId: AGENT, provider: family, reason: "resume", purpose, env: { KEEP: "1" } } as never, { paseo } as never);
  /** Checks availability, as startup and upkeep do. */
  const check = () => (service as unknown as { ensureFamily(family: Family): Promise<void> }).ensureFamily(family);
  return { service, store, binding, open, check };
}

describe("routing a session of a family that isn't available", () => {
  for (const platform of ["darwin", "win32"] as const) {
    it(`leaves a Cursor session bound to an added account on the CLI login on ${platform}, and doesn't record it there`, async () => {
      const { service, store, binding, open, check } = await setUp("cursor", { cursor: new CursorAdapter(platform) });
      await check();
      // Paseo opens it as it asked: with the daemon's environment, so on the CLI login.
      expect(await open()).toBeUndefined();
      expect(await open("title")).toBeUndefined();
      const state = await store.read();
      // Nothing records it under the added account, so it counts as the CLI login's…
      expect(state.sessions[AGENT]).toBeUndefined();
      // …and its binding stays, for when Cursor works here again.
      expect(state.bindings[AGENT]).toEqual(binding);
      await service.stop();
    });
  }

  it("routes a Cursor session to its added account on Linux, as before", async () => {
    await fakeCursor();
    const { service, store, binding, open, check } = await setUp("cursor", { cursor: new CursorAdapter("linux") });
    await check();
    const routed = await open();
    expect(routed?.env).toMatchObject({ XDG_CONFIG_HOME: join(root, "paseo", "zerosub", "homes", "cursor-a"), KEEP: "1" });
    const state = await store.read();
    expect(state.sessions[AGENT]).toMatchObject({ accountId: "cursor-a", family: "cursor" });
    expect(Date.parse(state.sessions[AGENT]!.openedAt)).toBeGreaterThan(Date.parse(EARLIER));
    expect(state.bindings[AGENT]).toEqual(binding);
    await service.stop();
  });

  for (const family of ["claude", "codex"] as const) {
    it(`routes an available ${family} session to its added account, as before`, async () => {
      const { service, store, open, check } = await setUp(family, { [family]: fakeAdapter(family, { ok: true }) });
      await check();
      expect((await open())?.env).toMatchObject({ HOME_VAR: join(root, "paseo", "zerosub", "homes", `${family}-a`) });
      expect((await store.read()).sessions[AGENT]).toMatchObject({ accountId: `${family}-a` });
      await service.stop();
    });

    it(`routes a ${family} session as before while availability hasn't been checked yet`, async () => {
      // Its check would say it isn't there, but a session can open before startup has checked.
      const { service, store, open } = await setUp(family, { [family]: fakeAdapter(family, { ok: false }) });
      expect((await open())?.env).toMatchObject({ HOME_VAR: join(root, "paseo", "zerosub", "homes", `${family}-a`) });
      expect((await store.read()).sessions[AGENT]).toMatchObject({ accountId: `${family}-a` });
      await service.stop();
    });
  }

  it("routes to the bound account again once the family is available again", async () => {
    const availability = { ok: false };
    const { service, store, binding, open, check } = await setUp("claude", { claude: fakeAdapter("claude", availability) });
    await check();
    expect(await open()).toBeUndefined();
    expect((await store.read()).sessions[AGENT]).toBeUndefined();
    availability.ok = true;
    await check();
    expect((await open())?.env).toMatchObject({ HOME_VAR: join(root, "paseo", "zerosub", "homes", "claude-a") });
    const state = await store.read();
    expect(state.sessions[AGENT]).toMatchObject({ accountId: "claude-a" });
    expect(state.bindings[AGENT]).toEqual(binding);
    await service.stop();
  });
});
