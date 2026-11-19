import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatExtraUsage } from "../shared/format";
import { UsageSchema } from "../shared/model";
import { ClaudeAdapter } from "./claude";
import { proxiedFetch } from "./proxy";
import { mergeUsage } from "./usage";

// The real one, watched; a test can answer in its place, which then sends nothing anywhere.
vi.mock("./proxy", async (original) => {
  const actual = await original<typeof import("./proxy")>();
  return { ...actual, proxiedFetch: vi.fn(actual.proxiedFetch) };
});

// Never the real `security`: on macOS the token is looked for in the Keychain first, and a test's home
// has no entry there (44, errSecItemNotFound), so it's read from the home's own file.
vi.mock("./process", async (original) => {
  const actual = await original<typeof import("./process")>();
  return {
    ...actual,
    run: (...args: Parameters<typeof actual.run>) =>
      args[0].endsWith("security") ? Promise.resolve({ code: 44, stdout: "", stderr: "", timedOut: false }) : actual.run(...args),
  };
});

// A synthetic home with a made-up token; `fetch` is stubbed, so nothing real is read or called.
let home: string;
const calls: string[] = [];
/** Proxy settings the daemon may have: cleared, so the reads go straight to the stubbed `fetch`. */
const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy"];
let savedProxy: Record<string, string | undefined>;

const body = {
  five_hour: { utilization: 12, resets_at: "2026-11-11T14:00:00Z" },
  seven_day: { utilization: 40, resets_at: "2026-11-14T10:00:00Z" },
  extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, currency: "USD" },
};

function answer(responses: Array<() => Response>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected request ${url}`);
    return next();
  }));
}

beforeEach(async () => {
  calls.length = 0;
  savedProxy = Object.fromEntries(PROXY_VARIABLES.map((key) => [key, process.env[key]]));
  for (const key of PROXY_VARIABLES) delete process.env[key];
  home = await mkdtemp(join(tmpdir(), "zerosub-usage-read-"));
  await writeFile(
    join(home, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "synthetic", expiresAt: Date.now() + 3_600_000, scopes: ["user:profile"] } }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
  // Back to the real one, its calls forgotten.
  vi.mocked(proxiedFetch).mockReset();
  for (const [key, value] of Object.entries(savedProxy)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(home, { recursive: true, force: true });
});

describe("Claude usage read", () => {
  it("asks for spend, so extra usage is recorded", async () => {
    answer([() => Response.json(body)]);
    const usage = await new ClaudeAdapter().usage(home);
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0]!).searchParams.has("skip_spend")).toBe(false);
    expect(new URL(calls[0]!).searchParams.get("cedar_ember")).toBe("1");
    expect(usage.extraUsage).toEqual({ enabled: true, spend: 1234, limit: 5000, currency: "USD" });
  });

  it("never loses the windows for spend: a server error falls back to the read without it", async () => {
    const { extra_usage: _spend, ...withoutSpend } = body;
    answer([() => new Response("spend limit unavailable", { status: 503 }), () => Response.json(withoutSpend)]);
    const usage = await new ClaudeAdapter().usage(home);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!).searchParams.get("skip_spend")).toBe("1");
    expect(usage.error).toBeNull();
    expect(usage.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(usage.extraUsage).toBeUndefined();
  });

  it("falls back after a 400 on the spend read and keeps the windows", async () => {
    const { extra_usage: _spend, ...withoutSpend } = body;
    answer([() => new Response("unsupported spend read", { status: 400 }), () => Response.json(withoutSpend)]);
    const usage = await new ClaudeAdapter().usage(home);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[1]!).searchParams.get("skip_spend")).toBe("1");
    expect(usage.error).toBeNull();
    expect(usage.windows.map((window) => window.id)).toEqual(["five_hour", "seven_day"]);
    expect(usage.extraUsage).toBeUndefined();
  });

  it("clears the extra usage line when a live read reports extra_usage: null after on", async () => {
    answer([() => Response.json(body), () => Response.json({ ...body, extra_usage: null })]);
    const adapter = new ClaudeAdapter();
    const previous = await adapter.usage(home);
    expect(formatExtraUsage(previous.extraUsage!)).toContain("Extra usage on");
    const next = await adapter.usage(home);
    const merged = mergeUsage(UsageSchema.parse(previous), UsageSchema.parse(next));
    expect(merged.extraUsage).toBeNull();
    expect(merged.extraUsage ? formatExtraUsage(merged.extraUsage) : null).toBeNull();
  });

  it("doesn't retry a rate limit or a rejected sign-in", async () => {
    answer([() => new Response("", { status: 429, headers: { "retry-after": "60" } })]);
    await new ClaudeAdapter().usage(home);
    expect(calls).toHaveLength(1);
  });
});

describe("Claude's calls with an account's token", () => {
  let proxy: Server | null = null;

  afterEach(async () => {
    await new Promise((resolve) => (proxy ? proxy.close(resolve) : resolve(undefined)));
    proxy = null;
  });

  it("keeps a banked Fable reset when an automatic check finds the account has room", async () => {
    answer([() => Response.json({ cedar_ember: {
      eligible: true, at_limit: false, next_grant_id: "grant_1",
      grants: [{ id: "grant_1", resets_left: 1, clears: ["seven_day_overage_included"], usable_now: true }],
    } })]);
    expect(await new ClaudeAdapter().redeemReset(home, { onlyAtLimit: true })).toMatchObject({ outcome: "not_limited", left: 1 });
    expect(calls).toEqual(["https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1"]);
  });

  it("go through the account's own proxy: the usage read, and the read before redeeming a reset", async () => {
    // A proxy that records where each tunnel was asked to go, then refuses it: nothing leaves the machine.
    const seen: string[] = [];
    proxy = createServer();
    proxy.on("connect", (request, socket) => {
      seen.push(request.url ?? "");
      socket.end("HTTP/1.1 403 Nope\r\n\r\n");
    });
    const port = await new Promise<number>((resolve) => proxy!.listen(0, "127.0.0.1", () => resolve((proxy!.address() as AddressInfo).port)));
    await writeFile(join(home, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: `http://127.0.0.1:${port}` } }));
    answer([]);

    const adapter = new ClaudeAdapter();
    expect((await adapter.usage(home)).error).not.toBeNull();
    expect(seen).toEqual(["api.anthropic.com:443"]);
    expect((await adapter.redeemReset(home)).outcome).toBe("error");
    expect(seen).toEqual(["api.anthropic.com:443", "api.anthropic.com:443"]);
    // Never straight to Anthropic past the proxy.
    expect(calls).toEqual([]);
  });

  it("go through the account's own proxy for the reset itself too", async () => {
    const through = "http://127.0.0.1:7890";
    const organization = "00000000-0000-4000-8000-000000000000";
    await writeFile(join(home, "settings.json"), JSON.stringify({ env: { HTTPS_PROXY: through } }));
    await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: organization } }));
    const resets = { eligible: true, at_limit: true, next_grant_id: "grant_1", grants: [{ id: "grant_1", resets_left: 1, usable_now: true }] };
    // Answered in the proxy's place: the reads find a reset to use, and using it works.
    vi.mocked(proxiedFetch).mockImplementation(async (_proxy, target) =>
      target.endsWith("/reset_rate_limits") ? Response.json({ result: "reset", resets_left: 0 }) : Response.json({ ...body, cedar_ember: resets }),
    );
    answer([]);

    const adapter = new ClaudeAdapter();
    expect((await adapter.usage(home)).error).toBeNull();
    expect((await adapter.redeemReset(home)).outcome).toBe("reset");
    expect(vi.mocked(proxiedFetch).mock.calls.map(([proxy, target, init]) => [proxy, target, init?.method ?? "GET"])).toEqual([
      [through, "https://api.anthropic.com/api/oauth/usage?cedar_ember=1", "GET"],
      [through, "https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1", "GET"],
      [through, `https://api.anthropic.com/api/organizations/${organization}/reset_rate_limits`, "POST"],
    ]);
    expect(calls).toEqual([]);
  });
});
