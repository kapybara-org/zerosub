import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "./codex";

const responses = vi.hoisted(() => ({ email: "first@example.com", workspace: "team-workspace", plan: "team" }));

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
          if (request.id !== undefined) {
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

beforeEach(() => Object.assign(responses, { email: "first@example.com", workspace: "team-workspace", plan: "team" }));

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
