import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `claude auth status` reports "not logged in" whenever Claude Code couldn't read the Keychain entry
// (locked keychain, `security` slower than its own 2 s limit). These run against stand-ins for both
// commands, on every platform as if it were macOS; the real Keychain is never touched.

let status = { loggedIn: false };
let keychain: { code: number; stdout: string } = { code: 44, stdout: "" };

vi.mock("./process", async (original) => ({
  ...(await original<typeof import("./process")>()),
  run: vi.fn(async (command: string) => {
    if (command === "/usr/bin/security") return { ...keychain, stderr: "", timedOut: false };
    return { code: 0, stdout: JSON.stringify(status), stderr: "", timedOut: false };
  }),
}));

const { ClaudeAdapter } = await import("./claude");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;

beforeEach(() => {
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  status = { loggedIn: false };
  keychain = { code: 44, stdout: "" };
});

const HOME = "/Users/ada/.paseo/zerosub/homes/claude-aaaaaaaaaaaa";

describe("whether a Claude account is signed out", () => {
  it("is when Claude Code says so and its keychain entry is gone", async () => {
    expect((await new ClaudeAdapter().identity(HOME)).signedIn).toBe(false);
  });

  it("is when the entry is there but holds no sign-in", async () => {
    keychain = { code: 0, stdout: '{"mcpOAuth":{}}\n' };
    expect((await new ClaudeAdapter().identity(HOME)).signedIn).toBe(false);
  });

  it("isn't decided while the entry can't be read, or still holds a sign-in", async () => {
    keychain = { code: 36, stdout: "" }; // the keychain is locked
    await expect(new ClaudeAdapter().identity(HOME)).rejects.toThrow(/couldn't be read or still holds one/);
    keychain = { code: 0, stdout: '{"claudeAiOauth":{"accessToken":"sk-ant-oat-…","expiresAt":1}}\n' };
    await expect(new ClaudeAdapter().identity(HOME)).rejects.toThrow(/couldn't be read or still holds one/);
  });

  it("doesn't ask the keychain when Claude Code says it's signed in", async () => {
    status = { loggedIn: true };
    keychain = { code: 36, stdout: "" };
    expect((await new ClaudeAdapter().identity(HOME)).signedIn).toBe(true);
  });

  it("takes Claude Code's answer off macOS, where the sign-in is a file in the home", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    keychain = { code: 36, stdout: "" };
    expect((await new ClaudeAdapter().identity(HOME)).signedIn).toBe(false);
  });
});
