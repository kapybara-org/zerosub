import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "./claude";

const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("./process", async (original) => ({ ...(await original<typeof import("./process")>()), run }));
vi.mock("./binaries", () => ({
  providerCommand: async () => ({ command: "fake-claude", prefix: [] }),
  browserCaptureScript: async () => null,
}));

const HOME = "/tmp/zerosub-test-home";
const USAGE = { five_hour: { utilization: 12, resets_at: "2026-09-23T10:00:00Z" }, seven_day: { utilization: 40, resets_at: null } };

let expiresAt = 0;
let renewals = 0;

function credentials(): string {
  return JSON.stringify({ claudeAiOauth: { accessToken: "test-access", expiresAt, scopes: ["user:profile", "user:inference"] } });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-09-23T08:00:00Z"));
  expiresAt = Date.now() - 60_000;
  renewals = 0;
  run.mockImplementation(async (command: string, args: string[]) => {
    if (command === "/usr/bin/security") return { code: 0, stdout: credentials(), stderr: "", timedOut: false };
    if (command === "fake-claude" && args.includes("/usage")) {
      renewals += 1;
      expiresAt = Date.now() + 8 * 60 * 60_000; // Claude Code refreshed the sign-in.
      return { code: 0, stdout: "{}", stderr: "", timedOut: false };
    }
    throw new Error(`unexpected command ${command}`);
  });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(USAGE), { status: 200 })));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("Claude usage on an idle account whose sign-in expired", () => {
  it("has Claude Code renew it during a background read and returns a live reading", async () => {
    const usage = await new ClaudeAdapter().usage(HOME);
    expect(renewals).toBe(1);
    expect(usage).toMatchObject({ cached: false, error: null });
    expect(usage.windows.map((window) => window.usedPercent)).toEqual([12, 40]);
  });

  it("renews in the background at most once per half hour, but always on an explicit refresh", async () => {
    const adapter = new ClaudeAdapter();
    run.mockImplementation(async (command: string, args: string[]) => {
      if (command === "/usr/bin/security") return { code: 0, stdout: credentials(), stderr: "", timedOut: false };
      if (args.includes("/usage")) renewals += 1; // A renewal that couldn't refresh the sign-in.
      return { code: 1, stdout: "", stderr: "", timedOut: false };
    });
    await adapter.usage(HOME);
    await adapter.usage(HOME);
    expect(renewals).toBe(1);
    await adapter.usage(HOME, { renewLogin: true });
    expect(renewals).toBe(2);
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await adapter.usage(HOME);
    expect(renewals).toBe(3);
  });

  it("leaves a sign-in that is still fresh alone", async () => {
    expiresAt = Date.now() + 60 * 60_000;
    await new ClaudeAdapter().usage(HOME);
    expect(renewals).toBe(0);
  });
});
