import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter, keychainService } from "./claude";

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

  it("keeps a character split across two writes whole", async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    const login = await new ClaudeAdapter().login(null, "browser");
    const failure = Buffer.from("Login failed: no account for zoë@example.com\n");
    const cut = failure.indexOf(Buffer.from("ë")) + 1; // between the two bytes of "ë"
    child.stderr.write(failure.subarray(0, cut));
    child.stderr.write(failure.subarray(cut));
    child.emit("close", 1);
    await expect(login.finished).resolves.toEqual({ ok: false, message: "Sign-in failed: no account for zoë@example.com" });
  });
});

describe("signing a home out on macOS", () => {
  const platform = process.platform;
  beforeEach(() => Object.defineProperty(process, "platform", { value: "darwin" }));
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.clearAllMocks();
  });

  /** Each command run next exits with the given code: the CLI's logout first, then `security`. */
  function exitWith(...codes: number[]) {
    for (const code of codes) {
      spawn.mockImplementationOnce(() => {
        const child = childProcess();
        setImmediate(() => child.emit("close", code));
        return child;
      });
    }
  }

  it.each([
    [0, 0],
    [0, 44],
    [1, 0],
    [1, 44],
  ])("is done once the keychain entry is gone (the CLI's logout exits %i, security %i)", async (cli, code) => {
    exitWith(cli, code);
    await expect(new ClaudeAdapter().logout("/tmp/zerosub-home")).resolves.toBeUndefined();
    expect(spawn.mock.calls.map(([command]) => command)).toEqual(["fake-claude", "/usr/bin/security"]);
    expect(spawn.mock.calls[1]?.[1]).toContain(keychainService("/tmp/zerosub-home"));
  });

  it("fails while the keychain entry is still there, so the home isn't deleted over a live sign-in", async () => {
    exitWith(1, 51);
    await expect(new ClaudeAdapter().logout("/tmp/zerosub-home")).rejects.toThrow(
      `Couldn't sign /tmp/zerosub-home out, but couldn't remove its keychain entry "${keychainService("/tmp/zerosub-home")}" (exit 51)`,
    );
  });

  it("fails after a logout the CLI calls done whose keychain entry is left behind", async () => {
    exitWith(0, 51);
    await expect(new ClaudeAdapter().logout("/tmp/zerosub-home")).rejects.toThrow("Signed /tmp/zerosub-home out, but couldn't remove its keychain entry");
  });
});

describe("reading whether a home is signed in, on macOS", () => {
  const platform = process.platform;
  beforeEach(() => Object.defineProperty(process, "platform", { value: "darwin" }));
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: platform });
    vi.clearAllMocks();
  });

  /** Each command run next prints `stdout` and exits with `code`: the CLI's `auth status` first, then `security`. */
  function answer(...replies: Array<{ stdout?: string; code: number }>) {
    for (const { stdout = "", code } of replies) {
      spawn.mockImplementationOnce(() => {
        const child = childProcess();
        setImmediate(() => {
          child.stdout.write(stdout);
          setImmediate(() => child.emit("close", code));
        });
        return child;
      });
    }
  }
  const noSignIn = { stdout: JSON.stringify({ loggedIn: false }), code: 0 };
  const signIn = JSON.stringify({ claudeAiOauth: { accessToken: "token-for-test", expiresAt: 0, scopes: [] } });

  it.each([
    ["is gone", { code: 44 }],
    ["holds no sign-in", { stdout: JSON.stringify({ mcpOAuth: {} }), code: 0 }],
  ])("takes the CLI's word that it's signed out once its keychain entry %s", async (_, entry) => {
    answer(noSignIn, entry);
    await expect(new ClaudeAdapter().identity("/tmp/zerosub-home")).resolves.toMatchObject({ signedIn: false });
    expect(spawn.mock.calls.map(([command]) => command)).toEqual(["fake-claude", "/usr/bin/security"]);
  });

  it.each([
    ["can't be read (keychain locked)", { code: 36 }],
    ["still holds a sign-in", { stdout: signIn, code: 0 }],
  ])("can't tell, rather than call it signed out, when its keychain entry %s", async (_, entry) => {
    answer(noSignIn, entry);
    await expect(new ClaudeAdapter().identity("/tmp/zerosub-home")).rejects.toThrow("couldn't be read or still holds one");
  });

  it("doesn't look at the keychain for a home the CLI says is signed in", async () => {
    answer({ stdout: JSON.stringify({ loggedIn: true, email: "work@example.com" }), code: 0 });
    await expect(new ClaudeAdapter().identity("/tmp/zerosub-home")).resolves.toMatchObject({ signedIn: true, email: "work@example.com" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});
