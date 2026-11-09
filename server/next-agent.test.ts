import { describe, expect, it } from "vitest";
import { chooseAccount } from "./routing";
import { emptyState, type StoredAccount, type StoredState } from "./state";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const later = (ms: number) => new Date(NOW + ms).toISOString();

function account(id: string, family: "claude" | "codex" = "claude", kind: "main" | "managed" = "managed"): StoredAccount {
  return {
    id, family, label: id, autoLabel: false, kind, home: kind === "main" ? null : `/homes/${id}`, email: null, plan: null,
    organization: null, identity: null, signedIn: true, disabled: false, limitedUntil: null, limitKind: null,
    limitedAt: null, createdAt: "2026-09-01T00:00:00Z",
  } as StoredAccount;
}

const main = account("claude-main", "claude", "main");
const work = account("work");
const base = { agentId: "a1", family: "claude" as const, now: NOW, autoSwitch: true, balanceNewAgents: false, portable: true, usageOf: () => null };
const withPick = (pick: StoredState["nextAgent"]["claude"]): StoredState => ({ ...emptyState(), accounts: [main, work], nextAgent: { claude: pick, codex: null } });

describe("next new agent pick", () => {
  it("starts a new interactive agent on the picked account and asks to clear the pick", () => {
    const d = chooseAccount(withPick({ accountId: "work", until: later(60_000) }), { ...base, reason: "create", allowNextPick: true });
    expect(d?.account.id).toBe("work");
    expect(d?.usedNextPick).toBe(true);
    expect(d?.bind).toMatchObject({ accountId: "work", source: "user" });
  });

  it("ignores the pick for background sessions, resumed agents and expired picks", () => {
    const pick = withPick({ accountId: "work", until: later(60_000) });
    expect(chooseAccount(pick, { ...base, reason: "create", allowNextPick: false })?.account.id).toBe("claude-main");
    expect(chooseAccount(pick, { ...base, reason: "resume", allowNextPick: true })?.usedNextPick).toBe(false);
    const expired = withPick({ accountId: "work", until: later(-1) });
    expect(chooseAccount(expired, { ...base, reason: "create", allowNextPick: true })?.account.id).toBe("claude-main");
  });

  it("does not override an agent that already has its own account", () => {
    const state = { ...withPick({ accountId: "work", until: later(60_000) }), bindings: { a1: { accountId: "claude-main", source: "user" as const, at: "2026-11-09T11:00:00Z" } } };
    expect(chooseAccount(state, { ...base, reason: "create", allowNextPick: true })?.account.id).toBe("claude-main");
  });

  it("old state files without the field still load", () => {
    const { nextAgent, ...old } = emptyState();
    expect(nextAgent).toEqual({ claude: null, codex: null });
    expect(chooseAccount({ ...(old as StoredState), accounts: [main, work] }, { ...base, reason: "create", allowNextPick: true })?.account.id).toBe("claude-main");
  });
});
