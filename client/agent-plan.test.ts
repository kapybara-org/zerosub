import { describe, expect, it } from "vitest";
import { formatResetMoment } from "../shared/format";
import type { AccountView, AgentRoute, StateView, UsageWindow } from "../shared/model";
import { agentPlan, canUse, describeUse, detailReason, draftOf, moved, smartOrder, spokenDetails, toggled } from "./agent-plan";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const IN_2H = "2026-11-14T14:00:00Z";
const IN_3D = "2026-11-17T12:00:00Z";
const FABLE = "claude-fable-5-2";
const OPUS = "claude-opus-5-5";

const weekly = (usedPercent: number): UsageWindow => ({ id: "seven_day", label: "Weekly", usedPercent, resetsAt: IN_3D });
const fiveHour = (usedPercent: number): UsageWindow => ({ id: "five_hour", label: "5-hour", usedPercent, resetsAt: IN_2H });
const fable = (usedPercent: number): UsageWindow => ({ id: "seven_day_fable", label: "Weekly · Fable", usedPercent, resetsAt: IN_3D });

function account(id: string, windows: UsageWindow[], patch: Partial<AccountView> = {}): AccountView {
  return {
    id,
    family: "claude",
    label: id,
    kind: "managed",
    email: null,
    plan: null,
    organization: null,
    status: "ready",
    isDefault: false,
    limitedUntil: null,
    usage: { windows, fetchedAt: new Date(NOW).toISOString(), error: null, cached: false, resets: null, credits: null } as unknown as AccountView["usage"],
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
  };
}

function state(accounts: AccountView[], agents: AgentRoute[]): StateView {
  return {
    accounts,
    agents,
    logins: [],
    providers: { claude: "claude" },
    canReopen: true,
    browserSignIn: true,
    showComposerPill: true,
    autoSwitch: true,
    piLaunchers: null,
    piHomes: null,
    warnings: [],
    plan: { horizonH: 24, keepFable: false, paceH: 2, regime: "surplus" },
  };
}

const route = (accountId: string, patch: Partial<AgentRoute> = {}): AgentRoute => ({
  agentId: "agent",
  family: "claude",
  accountId,
  pinned: false,
  pendingAccountId: null,
  waiting: null,
  movable: true,
  ...patch,
});

describe("agentPlan", () => {
  const main = account("main", [fiveHour(10), weekly(40), fable(100)], { isDefault: true, kind: "main" });
  const side = account("side", [fiveHour(5), weekly(30), fable(20)]);
  const spare = account("spare", [fiveHour(0), weekly(10), fable(10)]);

  it("moves a Fable agent off an account whose Fable room is used up, and says why", () => {
    const s = state([main, side, spare], [route("main", { model: FABLE })]);
    const r = s.agents[0];
    const draft = draftOf(null, s.accounts, smartOrder(s, r, "claude", FABLE, NOW));
    const plan = agentPlan(s, r, "claude", FABLE, draft, false, NOW)!;
    expect(plan.model).toBe("Fable 5.2");
    expect(plan.next).toMatchObject({ kind: "go" });
    expect(plan.next.kind === "go" && plan.next.detail).toMatch(/^Fable is full on main/);
    expect(plan.checked.find((row) => row.id === "main")).toMatchObject({ now: true, full: true, glyph: { kind: "model", usedPercent: 100 } });
    expect(plan.others).toEqual([]);
  });

  it("gives each row the limits its details show: those that apply to the agent, in the reading's order", () => {
    const off = account("off", [], { status: "signed_out", usage: null });
    const s = state([main, side, off], [route("main", { model: FABLE })]);
    const r = s.agents[0];
    const plan = agentPlan(s, r, "claude", FABLE, draftOf(null, s.accounts, smartOrder(s, r, "claude", FABLE, NOW)), false, NOW)!;
    const row = plan.checked.find((entry) => entry.id === "main")!;
    const in2h = formatResetMoment(IN_2H, NOW);
    const in3d = formatResetMoment(IN_3D, NOW);
    // Fable is full until its reset: the 5-hour and the week, which reset by then, change nothing.
    expect(row.lines).toEqual([{ kind: "model", name: "Fable", usedPercent: 100, tone: "danger", full: true, resets: in3d, applies: true }]);
    expect(row.note).toBeNull();
    expect(spokenDetails(row)).toContain(`Fable full, resets ${in3d}`);
    const signedOut = [...plan.checked, ...plan.others].find((entry) => entry.id === "off")!;
    expect(signedOut).toMatchObject({ lines: [], note: "Signed out · sign in from Manage accounts" });

    // An Opus agent isn't held back by the Fable limit: it still shows, as Fable's only.
    const opus = agentPlan(s, r, "claude", OPUS, draftOf(null, s.accounts, smartOrder(s, r, "claude", OPUS, NOW)), false, NOW)!;
    const opusRow = opus.checked.find((entry) => entry.id === "main")!;
    expect(opusRow.lines).toEqual([
      { kind: "session", name: "5-hour", usedPercent: 10, tone: "calm", full: false, resets: in2h, applies: true },
      { kind: "weekly", name: "Weekly", usedPercent: 40, tone: "calm", full: false, resets: in3d, applies: true },
      { kind: "model", name: "Fable", usedPercent: 100, tone: "danger", full: true, resets: in3d, applies: false },
    ]);
    expect(spokenDetails(opusRow)).toContain(`5-hour 10% used, resets ${in2h}. Weekly 40% used, resets ${in3d}. Fable only full, resets ${in3d}`);
  });

  it("leaves out of a row's details the reset its limits already show", () => {
    expect(detailReason("Use first · 45% left, resets in 1d 2h · full in ≈ 6h")).toBe("Use first · 45% left · full in ≈ 6h");
    expect(detailReason("55% left · resets in 2d 3h")).toBe("55% left");
    expect(detailReason("Saves Fable's room · Fable can't use 8% of what's left here · resets in 6d 1h · full in ≈ 40m")).toBe(
      "Saves Fable's room · Fable can't use 8% of what's left here · full in ≈ 40m",
    );
    expect(detailReason("Hit its limit · back in 11h")).toBe("Hit its limit · back in 11h");
  });

  it("keeps an Opus agent where it is", () => {
    const s = state([main, side, spare], [route("main", { model: OPUS })]);
    const r = s.agents[0];
    const plan = agentPlan(s, r, "claude", OPUS, draftOf(null, s.accounts, smartOrder(s, r, "claude", OPUS, NOW)), false, NOW)!;
    expect(plan.next).toMatchObject({ kind: "stay", on: "main" });
    expect(plan.checked[0]!.id).toBe("main");
  });

  it("follows a dragged order, and moves to the first usable account in it", () => {
    const s = state([main, side, spare], [route("side", { model: OPUS })]);
    const r = s.agents[0];
    const draft = { pool: ["main", "side", "spare"], mode: "manual" as const, order: ["spare", "side", "main"], overflow: "wait" as const };
    const plan = agentPlan(s, r, "claude", OPUS, draft, true, NOW)!;
    expect(plan.checked.map((row) => row.id)).toEqual(["spare", "side", "main"]);
    expect(plan.next).toMatchObject({ kind: "go", to: "spare" });
  });

  it("marks a full account in a dragged order as skipped", () => {
    const s = state([main, side], [route("side", { model: FABLE })]);
    const draft = { pool: ["main", "side"], mode: "manual" as const, order: ["main", "side"], overflow: "wait" as const };
    const plan = agentPlan(s, s.agents[0], "claude", FABLE, draft, true, NOW)!;
    expect(plan.checked[0]!.why).toMatch(/^Skipped · /);
    expect(plan.next).toMatchObject({ kind: "stay", on: "side" });
  });

  it("waits when every checked account is full, and offers the others once", () => {
    const s = state([main, side, spare], [route("main", { model: FABLE })]);
    const draft = { pool: ["main"], mode: "smart" as const, order: ["main", "side", "spare"], overflow: "wait" as const };
    const plan = agentPlan(s, s.agents[0], "claude", FABLE, draft, true, NOW)!;
    expect(plan.next).toMatchObject({ kind: "full", model: "Fable", canOverflow: true });
    expect(plan.others.map((row) => row.id).sort()).toEqual(["side", "spare"]);
    expect(plan.others.every((row) => !row.why.startsWith("Use first"))).toBe(true);
  });

  it("goes to an unchecked account when it may use the others", () => {
    const s = state([main, side, spare], [route("main", { model: FABLE })]);
    const draft = { pool: ["main"], mode: "smart" as const, order: [], overflow: "others" as const };
    const plan = agentPlan(s, s.agents[0], "claude", FABLE, draft, true, NOW)!;
    expect(plan.next.kind).toBe("go");
    expect(plan.next.kind === "go" && plan.next.detail).toMatch(/not checked/);
  });

  it("leaves an account the user unchecked", () => {
    const s = state([main, side, spare], [route("side", { model: OPUS })]);
    const draft = { pool: ["main", "spare"], mode: "smart" as const, order: [], overflow: "wait" as const };
    const plan = agentPlan(s, s.agents[0], "claude", OPUS, draft, true, NOW)!;
    expect(plan.next.kind).toBe("go");
    expect(plan.next.kind === "go" && plan.next.detail).toMatch(/^Leaves side, which you unchecked/);
  });
});

describe("editing an agent's accounts", () => {
  const draft = { pool: ["a", "b"], mode: "manual" as const, order: ["a", "c", "b"], overflow: "wait" as const };

  it("keeps the last checked account", () => {
    expect(toggled({ ...draft, pool: ["a"] }, "a")).toBeNull();
    expect(toggled(draft, "a")!.pool).toEqual(["b"]);
  });

  it("puts an account checked again after the last checked one", () => {
    expect(toggled(draft, "c")!.order).toEqual(["a", "b", "c"]);
  });

  it("makes a drag the user's order", () => {
    const next = moved({ ...draft, mode: "smart" }, ["a", "b"], "b", 0);
    expect(next).toMatchObject({ mode: "manual", order: ["b", "a", "c"] });
  });

  it("starts from every account in the planner's order", () => {
    const accounts = [account("a", []), account("b", [])];
    expect(draftOf(null, accounts, ["b", "a"])).toEqual({ pool: ["a", "b"], mode: "smart", order: ["b", "a"], overflow: "wait" });
    expect(draftOf({ pool: ["gone"], mode: "smart", order: ["gone"], overflow: "others" }, accounts, ["a", "b"]).pool).toEqual(["a", "b"]);
  });
});

describe("using an account now", () => {
  it("offers every account the agent can run on next, but not the one it runs on", () => {
    const stopped = account("stopped", [fiveHour(100), weekly(40)], { isDefault: true, kind: "main" });
    const free = account("free", [fiveHour(5), weekly(30)]);
    const out = account("out", [], { status: "signed_out" });
    const off = account("off", [fiveHour(0), weekly(0)], { status: "disabled" });
    const s = state([stopped, free, out, off], [route("stopped", { model: "claude-opus-5-5" })]);
    const r = s.agents[0];
    const draft = { pool: ["free"], mode: "manual" as const, order: ["free", "stopped", "out", "off"], overflow: "wait" as const };
    const plan = agentPlan(s, r, "claude", "claude-opus-5-5", draft, true, NOW)!;
    const offered = [...plan.checked, ...plan.others].filter(canUse).map((row) => row.id);
    expect(offered).toEqual(["free"]);
  });

  it("says where the agent went", () => {
    const none = { reopened: [], deferred: [], failed: [], continuedIn: null };
    expect(describeUse("home", { ...none, reopened: ["agent"] })).toBe("Now on home");
    expect(describeUse("home", { ...none, deferred: ["agent"] })).toBe("Moves to home once this turn ends");
    expect(describeUse("home", { ...none, failed: [{ agentId: "agent", error: "x" }] })).toBe("Moves to home when its session restarts");
    expect(describeUse("home", none)).toBe("Runs on home");
    expect(describeUse("home", { ...none, continuedIn: { agentId: "b", title: "Fix" } })).toBe("Continuing in “Fix” on home");
  });
});
