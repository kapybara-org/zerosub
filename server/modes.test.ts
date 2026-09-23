import { describe, expect, it } from "vitest";
import { equivalentMode } from "./modes";

// As Paseo 0.9.1 lists them.
const CLAUDE = [
  { id: "plan", colorTier: "planning" },
  { id: "default", colorTier: "safe" },
  { id: "acceptEdits", colorTier: "moderate" },
  { id: "auto", colorTier: "moderate" },
  { id: "bypassPermissions", colorTier: "dangerous" },
];
const CODEX = [
  { id: "auto", colorTier: "moderate" },
  { id: "auto-review", colorTier: "moderate" },
  { id: "full-access", colorTier: "dangerous" },
];

describe("equivalentMode", () => {
  it("keeps the same permission tier across providers", () => {
    expect(equivalentMode(CLAUDE, "bypassPermissions", CODEX)).toBe("full-access");
    expect(equivalentMode(CLAUDE, "acceptEdits", CODEX)).toBe("auto");
    expect(equivalentMode(CODEX, "full-access", CLAUDE)).toBe("bypassPermissions");
    expect(equivalentMode(CODEX, "auto-review", CLAUDE)).toBe("acceptEdits");
  });

  it("never picks a more permissive mode than the original had", () => {
    expect(equivalentMode(CLAUDE, "plan", CODEX)).toBeNull();
    expect(equivalentMode(CLAUDE, "default", CODEX)).toBeNull();
  });

  it("falls back to a more careful tier when the same one is missing", () => {
    expect(equivalentMode(CODEX, "full-access", CLAUDE.filter((mode) => mode.colorTier !== "dangerous"))).toBe("acceptEdits");
  });

  it("refuses to guess an unknown mode", () => {
    expect(equivalentMode(CLAUDE, null, CODEX)).toBeNull();
    expect(equivalentMode(CLAUDE, "mystery", CODEX)).toBeNull();
    expect(equivalentMode([{ id: "x" }], "x", CODEX)).toBeNull();
  });
});
