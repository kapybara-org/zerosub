import { describe, expect, it } from "vitest";
import type { Usage } from "./model";
import { limitHolds, modelClass, modelName, planAccounts, type PlanSource } from "./plan-input";

const NOW = Date.parse("2026-11-15T08:00:00Z");
const inHours = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

const usage: Usage = {
  fetchedAt: new Date(NOW - 2 * 3_600_000).toISOString(),
  windows: [
    { id: "five_hour", label: "5-hour", usedPercent: 12, resetsAt: inHours(3) },
    { id: "seven_day", label: "Weekly", usedPercent: 54, resetsAt: inHours(50) },
    { id: "weekly_fable", label: "Weekly · Fable", usedPercent: 100, resetsAt: inHours(20) },
    { id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 70, resetsAt: inHours(50) },
  ],
  error: null,
  cached: false,
  resets: null,
  credits: null,
};

const source = (patch: Partial<PlanSource> = {}): PlanSource => ({
  id: "a",
  name: "a",
  signedIn: true,
  disabled: false,
  limitedUntil: null,
  limitKind: null,
  usage,
  ...patch,
});

describe("models", () => {
  it("tells Fable from every other model", () => {
    expect(modelClass("claude-fable-5-2")).toBe("fable");
    expect(modelClass("claude-opus-5-5")).toBe("other");
    expect(modelClass(null)).toBe("other");
  });

  it("names a model from its id", () => {
    expect(modelName("claude-fable-5-2")).toBe("Fable 5.2");
    expect(modelName("claude-opus-4-7-20260101")).toBe("Opus 4.7");
    expect(modelName(null)).toBeNull();
  });

  it("holds back only the model a limit names", () => {
    const limit = { scope: "fable", until: inHours(2), kind: "window" as const, at: inHours(0) };
    expect(limitHolds(limit, "claude-fable-5-2")).toBe(true);
    expect(limitHolds(limit, "claude-opus-5-5")).toBe(false);
  });
});

describe("planAccounts", () => {
  it("reads the account's windows, Fable's, and the asking model's", () => {
    const [fable] = planAccounts([source()], "claude-fable-5-2", NOW);
    expect(fable).toMatchObject({ s: { used: 12 }, w: { used: 54 }, f: { used: 100 }, m: null, noReading: false });
    expect(fable!.w!.reset).toBeCloseTo(50);
    expect(fable!.ageH).toBeCloseTo(2);
    const [opus] = planAccounts([source()], "claude-opus-5-5", NOW);
    expect(opus).toMatchObject({ m: { used: 70 }, mName: "Opus" });
  });

  it("keeps a Fable limit on Fable, and an account limit on the account", () => {
    const limited = source({
      modelLimits: [
        { scope: "fable", until: inHours(3), kind: "budget", at: inHours(0) },
        { scope: "opus", until: inHours(1), kind: "window", at: inHours(0) },
        { scope: "sonnet", until: inHours(-1), kind: "window", at: inHours(-2) },
      ],
    });
    const [fable] = planAccounts([limited], "claude-fable-5-2", NOW);
    expect(fable!.limits.map((limit) => limit.scope)).toEqual(["fable"]);
    const [opus] = planAccounts([limited], "claude-opus-5-5", NOW);
    expect(opus!.limits.map((limit) => limit.scope)).toEqual(["fable", "model"]);
    const [whole] = planAccounts([source({ limitedUntil: inHours(2), limitKind: "window" })], null, NOW);
    expect(whole!.limits).toEqual([{ scope: "account", untilH: 2, kind: "window" }]);
  });

  it("marks an account it has no reading for", () => {
    const [none] = planAccounts([source({ usage: null, signedIn: false })], null, NOW);
    expect(none).toMatchObject({ status: "signed_out", noReading: true, s: null, w: null });
  });
});
