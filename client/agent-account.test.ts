import { describe, expect, it } from "vitest";
import type { AccountView, StateView, UsageWindow } from "../shared/model";
import { MANAGE_ACCOUNTS, startingChoice } from "./agent-account";

const NOW = Date.parse("2026-11-14T12:00:00Z");
const IN_2H = "2026-11-14T14:00:00Z";
const IN_3D = "2026-11-17T12:00:00Z";

const weekly = (usedPercent: number): UsageWindow => ({ id: "seven_day", label: "Weekly", usedPercent, resetsAt: IN_3D });
const fiveHour = (usedPercent: number): UsageWindow => ({ id: "five_hour", label: "5-hour", usedPercent, resetsAt: IN_2H });
const fable = (usedPercent: number): UsageWindow => ({ id: "seven_day_fable", label: "Weekly · Fable", usedPercent, resetsAt: IN_3D });

function account(id: string, patch: Partial<AccountView> = {}): AccountView {
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
    usage: null,
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

const usage = (windows: UsageWindow[]): AccountView["usage"] =>
  ({ windows, fetchedAt: new Date(NOW).toISOString() }) as unknown as AccountView["usage"];

function state(accounts: AccountView[], patch: Partial<StateView> = {}): StateView {
  return {
    accounts,
    agents: [],
    logins: [],
    providers: { claude: "claude", codex: "codex" },
    canReopen: true,
    browserSignIn: true,
    showComposerPill: true,
    autoSwitch: true,
    piLaunchers: null,
    piHomes: null,
    warnings: [],
    ...patch,
  };
}

describe("startingChoice", () => {
  it("shows the default account, and every account with what it has left", () => {
    const choice = startingChoice(
      state([
        account("main", { isDefault: true, usage: usage([fiveHour(12), weekly(95)]) }),
        account("side", { usage: usage([weekly(54)]) }),
        account("spare", { usage: usage([weekly(0)]) }),
        account("work", { family: "codex" }),
      ]),
      "claude",
      null,
      NOW,
    )!;
    expect(choice.current.id).toBe("main");
    expect(choice.ring).toEqual({ usedPercent: 95, tone: "danger", dashed: false });
    expect(choice.options).toEqual([
      { value: "main", label: "main", description: "5% left · week" },
      { value: "side", label: "side", description: "46% left · week" },
      { value: "spare", label: "spare", description: "100% left" },
      { value: MANAGE_ACCOUNTS, label: "Manage accounts…" },
    ]);
  });

  it("says when a full account is back, and leaves out the ones that can't run", () => {
    const choice = startingChoice(
      state([
        account("main", { isDefault: true }),
        account("team", { status: "limited", limitedUntil: IN_2H }),
        account("old", { status: "signed_out" }),
        account("spare", { status: "disabled" }),
      ]),
      "claude",
      null,
      NOW,
    )!;
    expect(choice.options.map((option) => [option.value, option.description])).toEqual([
      ["main", undefined],
      ["team", "full, back in 2h"],
      [MANAGE_ACCOUNTS, undefined],
    ]);
  });

  it("keeps the current account listed even when it can't run", () => {
    const choice = startingChoice(state([account("old", { isDefault: true, status: "signed_out" }), account("main")]), "claude", null, NOW)!;
    expect(choice.ring).toEqual({ usedPercent: 0, tone: "calm", dashed: true });
    expect(choice.options.slice(0, 2)).toEqual([
      { value: "old", label: "old", description: "signed out" },
      { value: "main", label: "main" },
    ]);
  });

  it("starts the next agent where a one-time pick sends it, until the pick expires", () => {
    const soon = new Date(NOW + 60_000).toISOString();
    const gone = new Date(NOW - 60_000).toISOString();
    const picked = startingChoice(state([account("main", { isDefault: true }), account("side", { nextAgentUntil: soon })]), "claude", null, NOW)!;
    expect([picked.current.id, picked.once]).toEqual(["side", true]);
    expect(picked.rows.map((row) => [row.id, row.current])).toEqual([
      ["main", false],
      ["side", true],
    ]);
    const expired = startingChoice(state([account("main", { isDefault: true }), account("side", { nextAgentUntil: gone })]), "claude", null, NOW)!;
    expect([expired.current.id, expired.once]).toEqual(["main", false]);
  });

  it("falls back to the first account without a default", () => {
    expect(startingChoice(state([account("a"), account("b")]), "claude", null, NOW)!.current.id).toBe("a");
  });

  it("shows nothing for an unmanaged provider, without accounts, or with the pills turned off", () => {
    const accounts = [account("main", { isDefault: true })];
    expect(startingChoice(state(accounts), "opencode", null, NOW)).toBeNull();
    expect(startingChoice(state(accounts), null, null, NOW)).toBeNull();
    expect(startingChoice(state(accounts), "codex", null, NOW)).toBeNull();
    expect(startingChoice(state(accounts, { showComposerPill: false }), "claude", null, NOW)).toBeNull();
  });
});

describe("startingChoice rows", () => {
  it("lays each account out as an agent panel's row: a tick on the default, one figure", () => {
    const choice = startingChoice(
      state([
        account("main", { isDefault: true, usage: usage([fiveHour(12), weekly(95)]) }),
        account("side", { usage: usage([weekly(54)]) }),
        account("full", { status: "limited", limitedUntil: IN_2H }),
        account("gone", { status: "signed_out" }),
      ]),
      "claude",
      null,
      NOW,
    )!;
    expect(choice.rows.map((row) => [row.id, row.current, row.meta, row.room])).toEqual([
      ["main", true, "95%", "5% left · week"],
      ["side", false, "54%", "46% left · week"],
      ["full", false, "2h", "full, back in 2h"],
    ]);
    expect(choice.rows[0]!.lines.map((line) => line.name)).toEqual(["5-hour", "Weekly"]);
    expect(choice.rows[2]!.note).toBe("No usage reading yet");
  });

  it("reads the figures for the model picked in the composer", () => {
    const accounts = [account("main", { isDefault: true, usage: usage([fiveHour(10), weekly(30), fable(100)]) })];
    const forFable = startingChoice(state(accounts), "claude", "claude-fable-5-2", NOW)!;
    expect(forFable.glyph).toMatchObject({ kind: "model", usedPercent: 100 });
    expect(forFable.rows[0]!.meta).toBe("3d");
    const forOpus = startingChoice(state(accounts), "claude", "claude-opus-4-7", NOW)!;
    expect(forOpus.glyph).toMatchObject({ kind: "weekly", usedPercent: 30 });
    expect(forOpus.rows[0]!.meta).toBe("30%");
    // Fable's limit still shows in the details, as another model's.
    expect(forOpus.rows[0]!.lines.map((line) => [line.name, line.applies])).toEqual([
      ["5-hour", true],
      ["Weekly", true],
      ["Fable", false],
    ]);
  });

  it("keeps a current account that can't run, marked as such", () => {
    const choice = startingChoice(state([account("old", { isDefault: true, status: "signed_out" }), account("main")]), "claude", null, NOW)!;
    expect(choice.rows.map((row) => [row.id, row.current, row.meta, row.note])).toEqual([
      ["old", true, "Signed out", "Signed out · sign in from Manage accounts"],
      ["main", false, "0%", "No usage reading yet"],
    ]);
  });
});
