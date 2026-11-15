import { describe, expect, it } from "vitest";
import { plan, rank, shouldMove, type PlanAccount, type PlanWindow } from "./planner";

const win = (used: number, reset: number | null): PlanWindow => ({ used, reset });

function acct(id: string, patch: Partial<PlanAccount> = {}): PlanAccount {
  return {
    id,
    name: id,
    status: "ready",
    s: win(10, 3),
    w: win(30, 100),
    f: win(20, 100),
    ageH: 0,
    limits: [],
    load: 0,
    ...patch,
  };
}

describe("rank", () => {
  it("passes over an account whose Fable room is used up for a Fable agent only", () => {
    const accounts = [acct("roomy", { w: win(10, 100), f: win(100, 40) }), acct("other", { w: win(50, 100) })];
    const fable = rank(accounts, { model: "fable" });
    expect(fable[0]!.id).toBe("other");
    expect(fable.find((row) => row.id === "roomy")).toMatchObject({ ok: false, tier: 2 });
    expect(rank(accounts, { model: "other" })[0]!.id).toBe("roomy");
  });

  it("says when Fable needs usage credits on an account", () => {
    const accounts = [acct("a", { limits: [{ scope: "fable", untilH: 3, kind: "budget" }] }), acct("b")];
    const rows = rank(accounts, { model: "fable" });
    expect(rows[0]!.id).toBe("b");
    expect(rows[1]!.why).toBe("Fable needs usage credits here");
    // Opus still runs there.
    expect(rank(accounts, { model: "other" }).every((row) => row.ok)).toBe(true);
  });

  it("uses room that would be lost at a reset first, and side by side otherwise", () => {
    const accounts = [acct("soon", { w: win(40, 10) }), acct("roomy", { w: win(10, 150) })];
    expect(rank(accounts, { paceH: 2, horizonH: 24 })[0]!.id).toBe("soon");
    expect(rank(accounts, { paceH: 2, horizonH: Number.NEGATIVE_INFINITY })[0]!.id).toBe("roomy");
  });

  it("follows a dragged order among usable accounts and skips full ones", () => {
    const accounts = [acct("a"), acct("b", { w: win(100, 20) }), acct("c")];
    const rows = rank(accounts, { pool: ["a", "b", "c"], manual: ["b", "c", "a"] });
    expect(rows.map((row) => row.id)).toEqual(["c", "a", "b"]);
  });

  it("keeps an agent on its checked accounts, and lets it past them only when it may overflow", () => {
    const accounts = [acct("mine", { w: win(100, 20) }), acct("spare")];
    expect(rank(accounts, { pool: ["mine"], overflow: false }).map((row) => row.id)).toEqual(["mine"]);
    const open = rank(accounts, { pool: ["mine"], overflow: true });
    expect(open.find((row) => row.ok)).toMatchObject({ id: "spare", outside: true });
  });
});

describe("shouldMove", () => {
  it("moves a Fable agent off an account whose Fable room is used up", () => {
    const accounts = [acct("here", { f: win(100, 30) }), acct("there")];
    expect(shouldMove({ account: "here", model: "fable" }, accounts)).toMatchObject({ reason: "model", target: "there" });
    expect(shouldMove({ account: "here", model: "other" }, accounts)).toBeNull();
  });

  it("moves an agent off an account the user unchecked, and to the first one dragged", () => {
    const accounts = [acct("a"), acct("b"), acct("c")];
    expect(shouldMove({ account: "a", model: "other" }, accounts, { pool: ["b", "c"] })).toMatchObject({ reason: "unchecked" });
    expect(shouldMove({ account: "a", model: "other" }, accounts, { pool: ["a", "b"], manual: ["b", "a"] })).toMatchObject({
      reason: "order",
      target: "b",
    });
    expect(shouldMove({ account: "b", model: "other" }, accounts, { pool: ["a", "b"], manual: ["b", "a"] })).toBeNull();
  });

  it("leaves a waiting agent where it is when its checked accounts are all full", () => {
    const accounts = [acct("mine", { limits: [{ scope: "account", untilH: 2, kind: "window" }] }), acct("spare")];
    expect(shouldMove({ account: "mine", model: "other" }, accounts, { pool: ["mine"], overflow: false })).toEqual({ reason: "wall", target: null });
    expect(shouldMove({ account: "mine", model: "other" }, accounts, { pool: ["mine"], overflow: true })).toMatchObject({
      reason: "wall",
      target: "spare",
      outside: true,
    });
  });
});

describe("plan", () => {
  it("picks a horizon and says whether the week is tight", () => {
    const roomy = plan([acct("a", { w: win(5, 160) }), acct("b", { w: win(5, 160) })], { pace: 1 });
    expect(roomy.regime).toBe("surplus");
    expect(Number.isNaN(roomy.horizonH)).toBe(false);
    const tight = plan([acct("a", { w: win(90, 160) }), acct("b", { w: win(95, 160) })], { pace: 3 });
    expect(tight.regime).toBe("scarce");
  });
});
