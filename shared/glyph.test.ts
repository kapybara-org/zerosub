import { describe, expect, it } from "vitest";
import type { AccountView, Usage } from "./model";
import { accountGlyph, glyphSvg } from "./glyph";

const NOW = Date.parse("2026-11-15T08:00:00Z");
const later = new Date(NOW + 3 * 3_600_000).toISOString();

const usage = (fable: number): Usage => ({
  fetchedAt: new Date(NOW).toISOString(),
  windows: [
    { id: "five_hour", label: "5-hour", usedPercent: 30, resetsAt: later },
    { id: "seven_day", label: "Weekly", usedPercent: 50, resetsAt: later },
    { id: "weekly_fable", label: "Weekly · Fable", usedPercent: fable, resetsAt: later },
  ],
  error: null,
  cached: false,
  resets: null,
  credits: null,
});

const account = (patch: Partial<AccountView> = {}): AccountView => ({
  id: "a",
  family: "claude",
  label: "a",
  kind: "managed",
  email: null,
  plan: null,
  organization: null,
  status: "ready",
  isDefault: true,
  limitedUntil: null,
  usage: usage(80),
  agentCount: 0,
  home: null,
  auth: "subscription",
  api: null,
  apiEditable: false,
  proxy: null,
  proxyEditable: false,
  proxyBlocked: null,
  inheritedProxy: null,
  proxyFile: null,
  proxyFollowers: [],
  launcher: null,
  egress: null,
  externalHome: false,
  moving: null,
  ...patch,
});

describe("glyphSvg", () => {
  it("draws a clock, a calendar and a sparkle", () => {
    expect(glyphSvg("session", 40)).toContain('stroke-dasharray="');
    expect(glyphSvg("weekly", 40)).toContain("zs-glyph-calendar");
    expect(glyphSvg("model", 40)).toContain("zs-glyph-spark");
    expect(glyphSvg("weekly", 0)).not.toContain("clip-path=");
    expect(glyphSvg("weekly", 50, { dashed: true })).toContain("stroke-dasharray");
  });

  it("keeps quotes out of the colour", () => {
    expect(glyphSvg("model", 50, { fill: '"><script>' })).not.toContain("<script>");
  });
});

describe("accountGlyph", () => {
  it("shows what holds the agent's model back", () => {
    expect(accountGlyph(account(), "claude-fable-5-2", NOW)).toMatchObject({ kind: "model", usedPercent: 80, tone: "warning" });
    expect(accountGlyph(account(), "claude-opus-5-5", NOW)).toMatchObject({ kind: "weekly", usedPercent: 50, tone: "calm" });
  });

  it("shows a Fable limit a turn ran into as a full sparkle for Fable only", () => {
    const limited = account({ modelLimits: [{ scope: "fable", until: later, kind: "budget", at: new Date(NOW).toISOString() }], usage: usage(10) });
    expect(accountGlyph(limited, "claude-fable-5-2", NOW)).toMatchObject({ kind: "model", usedPercent: 100, tone: "danger" });
    expect(accountGlyph(limited, "claude-opus-5-5", NOW)).toMatchObject({ kind: "weekly" });
  });

  it("dashes an account that can't run", () => {
    expect(accountGlyph(account({ status: "signed_out" }), null, NOW).dashed).toBe(true);
  });
});
