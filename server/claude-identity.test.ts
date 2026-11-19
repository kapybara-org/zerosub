import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `claude auth status` reports "not logged in" whenever Claude Code couldn't read the Keychain entry
// (locked keychain, `security` slower than its own 2 s limit). These run against stand-ins for both
// commands, on every platform as if it were macOS; the real Keychain is never touched.

let status: { loggedIn: boolean; subscriptionType?: string; email?: string; orgId?: string } = { loggedIn: false };
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

  it.each([
    ["default_claude_max_20x", "ultra"],
    ["default_claude_max_5x", "max"],
    [undefined, "max"],
  ])("distinguishes a legacy Max login with tier %s", async (rateLimitTier, plan) => {
    status = { loggedIn: true, subscriptionType: "max" };
    keychain = { code: 0, stdout: JSON.stringify({ claudeAiOauth: { rateLimitTier } }) };
    expect((await new ClaudeAdapter().identity(HOME)).plan).toBe(plan);
  });

  it("reports a changed plan from the matching profile even when sign-in credentials keep the old tier", async () => {
    const home = await mkdtemp(join(tmpdir(), "zerosub-claude-plan-"));
    const file = join(home, ".claude.json");
    status = { loggedIn: true, subscriptionType: "max", email: "ada@example.com", orgId: "org-1" };
    keychain = { code: 0, stdout: '{"claudeAiOauth":{"rateLimitTier":"default_claude_max_20x"}}' };
    const adapter = new ClaudeAdapter();
    const profile = { emailAddress: "ada@example.com", organizationUuid: "org-1", organizationRateLimitTier: "default_claude_max_5x" };
    try {
      await writeFile(file, JSON.stringify({ oauthAccount: { ...profile, organizationUuid: "other-org" } }));
      expect((await adapter.identity(home)).plan).toBe("ultra");
      await writeFile(file, JSON.stringify({ oauthAccount: profile }));
      expect((await adapter.identity(home)).plan).toBe("max");
      await writeFile(file, JSON.stringify({ oauthAccount: { ...profile, planDisplayName: "Ultra" } }));
      expect((await adapter.identity(home)).plan).toBe("Ultra");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("uses the live plan after an upgrade while Claude's local profile still shows Max", async () => {
    const home = await mkdtemp(join(tmpdir(), "zerosub-live-plan-"));
    status = { loggedIn: true, subscriptionType: "max", email: "ada@example.com", orgId: "org-1" };
    keychain = { code: 0, stdout: '{"claudeAiOauth":{"accessToken":"test-only-token","rateLimitTier":"default_claude_max_5x"}}' };
    const fetchProfile = vi.fn(async () => Response.json({
      account: { email: "ada@example.com" },
      organization: { uuid: "org-1", plan_display_name: "Ultra" },
    }));
    vi.stubGlobal("fetch", fetchProfile);
    vi.stubEnv("NO_PROXY", "api.anthropic.com");
    vi.stubEnv("no_proxy", "api.anthropic.com");
    try {
      await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: {
        emailAddress: "ada@example.com", organizationUuid: "org-1", organizationRateLimitTier: "default_claude_max_5x",
      } }));
      const adapter = new ClaudeAdapter();
      expect((await adapter.identity(home)).plan).toBe("max");
      expect((await adapter.identity(home, { livePlan: true })).plan).toBe("Ultra");
      expect(fetchProfile).toHaveBeenCalledExactlyOnceWith("https://api.anthropic.com/api/oauth/profile", expect.any(Object));
      fetchProfile.mockResolvedValueOnce(Response.json({
        account: { email: "ada@example.com" },
        organization: { uuid: "other-org", plan_display_name: "Ultra" },
      }));
      expect((await adapter.identity(home, { livePlan: true })).plan).toBe("max");
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  });

  it("takes Claude Code's answer off macOS, where the sign-in is a file in the home", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    keychain = { code: 36, stdout: "" };
    expect((await new ClaudeAdapter().identity(HOME)).signedIn).toBe(false);
  });
});
