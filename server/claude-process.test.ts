import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "./claude";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("./binaries", () => ({
  providerCommand: async () => ({ command: "fake-claude", prefix: [] }),
  browserCaptureScript: async () => null,
}));

function childProcess() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

describe("Claude sign-in process cleanup", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("escalates a canceled sign-in that ignores SIGTERM", async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const login = await new ClaudeAdapter().login(null, "browser");
    login.cancel();
    login.cancel();
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    child.emit("close", null);
    await expect(login.finished).resolves.toEqual({ ok: false, message: "Sign-in was canceled." });
  });

  it("does not signal a child again after it has exited", async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const login = await new ClaudeAdapter().login(null, "browser");
    login.cancel();
    child.emit("close", null);
    await login.finished;
    await vi.advanceTimersByTimeAsync(3_000);
    login.cancel();
    expect(child.kill.mock.calls).toEqual([["SIGTERM"]]);
  });

  it("reports the latest sign-in failure after noisy output", async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const login = await new ClaudeAdapter().login(null, "browser");
    child.stderr.write(Buffer.alloc(2 * 1024 * 1024, "x"));
    child.stderr.write("\nLogin failed: rejected by provider\n");
    child.emit("close", 1);
    await expect(login.finished).resolves.toEqual({ ok: false, message: "Sign-in failed: rejected by provider" });
  });
});
