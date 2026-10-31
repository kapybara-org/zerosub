import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter, Identity } from "./adapter";
import { Service } from "./service";
import { StateStore } from "./state";

let root: string;
let service: Service;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "zerosub-login-")); });
afterEach(async () => {
  await service?.stop();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function login(email: string | null, existingId?: string, storedEmail = "first@example.com") {
  vi.stubEnv("PASEO_HOME", root);
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => {
    // An account saved by 1.2.1, not yet refreshed by background upkeep.
    draft.accounts.push({
      id: "codex-existing", family: "codex", label: "first", autoLabel: false,
      kind: "managed", home: root, email: storedEmail, plan: "team", organization: null,
      identity: "chatgpt|team-workspace", signedIn: true, disabled: false,
      limitedUntil: null, limitKind: null, limitedAt: null, createdAt: new Date().toISOString(),
    });
  });
  const identity: Identity = {
    signedIn: true, email, plan: "team", organization: null,
    identity: email ? `chatgpt|team-workspace|${email.toLowerCase()}` : "chatgpt|team-workspace",
  };
  const adapter: FamilyAdapter = {
    family: "codex", portable: false, usageSpacingMs: 0,
    available: async () => ({ ok: true, detail: null }),
    prepareHome: async () => undefined, env: async () => ({}),
    identity: async (home) => home ? identity : { ...identity, email: "cli@example.com", identity: "chatgpt|other-workspace|cli@example.com" },
    usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
    login: async () => ({
      progress: { step: "starting", url: null, codeUrl: null, userCode: null, message: null },
      onProgress: () => undefined, submitCode: async () => undefined, cancel: () => undefined,
      finished: Promise.resolve({ ok: true, message: null }),
    }),
    logout: async () => undefined,
    detectLimit: () => null, detectSignOut: () => null,
    redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
  };
  service = new Service({ codex: adapter, claude: adapter }, store);
  const started = await service.startLogin("codex", "browser", existingId);
  let view = started;
  await vi.waitFor(async () => {
    view = await service.submitCode(started.id, "");
    expect(["done", "failed"]).toContain(view.step);
  });
  return { view, state: await store.read() };
}

describe("Codex login with legacy account identities", () => {
  it("adds a different member in the same workspace", async () => {
    const { view, state } = await login("second@example.com");
    expect(view.step).toBe("done");
    expect(state.accounts.filter((a) => a.kind === "managed")).toHaveLength(2);
  });

  it("still rejects a duplicate member before legacy identity refresh", async () => {
    const { view, state } = await login("FIRST@EXAMPLE.COM");
    expect(view.step).toBe("failed");
    expect(view.message).toContain("already added");
    expect(state.accounts.filter((a) => a.kind === "managed")).toHaveLength(1);
  });

  it("lets a legacy member sign back in and upgrades its stored identity", async () => {
    const { view, state } = await login("first@example.com", "codex-existing");
    expect(view.step).toBe("done");
    expect(state.accounts.find((a) => a.id === "codex-existing")?.identity)
      .toBe("chatgpt|team-workspace|first@example.com");
  });

  it("does not let another member replace a legacy managed account", async () => {
    const { view, state } = await login("second@example.com", "codex-existing");
    expect(view.step).toBe("failed");
    expect(view.message).toContain("use Add account");
    expect(state.accounts.find((a) => a.id === "codex-existing")?.email).toBe("first@example.com");
  });

  it("does not replace a known member when sign-in cannot identify the member", async () => {
    const { view, state } = await login(null, "codex-existing");
    expect(view.step).toBe("failed");
    expect(view.message).toContain("Couldn't tell which workspace member signed in");
    expect(state.accounts.find((a) => a.id === "codex-existing")?.email).toBe("first@example.com");
  });
});
