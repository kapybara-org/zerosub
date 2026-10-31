import { describe, expect, it } from "vitest";
import { setOmpSettings } from "../shared/rpc";
import { settingChange, settleChoice } from "./omp-choices";

describe("settingChange", () => {
  it("sends only the setting that changed, with OMP's default as null", () => {
    expect(settingChange("codexResets.keepCredits", "2")).toEqual({ "codexResets.keepCredits": 2 });
    expect(settingChange("retry.waitForUsageReset", "false")).toEqual({ "retry.waitForUsageReset": false });
    expect(settingChange("retry.usageReservePolicy", "fail-closed")).toEqual({ "retry.usageReservePolicy": "fail-closed" });
    expect(settingChange("claudeResets.autoRedeem", "default")).toEqual({ "claudeResets.autoRedeem": null });
    expect(setOmpSettings.input.parse({ settings: settingChange("codexResets.keepCredits", "2") })).toEqual({
      settings: { "codexResets.keepCredits": 2 },
    });
    expect(setOmpSettings.input.safeParse({ settings: { "retry.somethingElse": 1 } }).success).toBe(false);
  });
});

describe("settleChoice", () => {
  it("drops a choice once its save is done, and only that select's", () => {
    expect(settleChoice({ reserve: "20" }, "reserve", "20")).toEqual({});
    expect(settleChoice({ "retry.waitForUsageReset": "true", "codexResets.keepCredits": "2" }, "codexResets.keepCredits", "2")).toEqual({
      "retry.waitForUsageReset": "true",
    });
  });

  it("keeps a newer choice when an older one's save finishes", () => {
    const pending = { reserve: "30" };
    expect(settleChoice(pending, "reserve", "20")).toBe(pending);
  });
});
