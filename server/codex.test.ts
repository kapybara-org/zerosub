import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "./codex";
import { absentPi } from "./fakes.test-support";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

const responses = vi.hoisted(() => ({ email: "first@example.com", workspace: "team-workspace", plan: "team", limitsFail: false }));

vi.mock("./binaries", () => ({ providerCommand: async () => ({ command: "codex", prefix: [] }) }));
// Replace only the external CLI transport; exercise the adapter's real snapshot/identity code.
vi.mock("node:child_process", () => ({
  spawn: () => {
    const child = new EventEmitter();
    const stdout = new PassThrough();
    return Object.assign(child, {
      stdout,
      stderr: new PassThrough(),
      stdin: new Writable({
        write(chunk, _encoding, callback) {
          const request = JSON.parse(chunk.toString());
          if (request.id !== undefined && request.method === "account/rateLimits/read" && responses.limitsFail) {
            queueMicrotask(() => stdout.write(JSON.stringify({ id: request.id, error: { message: "rate limits unavailable" } }) + "\n"));
          } else if (request.id !== undefined) {
            const result = request.method === "account/read"
              ? { account: { type: "chatgpt", email: responses.email, planType: responses.plan } }
              : request.method === "account/rateLimits/read"
                ? { accountId: responses.workspace, rateLimits: null }
                : {};
            queueMicrotask(() => stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
          }
          callback();
        },
      }),
      kill: () => child.emit("close", 0),
    });
  },
}));

beforeEach(() => Object.assign(responses, { email: "first@example.com", workspace: "team-workspace", plan: "team", limitsFail: false }));

describe("Codex account identity", () => {
  it("distinguishes different members of the same workspace", async () => {
    const first = await new CodexAdapter().identity(null);
    responses.email = "second@example.com";
    const second = await new CodexAdapter().identity(null);
    expect(first.identity).not.toBe(second.identity);
  });

  it("recognizes the same member despite email casing or a plan change", async () => {
    const first = await new CodexAdapter().identity(null);
    responses.email = "FIRST@EXAMPLE.COM";
    responses.plan = "business";
    expect((await new CodexAdapter().identity(null)).identity).toBe(first.identity);
  });

  it("keeps one member's personal and team workspaces distinct", async () => {
    const team = await new CodexAdapter().identity(null);
    responses.workspace = "personal-workspace";
    expect((await new CodexAdapter().identity(null)).identity).not.toBe(team.identity);
  });
});

describe("an identity check while Codex can't read the rate limits", () => {
  it("still knows the CLI login's member by email, so its limit and workspace stay", async () => {
    const root = await mkdtemp(join(tmpdir(), "zerosub-codex-"));
    const store = new StateStore(join(root, "state.json"));
    const identity = "chatgpt|team-workspace|first@example.com";
    const limitedUntil = new Date(Date.now() + 60 * 60_000).toISOString();
    await store.update((draft) => {
      draft.accounts.push({
        id: MAIN_ACCOUNT_ID.codex, family: "codex", label: "first", autoLabel: false,
        kind: "main", auth: "subscription", home: null, email: "first@example.com", plan: "team", organization: null,
        identity, signedIn: true, disabled: false, limitedUntil, limitKind: "window",
        limitedAt: new Date().toISOString(), limitSource: "turn", createdAt: new Date().toISOString(),
      });
    });
    responses.limitsFail = true;
    const adapter = new CodexAdapter();
    const service = new Service(
      { claude: adapter as never, codex: adapter, pi: absentPi() },
      store,
      { resolve: async () => ({ codex: "codex" as const }) } as unknown as FamilyResolver,
      { locate: async () => null } as unknown as Reopener,
    );
    try {
      await (service as unknown as { refreshIdentity(id: string): Promise<void> }).refreshIdentity(MAIN_ACCOUNT_ID.codex);
      // The key Codex gave then names no workspace.
      expect((await adapter.identity(null)).identity).toBe("chatgpt-email|first@example.com|team");
      expect((await store.read()).accounts[0]).toMatchObject({ identity, limitedUntil, limitKind: "window" });
    } finally {
      await service.stop();
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  });
});
