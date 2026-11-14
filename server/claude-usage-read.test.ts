import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatExtraUsage } from "../shared/format";
import { UsageSchema } from "../shared/model";
import { ClaudeAdapter } from "./claude";
import { mergeUsage } from "./usage";

// A synthetic home with a made-up token; `fetch` is stubbed, so nothing real is read or called.
let home: string;
const calls: string[] = [];

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
  home = await mkdtemp(join(tmpdir(), "zerosub-usage-read-"));
  await writeFile(
    join(home, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "synthetic", expiresAt: Date.now() + 3_600_000, scopes: ["user:profile"] } }),
  );
});

afterEach(async () => {
  vi.unstubAllGlobals();
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
