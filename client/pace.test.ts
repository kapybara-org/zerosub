import { describe, expect, it, vi } from "vitest";
import type { PaceView } from "../shared/model";

// The copy is pure text, but it lives beside react-native views a Node test can't load.
vi.mock("react-native", () => ({ Text: () => null, View: () => null }));

import { describePace, type PaceCopy } from "./pace";

/** The copy as one string, plus which runs are bold. */
const plain = (parts: PaceCopy["fiveHour"] | null) => parts?.map((part) => part.text).join("") ?? null;
const bold = (parts: PaceCopy["fiveHour"] | null) => parts?.filter((part) => part.bold).map((part) => part.text) ?? null;

const main: PaceView = {
  fiveHourUsed: 30,
  fiveHourProjected: 90,
  pendingFiveHour: 0,
  weeklyUsed: 25,
  pendingWeekly: 0,
  weekElapsed: 50,
  pending: 0,
  gated: true,
};
const work: PaceView = {
  fiveHourUsed: 45,
  fiveHourProjected: 76.25,
  pendingFiveHour: 20,
  weeklyUsed: 50,
  pendingWeekly: 4,
  weekElapsed: 85.71,
  pending: 2,
  gated: false,
};

describe("describing pace", () => {
  it("says Main is held back", () => {
    const copy = describePace(main);
    expect(plain(copy.fiveHour)).toBe("30% now · 90% projected");
    expect(bold(copy.fiveHour)).toEqual(["30%", "90%"]);
    expect(plain(copy.weekly)).toBe("25% used · 50% elapsed · behind pace");
    expect(bold(copy.weekly)).toEqual(["25%", "50%"]);
    expect(copy).toMatchObject({
      pending: null,
      standing: "behind",
      held:
        "Pacing holds it back: new agents start on other accounts first while it is projected at or past 80% of its 5-hour limit.",
    });
  });

  it("counts the agents pending on Work", () => {
    const copy = describePace(work);
    expect(plain(copy.fiveHour)).toBe("45% now · 76% projected");
    expect(plain(copy.weekly)).toBe("50% used · 86% elapsed · behind pace");
    expect(copy).toMatchObject({
      pending: "+2 new agents not in the reading yet",
      pendingDetail: "Counts 2 new agents the reading doesn't show yet (+20% 5-hour, +4% weekly)",
      held: null,
    });
  });

  it("says one pending agent in the singular", () => {
    const one = describePace({ ...work, pending: 1, pendingFiveHour: 10, pendingWeekly: 2 });
    expect(one.pending).toBe("+1 new agent not in the reading yet");
    expect(one.pendingDetail).toBe("Counts 1 new agent the reading doesn't show yet (+10% 5-hour, +2% weekly)");
  });

  it("says so when there is no reading", () => {
    const empty: PaceView = { ...main, fiveHourUsed: null, fiveHourProjected: 50, weeklyUsed: null, weekElapsed: null, gated: false };
    const copy = describePace(empty);
    expect(plain(copy.fiveHour)).toBe("No 5-hour reading yet. Pacing counts it as 50%.");
    expect(copy).toMatchObject({ weekly: null, standing: null });
  });

  it("calls weekly use ahead of pace when it is past the week gone", () => {
    const ahead = describePace({ ...main, weeklyUsed: 60, weekElapsed: 40 });
    expect(ahead.standing).toBe("ahead");
    expect(plain(ahead.weekly)).toBe("60% used · 40% elapsed · ahead of pace");
  });
});
