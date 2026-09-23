import { describe, expect, it } from "vitest";
import { parseClaudeResets, readClaimReply } from "./claude-resets";
import { parseResetCredits, readConsumeReply } from "./codex";

const NOW = Date.parse("2026-09-23T12:00:00Z");

const grant = (patch: Record<string, unknown> = {}) => ({
  id: "grant_1",
  label: "Limit reset",
  resets_total: 2,
  resets_left: 2,
  ends_at: "2026-09-30T00:00:00Z",
  clears: ["five_hour", "seven_day"],
  paused: false,
  usable_now: true,
  use_requires_limit: true,
  percent_used: {},
  blocking: [],
  ...patch,
});

describe("Claude banked resets", () => {
  it("offers the next grant when the account is at a limit", () => {
    const { offer, nextGrantId } = parseClaudeResets(
      { eligible: true, at_limit: true, grants: [grant()], next_grant_id: "grant_1" },
      NOW,
    );
    expect(nextGrantId).toBe("grant_1");
    expect(offer).toEqual({
      available: 2,
      usableNow: true,
      blockedReason: null,
      expiresAt: "2026-09-30T00:00:00.000Z",
      refills: ["5-hour", "weekly"],
      label: "Limit reset",
    });
  });

  it("explains why a reset can't be used yet", () => {
    const notAtLimit = parseClaudeResets({ eligible: true, at_limit: false, grants: [grant()], next_grant_id: "grant_1" }, NOW);
    expect(notAtLimit.offer?.usableNow).toBe(false);
    expect(notAtLimit.offer?.blockedReason).toMatch(/once this account hits a limit/);

    const blocked = parseClaudeResets(
      { eligible: true, at_limit: true, grants: [grant({ blocking: ["seven_day_opus"], clears: ["five_hour"] })], next_grant_id: "grant_1" },
      NOW,
    );
    expect(blocked.offer?.blockedReason).toMatch(/doesn't refill your Opus weekly limit/);

    const ineligible = parseClaudeResets({ eligible: false, ineligible_reason: "cli_version", grants: [grant()] }, NOW);
    expect(ineligible.offer?.blockedReason).toMatch(/Update Claude Code/);
  });

  it("reports whether Claude sees the account at a limit, even for grants usable any time", () => {
    const anyTime = grant({ use_requires_limit: false });
    const refilled = parseClaudeResets({ eligible: true, at_limit: false, grants: [anyTime], next_grant_id: "grant_1" }, NOW);
    // Usable, but automatic use waits for a real limit so hosts sharing the account don't double-spend.
    expect(refilled.offer?.usableNow).toBe(true);
    expect(refilled.atLimit).toBe(false);
    expect(parseClaudeResets({ eligible: true, at_limit: true, grants: [anyTime], next_grant_id: "grant_1" }, NOW).atLimit).toBe(true);
    expect(parseClaudeResets(undefined, NOW).atLimit).toBe(false);
  });

  it("reports nothing when no resets are banked, and ignores malformed grants", () => {
    expect(parseClaudeResets({ eligible: true, grants: [grant({ resets_left: 0 })] }, NOW).offer).toBeNull();
    expect(parseClaudeResets({ eligible: true, grants: [{ id: "BAD ID!", resets_left: 3 }] }, NOW).offer).toBeNull();
    expect(parseClaudeResets(undefined, NOW).offer).toBeNull();
  });

  it("turns claim replies into plain outcomes", () => {
    expect(readClaimReply({ result: "reset", resets_left: 1, cleared: ["five_hour", "seven_day"] })).toEqual({
      outcome: "reset",
      message: "Limits reset (5-hour and weekly) · 1 left.",
      left: 1,
    });
    expect(readClaimReply({ result: "not_limited", resets_left: 2 }).outcome).toBe("not_limited");
    expect(readClaimReply({ result: "cooldown", cooldown_until: "2026-09-23T13:00:00Z" }).message).toMatch(/cooling down until/);
    expect(readClaimReply({ result: "ineligible", reason: "tier" }).message).toMatch(/plan doesn't include/);
    expect(readClaimReply({ result: "something-new" }).outcome).toBe("unavailable");
    expect(readClaimReply("oops").outcome).toBe("error");
  });
});

describe("Codex reset credits", () => {
  it("counts available credits and finds the soonest expiry", () => {
    const offer = parseResetCredits({
      availableCount: 2,
      credits: [
        { id: "a", resetType: "codexRateLimits", status: "available", grantedAt: 1, expiresAt: 1790500000, title: "Weekly reset", description: null },
        { id: "b", resetType: "codexRateLimits", status: "available", grantedAt: 1, expiresAt: 1790300000, title: null, description: null },
        { id: "c", resetType: "codexRateLimits", status: "redeemed", grantedAt: 1, expiresAt: 1790000000, title: null, description: null },
      ],
    });
    expect(offer).toMatchObject({ available: 2, usableNow: true, label: "Weekly reset", expiresAt: new Date(1790300000 * 1000).toISOString() });
    expect(parseResetCredits({ availableCount: 0, credits: null })).toBeNull();
    expect(parseResetCredits(null)).toBeNull();
  });

  it("maps consume outcomes", () => {
    expect(readConsumeReply("reset", 1)).toEqual({ outcome: "reset", message: "Codex usage limits reset · 1 left.", left: 1 });
    expect(readConsumeReply("nothingToReset", 2).outcome).toBe("not_limited");
    expect(readConsumeReply("noCredit", null)).toMatchObject({ outcome: "none", left: 0 });
    expect(readConsumeReply("alreadyRedeemed", 0).outcome).toBe("already_used");
    expect(readConsumeReply(undefined, null).outcome).toBe("error");
  });
});
