import { describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import { applyEnv } from "./adapter";
import { parseRateLimits } from "./codex";
import { chooseAccount, mostAvailable } from "./routing";
import { emptyState, type StoredAccount, type StoredState } from "./state";

const NOW = Date.parse("2026-09-23T12:00:00Z");

function account(partial: Partial<StoredAccount> & Pick<StoredAccount, "id">): StoredAccount {
  return {
    family: "claude",
    label: partial.id,
    autoLabel: false,
    kind: "managed",
    home: `/homes/${partial.id}`,
    email: null,
    plan: null,
    organization: null,
    identity: null,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    ...partial,
  };
}

function stateWith(accounts: StoredAccount[], patch: Partial<StoredState> = {}): StoredState {
  return { ...emptyState(), accounts, ...patch };
}

function usage(percent: number): Usage {
  return {
    fetchedAt: "2026-09-23T11:59:00Z",
    windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: null }],
    error: null,
    cached: false,
    resets: null,
    credits: null,
  };
}

/** A ChatGPT plan's 5-hour and weekly windows, `[usedPercent, resetsAt]` each, parsed from what Codex sends. */
function codexWindows(short: [number, string], weekly: [number, string] | null) {
  const limit = (windowDurationMins: number, [usedPercent, resetsAt]: [number, string]) =>
    ({ usedPercent, windowDurationMins, resetsAt: Date.parse(resetsAt) / 1000 });
  return parseRateLimits({ primary: limit(300, short), secondary: weekly && limit(10_080, weekly) });
}

const base = {
  agentId: "agent-1",
  family: "claude" as const,
  now: NOW,
  autoSwitch: true,
  balanceNewAgents: false,
  portable: true,
};

describe("chooseAccount", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const work = account({ id: "claude-work" });
  const personal = account({ id: "claude-personal" });

  it("uses the CLI login when nothing else is configured", () => {
    const decision = chooseAccount(stateWith([main, work]), { ...base, reason: "create", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-main");
    expect(decision?.bind).toBeNull();
  });

  it("follows the chosen default", () => {
    const state = stateWith([main, work], { defaults: { claude: "claude-work", codex: null } });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-work");
  });

  it("prefers the agent's own binding over the default", () => {
    const state = stateWith([main, work, personal], {
      defaults: { claude: "claude-work", codex: null },
      bindings: { "agent-1": { accountId: "claude-personal", source: "user", at: "x" } },
    });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-personal");
  });

  it("ignores a binding to a removed account", () => {
    const state = stateWith([main, work], {
      bindings: { "agent-1": { accountId: "claude-gone", source: "user", at: "x" } },
    });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-main");
  });

  it("skips an exhausted account for the roomiest usable one", () => {
    const limited = account({ id: "claude-work", limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([main, limited, personal], { defaults: { claude: "claude-work", codex: null } });
    const decision = chooseAccount(state, {
      ...base,
      reason: "resume",
      usageOf: (id) => (id === "claude-main" ? usage(80) : usage(10)),
    });
    expect(decision?.account.id).toBe("claude-personal");
    expect(decision?.bind?.source).toBe("auto");
    expect(decision?.skipped?.why).toBe("limited");
  });

  it("keeps an exhausted account when automatic switching is off", () => {
    const limited = account({ id: "claude-work", limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([main, limited], { defaults: { claude: "claude-work", codex: null } });
    const decision = chooseAccount(state, { ...base, autoSwitch: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-work");
  });

  it("treats an expired limit as usable again", () => {
    const recovered = account({ id: "claude-work", limitedUntil: "2026-09-23T11:00:00Z" });
    const state = stateWith([main, recovered], { defaults: { claude: "claude-work", codex: null } });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-work");
  });

  it("spreads new agents by headroom when balancing", () => {
    const state = stateWith([main, work, personal]);
    const decision = chooseAccount(state, {
      ...base,
      balanceNewAgents: true,
      reason: "create",
      usageOf: (id) => ({ "claude-main": usage(60), "claude-work": usage(5), "claude-personal": usage(30) })[id],
    });
    expect(decision?.account.id).toBe("claude-work");
    expect(decision?.bind?.source).toBe("balance");
  });

  it("prefers a near weekly reset for new Codex agents with sufficient headroom", () => {
    const soon = account({ id: "codex-soon", family: "codex" });
    const later = account({ id: "codex-later", family: "codex" });
    const reading = (weekly: number, reset: string): Usage => ({
      ...usage(30), windows: codexWindows([30, "2026-09-23T16:00:00Z"], [weekly, reset]),
    });
    const decision = chooseAccount(stateWith([soon, later]), {
      ...base, family: "codex", portable: false, balanceNewAgents: true, reason: "create",
      usageOf: (id) => id === soon.id ? reading(60, "2026-09-24T10:00:00Z") : reading(40, "2026-09-27T10:00:00Z"),
    });
    expect(decision?.account.id).toBe(soon.id);
    expect(decision?.bind?.selectionReason).toBe("weekly_reset");
  });

  it("tells the ChatGPT windows apart by their length, so renaming a label doesn't turn this off", () => {
    const soon = account({ id: "codex-soon", family: "codex" });
    const later = account({ id: "codex-later", family: "codex" });
    const reading = (weekly: number, reset: string): Usage => ({
      ...usage(30),
      windows: codexWindows([30, "2026-09-23T16:00:00Z"], [weekly, reset]).map((limit) => ({ ...limit, label: `Renamed ${limit.label}` })),
    });
    const decision = chooseAccount(stateWith([soon, later]), {
      ...base, family: "codex", portable: false, balanceNewAgents: true, reason: "create",
      usageOf: (id) => id === soon.id ? reading(60, "2026-09-24T10:00:00Z") : reading(40, "2026-09-27T10:00:00Z"),
    });
    expect(decision?.bind).toMatchObject({ accountId: soon.id, selectionReason: "weekly_reset" });
  });

  it.each(["stale", "cached", "error", "missing", "short-limit", "weekly-limit", "past-reset"]) (
    "falls back to headroom when near-reset data is %s", (condition) => {
      const soon = account({ id: "codex-soon", family: "codex" });
      const later = account({ id: "codex-later", family: "codex" });
      const reading = (near: boolean): Usage => ({
        ...usage(30),
        fetchedAt: near && condition === "stale" ? "2026-09-23T10:00:00Z" : "2026-09-23T11:59:00Z",
        cached: near && condition === "cached",
        error: near && condition === "error" ? "offline" : null,
        windows: codexWindows(
          [near && condition === "short-limit" ? 90 : near && condition === "missing" ? 60 : 30, "2026-09-23T16:00:00Z"],
          near && condition === "missing" ? null : [near && condition === "weekly-limit" ? 90 : near ? 60 : 40, near && condition === "past-reset" ? "2026-09-23T11:00:00Z" : near ? "2026-09-24T10:00:00Z" : "2026-09-27T10:00:00Z"],
        ),
      });
      const decision = chooseAccount(stateWith([soon, later]), {
        ...base, family: "codex", portable: false, balanceNewAgents: true, reason: "create",
        usageOf: (id) => reading(id === soon.id),
      });
      expect(decision?.account.id).toBe(later.id);
      expect(decision?.bind?.selectionReason).toBe("headroom");
    },
  );

  it("never binds a Claude agent to a ChatGPT account, even one whose weekly reset is near", () => {
    const soon = account({ id: "codex-soon", family: "codex" });
    const later = account({ id: "codex-later", family: "codex" });
    const readings: Record<string, Usage> = {
      [main.id]: usage(50),
      [work.id]: usage(10),
      [soon.id]: { ...usage(0), windows: codexWindows([30, "2026-09-23T16:00:00Z"], [60, "2026-09-24T10:00:00Z"]) },
      [later.id]: { ...usage(0), windows: codexWindows([30, "2026-09-23T16:00:00Z"], [40, "2026-09-27T10:00:00Z"]) },
    };
    const state = stateWith([soon, later, main, work]);
    const create = { ...base, balanceNewAgents: true, reason: "create" as const, usageOf: (id: string) => readings[id] };

    const claude = chooseAccount(state, create);
    expect(claude?.account.id).toBe(work.id);
    expect(claude?.bind).toMatchObject({ accountId: work.id, source: "balance", selectionReason: "headroom" });
    // The same readings do send a new ChatGPT agent to the near reset.
    const chatgpt = chooseAccount(state, { ...create, family: "codex", portable: false });
    expect(chatgpt?.bind).toMatchObject({ accountId: soon.id, selectionReason: "weekly_reset" });
  });

  it("does not rebalance agents that already exist", () => {
    const state = stateWith([main, work]);
    const decision = chooseAccount(state, {
      ...base,
      balanceNewAgents: true,
      reason: "resume",
      usageOf: (id) => (id === "claude-work" ? usage(0) : usage(90)),
    });
    expect(decision?.account.id).toBe("claude-main");
  });

  it("returns null when the family has no accounts", () => {
    expect(chooseAccount(emptyState(), { ...base, reason: "create", usageOf: () => null })).toBeNull();
  });
});

describe("mostAvailable", () => {
  it("breaks ties toward the default account", () => {
    const main = account({ id: "claude-main", kind: "main", home: null });
    const work = account({ id: "claude-work" });
    const state = stateWith([main, work], { defaults: { claude: "claude-work", codex: null } });
    expect(mostAvailable(state, "claude", () => usage(20), NOW)?.id).toBe("claude-work");
  });

  it("never picks a signed-out account", () => {
    const main = account({ id: "claude-main", kind: "main", home: null, signedIn: false });
    const state = stateWith([main]);
    expect(mostAvailable(state, "claude", () => usage(0), NOW)).toBeUndefined();
  });
});

describe("non-portable conversations (Codex)", () => {
  const main = account({ id: "codex-main", family: "codex", kind: "main", home: null });
  const work = account({ id: "codex-work", family: "codex" });
  const codex = { ...base, family: "codex" as const, portable: false };

  it("pins a thread to the account it first opens on", () => {
    const decision = chooseAccount(stateWith([main, work]), { ...codex, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("codex-main");
    expect(decision?.bind).toMatchObject({ accountId: "codex-main", source: "thread" });
  });

  it("keeps an existing thread on its exhausted account instead of breaking it", () => {
    const limited = account({ id: "codex-main", family: "codex", kind: "main", home: null, limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([limited, work], {
      bindings: { "agent-1": { accountId: "codex-main", source: "thread", at: "x" } },
    });
    expect(chooseAccount(state, { ...codex, reason: "resume", usageOf: () => null })?.account.id).toBe("codex-main");
  });

  it("starts new agents on a usable account", () => {
    const limited = account({ id: "codex-main", family: "codex", kind: "main", home: null, limitedUntil: "2026-09-23T14:00:00Z" });
    const decision = chooseAccount(stateWith([limited, work]), { ...codex, reason: "create", usageOf: () => null });
    expect(decision?.account.id).toBe("codex-work");
    expect(decision?.bind).toMatchObject({ accountId: "codex-work", source: "thread" });
  });
});

describe("applyEnv", () => {
  it("sets values and drops inherited overrides", () => {
    expect(applyEnv({ CODEX_HOME: "/homes/work", CODEX_SQLITE_HOME: null }, { KEEP: "1", CODEX_SQLITE_HOME: "/x" })).toEqual({
      KEEP: "1",
      CODEX_HOME: "/homes/work",
    });
  });
});

describe("disabled accounts", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const work = account({ id: "claude-work" });
  const off = { disabled: true };

  it("routes around a disabled account but keeps the agent's own binding", () => {
    const pinned = stateWith([main, account({ id: "claude-work", ...off })], {
      bindings: { "agent-1": { accountId: "claude-work", source: "user", at: "2026-09-23T00:00:00Z" } },
    });
    const decision = chooseAccount(pinned, { ...base, reason: "refresh", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-main");
    expect(decision?.skipped?.why).toBe("disabled");
    expect(decision?.bind).toBeNull(); // so the agent returns once the account is enabled again
  });

  it("skips a disabled default even with automatic switching off", () => {
    const state = stateWith([account({ id: "claude-main", kind: "main", home: null, ...off }), work]);
    const decision = chooseAccount(state, { ...base, autoSwitch: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-work");
    expect(decision?.bind).toBeNull();
  });

  it("pins a new ChatGPT thread where it actually starts", () => {
    const codexMain = account({ id: "codex-main", family: "codex", kind: "main", home: null, ...off });
    const codexWork = account({ id: "codex-work", family: "codex" });
    const decision = chooseAccount(stateWith([codexMain, codexWork]), {
      ...base,
      family: "codex",
      portable: false,
      reason: "create",
      usageOf: () => null,
    });
    expect(decision?.account.id).toBe("codex-work");
    expect(decision?.bind).toMatchObject({ accountId: "codex-work", source: "thread" });
  });

  it("leaves an existing ChatGPT thread on its disabled account, since it can't move", () => {
    const codexMain = account({ id: "codex-main", family: "codex", kind: "main", home: null });
    const codexWork = account({ id: "codex-work", family: "codex", ...off });
    const state = stateWith([codexMain, codexWork], {
      bindings: { "agent-1": { accountId: "codex-work", source: "thread", at: "2026-09-23T00:00:00Z" } },
    });
    const decision = chooseAccount(state, { ...base, family: "codex", portable: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("codex-work");
  });

  it("is never the most available account", () => {
    const state = stateWith([main, account({ id: "claude-work", ...off })]);
    const usageOf = (id: string) => usage(id === "claude-main" ? 90 : 5);
    expect(mostAvailable(state, "claude", usageOf, NOW)?.id).toBe("claude-main");
  });
});
