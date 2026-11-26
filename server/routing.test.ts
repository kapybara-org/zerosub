import { describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import { applyEnv } from "./adapter";
import { parseRateLimits } from "./codex";
import { canStandIn, chooseAccount, fiveHourGated, isLastResort, isLimitedFor, isPaidStandIn, mostAvailable, paceScore, paceView, scopeCoversModel } from "./routing";
import { emptyState, type StoredAccount, type StoredState } from "./state";

const NOW = Date.parse("2026-09-23T12:00:00Z");

function account(partial: Partial<StoredAccount> & Pick<StoredAccount, "id">): StoredAccount {
  return {
    family: "claude",
    label: partial.id,
    autoLabel: false,
    kind: "managed",
    auth: "subscription",
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
    modelLimits: {},
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

it("routes around an account at a configured usage ceiling until that window resets", () => {
  const first = account({ id: "first", quotaCeilings: { five_hour: 60 } });
  const second = account({ id: "second" });
  const state = stateWith([first, second], { defaults: { claude: first.id, codex: null, pi: null } });
  const reading = usage(60);
  reading.windows[0]!.resetsAt = new Date(NOW + 60_000).toISOString();
  const input = { ...base, reason: "create" as const, usageOf: (id: string) => id === first.id ? reading : usage(85) };
  expect(chooseAccount(state, input)?.account.id).toBe(second.id);
  expect(chooseAccount(state, { ...input, now: NOW + 60_000 })?.account.id).toBe(first.id);
});

it("applies a Fable ceiling only to Fable agents", () => {
  const first = account({ id: "first", quotaCeilings: { weekly_fable: 80 } });
  const second = account({ id: "second" });
  const state = stateWith([first, second], { defaults: { claude: first.id, codex: null, pi: null } });
  const reading = usage(90);
  reading.windows = [{ id: "weekly_fable", label: "Weekly · Fable", usedPercent: 90, resetsAt: null }];
  const input = { ...base, reason: "create" as const, usageOf: (id: string) => id === first.id ? reading : null };
  expect(chooseAccount(state, { ...input, model: "claude-fable-5" })?.account.id).toBe(second.id);
  expect(chooseAccount(state, { ...input, model: "claude-sonnet-5" })?.account.id).toBe(first.id);
  expect(chooseAccount(state, input)?.account.id).toBe(first.id);
});

it("moves an agent from a capped stand-in to a third account with room", () => {
  const limited = account({ id: "limited", limitedUntil: new Date(NOW + 60_000).toISOString() });
  const capped = account({ id: "capped", quotaCeilings: { five_hour: 80 } });
  const free = account({ id: "free" });
  const state = stateWith([limited, capped, free], { defaults: { claude: limited.id, codex: null, pi: null } });
  const route = chooseAccount(state, {
    ...base, reason: "refresh", current: capped.id, usageOf: (id) => usage(id === capped.id ? 80 : 85),
  });
  expect(route?.account.id).toBe(free.id);
});

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
    const state = stateWith([main, work], { defaults: { claude: "claude-work", codex: null, pi: null } });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-work");
  });

  it("prefers the agent's own binding over the default", () => {
    const state = stateWith([main, work, personal], {
      defaults: { claude: "claude-work", codex: null, pi: null },
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

  it("keeps an agent pinned with allowLimited on its limited account", () => {
    const limited = account({ id: "claude-work", limitedUntil: "2026-09-23T14:00:00Z" });
    const bindings = { "agent-1": { accountId: "claude-work", source: "user" as const, at: "x", allowLimited: true as const } };
    const state = stateWith([main, limited, personal], { bindings });
    for (const reason of ["create", "refresh", "resume"] as const) {
      const decision = chooseAccount(state, { ...base, reason, usageOf: () => usage(10) });
      expect(decision?.account.id, reason).toBe("claude-work");
      expect(decision?.skipped, reason).toBeNull();
    }
    // Without the flag the same pin is swapped, and a signed-out or disabled account is swapped either way.
    const plain = stateWith([main, limited, personal], { bindings: { "agent-1": { accountId: "claude-work", source: "user", at: "x" } } });
    expect(chooseAccount(plain, { ...base, reason: "resume", usageOf: () => usage(10) })?.account.id).not.toBe("claude-work");
    for (const patch of [{ signedIn: false }, { disabled: true }]) {
      const out = stateWith([main, { ...limited, ...patch }, personal], { bindings });
      expect(chooseAccount(out, { ...base, reason: "resume", usageOf: () => usage(10) })?.account.id).not.toBe("claude-work");
    }
  });

  it("doesn't let allowLimited lift a quota maximum", () => {
    // 81% used under an 80% maximum: at the ceiling the user set, with no provider limit.
    const capped = account({ id: "claude-work", quotaCeilings: { five_hour: 80 } });
    const bindings = { "agent-1": { accountId: "claude-work", source: "user" as const, at: "x", allowLimited: true as const } };
    const usageOf = (id: string) => (id === "claude-work" ? usage(81) : usage(10));
    const decision = chooseAccount(stateWith([main, capped, personal], { bindings }), { ...base, reason: "resume", usageOf });
    expect(decision?.account.id).not.toBe("claude-work");
    expect(decision?.skipped).toMatchObject({ why: "limited" });
    // Under the maximum, the pin holds at a provider limit.
    const limitedUnder = { ...capped, limitedUntil: "2026-09-23T14:00:00Z" };
    const under = chooseAccount(stateWith([main, limitedUnder, personal], { bindings }), { ...base, reason: "resume", usageOf: () => usage(70) });
    expect(under?.account.id).toBe("claude-work");
  });

  it("skips an exhausted account for the roomiest usable one", () => {
    const limited = account({ id: "claude-work", limitedUntil: "2026-09-23T14:00:00Z" });
    const state = stateWith([main, limited, personal], { defaults: { claude: "claude-work", codex: null, pi: null } });
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
    const state = stateWith([main, limited], { defaults: { claude: "claude-work", codex: null, pi: null } });
    const decision = chooseAccount(state, { ...base, autoSwitch: false, reason: "resume", usageOf: () => null });
    expect(decision?.account.id).toBe("claude-work");
  });

  it("treats an expired limit as usable again", () => {
    const recovered = account({ id: "claude-work", limitedUntil: "2026-09-23T11:00:00Z" });
    const state = stateWith([main, recovered], { defaults: { claude: "claude-work", codex: null, pi: null } });
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

  it("never stands a Pi account in for another, so new Pi agents follow the default even when balancing", () => {
    const cli = account({ id: "pi", family: "pi", kind: "main", home: null });
    const key = account({ id: "pi-key", family: "pi", auth: "api" });
    const other = account({ id: "pi-other", family: "pi", auth: "api" });
    const state = stateWith([cli, key, other], { defaults: { claude: null, codex: null, pi: "pi-key" } });
    const pi = { ...base, family: "pi" as const, usageOf: () => null };
    expect(chooseAccount(state, { ...pi, balanceNewAgents: true, reason: "create" })?.account.id).toBe("pi-key");
    // Its key refused: nothing else is billed in its place, the CLI login included.
    const refused = stateWith([cli, { ...key, signedIn: false }, other], { defaults: state.defaults });
    expect(chooseAccount(refused, { ...pi, reason: "create" })).toMatchObject({ account: { id: "pi-key" }, skipped: null });
    expect(mostAvailable(refused, "pi", () => null, NOW)).toBeUndefined();
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
      // Past its reset, the near window starts again empty: by headroom it is then the roomier one.
      // Pacing still reads a cached or failed reading's windows, and the near reset is behind its week's pace.
      expect(decision?.account.id).toBe(["past-reset", "cached", "error"].includes(condition) ? soon.id : later.id);
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
    const state = stateWith([main, work], { defaults: { claude: "claude-work", codex: null, pi: null } });
    expect(mostAvailable(state, "claude", () => usage(20), NOW)?.id).toBe("claude-work");
  });

  it("ranks accounts by the room they have for any model, not by one model's full window", () => {
    const main = account({ id: "claude-main", kind: "main", home: null });
    const work = account({ id: "claude-work" });
    const state = stateWith([main, work], { defaults: { claude: "claude-main", codex: null, pi: null } });
    const usageOf = (id: string): Usage =>
      id === "claude-work"
        ? {
            ...usage(10),
            windows: [
              { id: "five_hour", label: "5-hour", usedPercent: 10, resetsAt: null },
              { id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 100, resetsAt: null },
            ],
          }
        : usage(60);
    expect(mostAvailable(state, "claude", usageOf, NOW)?.id).toBe("claude-work");
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

  it("gives an existing thread ZeroSub never routed to the CLI login, whatever the default", () => {
    const state = stateWith([main, work], { defaults: { claude: null, codex: "codex-work", pi: null } });
    for (const reason of ["resume", "refresh", "import"] as const) {
      const decision = chooseAccount(state, { ...codex, reason, usageOf: () => null });
      expect(decision?.account.id).toBe("codex-main");
      expect(decision?.bind).toMatchObject({ accountId: "codex-main", source: "thread" });
    }
    // A brand-new agent, and a thread ZeroSub opened before (it has a session record), follow the default.
    expect(chooseAccount(state, { ...codex, reason: "create", usageOf: () => null })?.account.id).toBe("codex-work");
    const routed = stateWith([main, work], {
      defaults: { claude: null, codex: "codex-work", pi: null },
      sessions: { "agent-1": { accountId: "codex-work", family: "codex", openedAt: "x" } },
    });
    expect(chooseAccount(routed, { ...codex, reason: "resume", usageOf: () => null })?.account.id).toBe("codex-work");
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

  it("leaves an agent on the stand-in it runs on, rather than whichever ranks first now", () => {
    // Otherwise every time two accounts swap places, alignment reloads every agent of the disabled one.
    const disabled = account({ id: "claude-work", ...off });
    const bindings = { "agent-1": { accountId: "claude-work", source: "user" as const, at: "2026-09-23T00:00:00Z" } };
    const usageOf = (id: string) => usage(id === "claude-main" ? 5 : 60);
    const route = (others: StoredAccount[], current?: string) =>
      chooseAccount(stateWith([main, disabled, ...others], { bindings }), { ...base, reason: "refresh", usageOf, current });
    const personal = account({ id: "claude-personal" });
    expect(route([personal])?.account.id).toBe("claude-main");
    expect(route([personal], "claude-personal")?.account.id).toBe("claude-personal");
    expect(route([personal], "claude-personal")?.bind).toBeNull(); // so it still returns once work is enabled
    // Only an account routing could have picked by itself stands in: not the disabled one, an API account or a full one.
    expect(route([personal], "claude-work")?.account.id).toBe("claude-main");
    expect(route([account({ id: "claude-api", auth: "api" })], "claude-api")?.account.id).toBe("claude-main");
    expect(route([account({ id: "claude-personal", limitedUntil: "2026-09-23T14:00:00Z" })], "claude-personal")?.account.id).toBe(
      "claude-main",
    );
  });
});

describe("threads ZeroSub never routed (Codex)", () => {
  const main = account({ id: "codex-main", family: "codex", kind: "main", home: null });
  const work = account({ id: "codex-work", family: "codex" });
  const codex = { ...base, family: "codex" as const, portable: false };
  const byDefault = (patch: Partial<StoredState> = {}) => stateWith([main, work], { defaults: { claude: null, codex: "codex-work", pi: null }, ...patch });

  it("belong to the CLI login they ran on, whether resumed, reloaded or imported", () => {
    // Started while ZeroSub was off, say: no pin and no session record.
    for (const reason of ["resume", "refresh", "import"] as const) {
      const decision = chooseAccount(byDefault(), { ...codex, reason, usageOf: () => null });
      expect(decision?.account.id).toBe("codex-main");
      expect(decision?.bind).toMatchObject({ accountId: "codex-main", source: "thread" });
    }
  });

  it("still start new agents on the default", () => {
    expect(chooseAccount(byDefault(), { ...codex, reason: "create", usageOf: () => null })?.account.id).toBe("codex-work");
  });

  it("follow the default when ZeroSub routed their session but the pin is gone", () => {
    // Removing an account drops its pins; a thread without history then moves like a new one.
    const recorded = byDefault({ sessions: { "agent-1": { accountId: "codex-gone", family: "codex", openedAt: "x" } } });
    expect(chooseAccount(recorded, { ...codex, reason: "refresh", usageOf: () => null })?.account.id).toBe("codex-work");
  });

  it("leave Claude conversations following the default", () => {
    const claudeMain = account({ id: "claude-main", kind: "main", home: null });
    const claudeWork = account({ id: "claude-work" });
    const state = stateWith([claudeMain, claudeWork], { defaults: { claude: "claude-work", codex: null, pi: null } });
    expect(chooseAccount(state, { ...base, reason: "resume", usageOf: () => null })?.account.id).toBe("claude-work");
  });
});

describe("headroom", () => {
  it("ranks by the windows that cap the whole account, not one model's", async () => {
    const { headroomScore } = await import("./routing");
    const reading = (windows: Usage["windows"]): Usage => ({ fetchedAt: "", windows, error: null, cached: false, resets: null, credits: null });
    const opusFull = reading([
      { id: "five_hour", label: "5-hour", usedPercent: 10, resetsAt: null },
      { id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 100, resetsAt: null },
    ]);
    expect(headroomScore(opusFull)).toBe(10);
    expect(headroomScore(reading([{ id: "primary", label: "5h", usedPercent: 70, resetsAt: null }]))).toBe(70);
    expect(headroomScore(null)).toBe(50);
    // A window that reset since the reading counts as empty.
    const reset = reading([
      { id: "five_hour", label: "5h", usedPercent: 100, resetsAt: "2026-09-23T13:00:00Z" },
      { id: "seven_day", label: "Week", usedPercent: 40, resetsAt: "2026-09-26T00:00:00Z" },
    ]);
    expect(headroomScore(reset, Date.parse("2026-09-23T13:01:00Z"))).toBe(40);
    expect(headroomScore(reset, Date.parse("2026-09-23T12:59:00Z"))).toBe(100);
  });
});

describe("the 5-hour gate", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const second = account({ id: "claude-second" });
  const reading = (fiveHour: number, weekly: number): Usage => ({
    fetchedAt: "2026-09-23T11:59:00Z",
    windows: [
      { id: "five_hour", label: "5-hour", usedPercent: fiveHour, resetsAt: "2026-09-23T13:00:00Z" },
      { id: "seven_day", label: "Weekly", usedPercent: weekly, resetsAt: "2026-09-25T00:00:00Z" },
    ],
    error: null,
    cached: false,
    resets: null,
    credits: null,
  });

  it("starts a new agent on an account under the gate, though the gated one has the lower peak", () => {
    // By peak alone the second account (81%) beats the CLI login (88% of its week), and fills up minutes later.
    const usageOf = (id: string) => (id === "claude-second" ? reading(81, 85) : reading(7, 88));
    const decision = chooseAccount(stateWith([main, second]), { ...base, balanceNewAgents: true, reason: "create", usageOf });
    expect(decision?.account.id).toBe("claude-main");
    expect(decision?.bind?.selectionReason).toBe("headroom");
  });

  it("still ranks by peak while both are under the gate, or both past it", () => {
    const under = (id: string) => (id === "claude-second" ? reading(50, 85) : reading(7, 88));
    expect(mostAvailable(stateWith([main, second]), "claude", under, NOW)?.id).toBe("claude-second");
    const both = (id: string) => (id === "claude-second" ? reading(85, 85) : reading(90, 88));
    expect(mostAvailable(stateWith([main, second]), "claude", both, NOW)?.id).toBe("claude-second");
  });

  it("ranks an account that just reset by what it has left, though its last reading showed it full", () => {
    const third = account({ id: "claude-third" });
    const usageOf = (id: string) => (id === "claude-second" ? reading(100, 30) : reading(70, 60));
    expect(mostAvailable(stateWith([second, third]), "claude", usageOf, Date.parse("2026-09-23T13:01:00Z"))?.id).toBe("claude-second");
    expect(mostAvailable(stateWith([second, third]), "claude", usageOf, Date.parse("2026-09-23T12:59:00Z"))?.id).toBe("claude-third");
  });

  it("applies to ChatGPT's 5-hour window too", () => {
    const busy = account({ id: "codex-busy", family: "codex" });
    const quiet = account({ id: "codex-quiet", family: "codex" });
    const codex = (short: number, weekly: number): Usage => ({
      ...usage(0),
      windows: codexWindows([short, "2026-09-23T16:00:00Z"], [weekly, "2026-09-27T10:00:00Z"]),
    });
    const usageOf = (id: string) => (id === busy.id ? codex(82, 40) : codex(10, 85));
    expect(mostAvailable(stateWith([busy, quiet]), "codex", usageOf, NOW)?.id).toBe(quiet.id);
  });

  it("counts a 5-hour window that already reset, or no reading, as under the gate", () => {
    const past = { ...reading(95, 85), windows: [{ id: "five_hour", label: "5-hour", usedPercent: 95, resetsAt: "2026-09-23T11:00:00Z" }] };
    expect(fiveHourGated(past, NOW)).toBe(false);
    expect(fiveHourGated(null, NOW)).toBe(false);
    expect(fiveHourGated(reading(80, 0), NOW)).toBe(true);
    expect(fiveHourGated(reading(79, 0), NOW)).toBe(false);
  });

  it("ranks an account with a full week last, though its 5-hour window reset and lifted its limit", () => {
    // Its limit lifted at the 5-hour reset, but the week it also used up hasn't reset: it has no room.
    const lifted = account({ id: "claude-lifted", limitedUntil: "2026-09-23T11:00:00Z" });
    const stale: Usage = {
      ...reading(100, 100),
      fetchedAt: "2026-09-23T10:30:00Z",
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: "2026-09-23T11:00:00Z" },
        { id: "seven_day", label: "Weekly", usedPercent: 100, resetsAt: "2026-09-25T00:00:00Z" },
      ],
    };
    const usageOf = (id: string) => (id === lifted.id ? stale : reading(85, 10));
    expect(mostAvailable(stateWith([second, lifted]), "claude", usageOf, NOW)?.id).toBe(second.id);
  });

  it("ranks a ChatGPT account with a full week last, though credits keep it going", () => {
    const busy = account({ id: "codex-busy", family: "codex" });
    const full = account({ id: "codex-full", family: "codex" });
    const usageOf = (id: string): Usage =>
      id === busy.id
        ? { ...usage(0), windows: codexWindows([80, "2026-09-23T16:00:00Z"], [10, "2026-09-27T10:00:00Z"]) }
        : {
            ...usage(0),
            windows: codexWindows([0, "2026-09-23T16:00:00Z"], [100, "2026-09-27T10:00:00Z"]),
            credits: { balance: 500, unlimited: false },
          };
    expect(mostAvailable(stateWith([busy, full]), "codex", usageOf, NOW)?.id).toBe(busy.id);
  });
});

describe("Azure OpenAI accounts", () => {
  const codex = { ...base, family: "codex" as const, portable: false };
  const cli = account({ id: "codex-main", family: "codex", kind: "main", home: null });
  const sub = account({ id: "codex-sub", family: "codex" });
  const azure = account({ id: "codex-azure", family: "codex", auth: "api", provider: "azure", createdAt: "2026-08-01T00:00:00Z" });
  const out = (entry: StoredAccount) => ({ ...entry, limitedUntil: "2026-09-23T15:00:00Z", limitKind: "window" as const });
  // Azure has no plan windows, so it would otherwise look like the quietest account there is.
  const usageOf = (id: string) => (id === azure.id ? null : usage(70));

  it("are told apart by their marker, never by an API key alone", () => {
    expect(isLastResort(azure)).toBe(true);
    expect(isLastResort(sub)).toBe(false);
    // An API-key account without the marker (a Claude one, or a ChatGPT one some other version wrote) isn't Azure.
    const keyed = account({ id: "codex-key", family: "codex", auth: "api" });
    const claudeKey = account({ id: "claude-key", family: "claude", auth: "api", identity: "api|anthropic|0123456789abcdef" });
    expect(isLastResort(keyed)).toBe(false);
    expect(isLastResort(claudeKey)).toBe(false);
    expect(isLastResort({ ...claudeKey, provider: "azure" })).toBe(false);
    // A ChatGPT API key without the marker never stands in. A Claude one does with paid API fallback
    // on (see "Claude API-key accounts with paid API fallback"), though it isn't a marked one.
    expect(isPaidStandIn(keyed, true)).toBe(false);
    expect(isPaidStandIn(claudeKey, true)).toBe(true);
    expect(isPaidStandIn(azure, false)).toBe(true);
    for (const paidFallback of [false, true]) {
      expect(mostAvailable(stateWith([out(cli), keyed]), "codex", () => null, NOW, new Set(), paidFallback)).toBeUndefined();
    }
    const claudeOut = stateWith([account({ id: "claude-a", limitedUntil: "2026-09-23T15:00:00Z" }), claudeKey]);
    expect(mostAvailable(claudeOut, "claude", () => null, NOW, new Set(), false)).toBeUndefined();
    expect(mostAvailable(claudeOut, "claude", () => null, NOW, new Set(), true)?.id).toBe(claudeKey.id);
  });

  describe("with paid API fallback off (the default)", () => {
    it("are never picked by routing, however much room the rest has", () => {
      expect(canStandIn(azure, NOW)).toBe(false);
      expect(mostAvailable(stateWith([out(cli), out(sub), azure]), "codex", usageOf, NOW)).toBeUndefined();
      const state = stateWith([out(cli), { ...sub, disabled: true }, azure]);
      // A new agent whose default is out stays on it rather than moving onto the bill.
      const decision = chooseAccount(state, { ...codex, reason: "create", balanceNewAgents: true, usageOf });
      expect(decision?.account.id).toBe(cli.id);
      expect(decision?.skipped).toBeNull();
    });

    it("can still be chosen by hand, as the default or an agent's own account", () => {
      const asDefault = stateWith([cli, azure], { defaults: { claude: null, codex: azure.id, pi: null, grok: null, cursor: null } });
      expect(chooseAccount(asDefault, { ...codex, reason: "create", usageOf })?.account.id).toBe(azure.id);
      const bound = stateWith([cli, azure], { bindings: { "agent-1": { accountId: azure.id, source: "user", at: "2026-09-23T00:00:00Z" } } });
      expect(chooseAccount(bound, { ...codex, reason: "resume", usageOf })?.account.id).toBe(azure.id);
    });
  });

  describe("with paid API fallback on", () => {
    const on = { ...codex, paidFallback: true };

    it("are never picked while a subscription account has room, even with the most room", () => {
      expect(mostAvailable(stateWith([cli, sub, azure]), "codex", usageOf, NOW, new Set(), true)?.id).toBe(cli.id);
      expect(mostAvailable(stateWith([cli, out(sub), azure]), "codex", usageOf, NOW, new Set(), true)?.id).toBe(cli.id);
      const spread = chooseAccount(stateWith([cli, sub, azure]), { ...on, reason: "create", balanceNewAgents: true, usageOf });
      expect(spread?.account.id).not.toBe(azure.id);
    });

    it("take over once every subscription account is limited, disabled or signed out", () => {
      const state = stateWith([out(cli), { ...sub, disabled: true }, azure]);
      expect(mostAvailable(state, "codex", usageOf, NOW, new Set(), true)?.id).toBe(azure.id);
      expect(mostAvailable(stateWith([{ ...cli, signedIn: false }, out(sub), azure]), "codex", usageOf, NOW, new Set(), true)?.id).toBe(azure.id);
      // A new agent whose default is out lands on Azure, and is pinned there as its thread.
      const decision = chooseAccount(state, { ...on, reason: "create", usageOf });
      expect(decision?.account.id).toBe(azure.id);
      expect(decision?.skipped?.account.id).toBe(cli.id);
      expect(decision?.bind).toMatchObject({ accountId: azure.id, source: "thread" });
    });

    it("aren't used while cooling down after a rate limit", () => {
      expect(mostAvailable(stateWith([out(cli), out(azure)]), "codex", usageOf, NOW, new Set(), true)).toBeUndefined();
    });

    it("give new agents back to a subscription account once one has room again", () => {
      const later = NOW + 4 * 60 * 60_000; // After the subscription's limit lifted.
      const state = stateWith([out(cli), azure]);
      expect(chooseAccount(state, { ...on, reason: "create", now: NOW, usageOf })?.account.id).toBe(azure.id);
      expect(chooseAccount(state, { ...on, reason: "create", now: later, usageOf })?.account.id).toBe(cli.id);
    });

    describe("and a banked reset with automatic resets on", () => {
      const banked = (available: number, usableNow: boolean) => (id: string): Usage | null =>
        id === azure.id ? null : { ...usage(100), resets: { available, usableNow, blockedReason: null, expiresAt: null, refills: [], label: null } };
      const redeem = { ...on, reason: "create" as const, autoRedeem: true };

      it("open a new agent on the limited subscription, whose first turn spends the reset", () => {
        const state = stateWith([out(cli), azure]);
        for (const balanceNewAgents of [false, true]) {
          const decision = chooseAccount(state, { ...redeem, balanceNewAgents, usageOf: banked(1, true) });
          expect(decision?.account.id).toBe(cli.id);
          expect(decision?.skipped).toBeNull();
        }
        // Another limited subscription with a reset goes before Azure too, when the default has none.
        const usageOf = (id: string) => (id === sub.id ? banked(2, true)(id) : banked(0, true)(id));
        expect(chooseAccount(stateWith([out(cli), out(sub), azure]), { ...redeem, usageOf })?.account.id).toBe(sub.id);
      });

      it("still go to Azure when the reset can't be used now, none is banked, or automatic resets are off", () => {
        const state = stateWith([out(cli), azure]);
        expect(chooseAccount(state, { ...redeem, usageOf: banked(1, false) })?.account.id).toBe(azure.id);
        expect(chooseAccount(state, { ...redeem, usageOf: banked(0, true) })?.account.id).toBe(azure.id);
        expect(chooseAccount(state, { ...redeem, autoRedeem: false, usageOf: banked(1, true) })?.account.id).toBe(azure.id);
        expect(chooseAccount(state, { ...redeem, autoRedeem: false, balanceNewAgents: true, usageOf: banked(1, true) })?.account.id).toBe(azure.id);
      });

      it("only count for an account at a window limit, never a signed-out, disabled or budget-limited one", () => {
        for (const other of [{ ...out(sub), signedIn: false }, { ...out(sub), disabled: true }, { ...out(sub), limitKind: "budget" as const }]) {
          const decision = chooseAccount(stateWith([{ ...cli, signedIn: false }, other, azure]), { ...redeem, usageOf: banked(1, true) });
          expect(decision?.account.id).toBe(azure.id);
        }
      });

      it("never beat a subscription account with room", () => {
        const usageOf = (id: string) => (id === sub.id ? usage(40) : banked(1, true)(id));
        for (const balanceNewAgents of [false, true]) {
          expect(chooseAccount(stateWith([out(cli), sub, azure]), { ...redeem, balanceNewAgents, usageOf })?.account.id).toBe(sub.id);
        }
        expect(chooseAccount(stateWith([cli, out(sub), azure]), { ...redeem, usageOf })?.account.id).toBe(cli.id);
      });
    });

    it("aren't kept as a stand-in once a subscription account could take over", () => {
      const bindings = { "agent-1": { accountId: cli.id, source: "user" as const, at: "2026-09-23T00:00:00Z" } };
      const portable = { ...on, portable: true };
      const state = stateWith([out(cli), sub, azure], { bindings });
      expect(chooseAccount(state, { ...portable, reason: "refresh", current: azure.id, usageOf })?.account.id).toBe(sub.id);
      const allOut = stateWith([out(cli), out(sub), azure], { bindings });
      expect(chooseAccount(allOut, { ...portable, reason: "refresh", current: azure.id, usageOf })?.account.id).toBe(azure.id);
    });
  });
});

describe("AWS Bedrock accounts", () => {
  const cli = account({ id: "claude-main", kind: "main", home: null });
  const sub = account({ id: "claude-sub" });
  const bedrock = account({ id: "claude-bedrock", auth: "api", provider: "bedrock", createdAt: "2026-08-01T00:00:00Z" });
  // An API-key account from #65: a Claude account on a key, without the marker.
  const keyed = account({ id: "claude-key", auth: "api" });
  const out = (entry: StoredAccount) => ({ ...entry, limitedUntil: "2026-09-23T15:00:00Z", limitKind: "window" as const });
  const usageOf = (id: string) => (id === bedrock.id ? null : usage(70));
  const on = { ...base, paidFallback: true };

  it("are told apart by their marker, never by an API key alone", () => {
    expect(isLastResort(bedrock)).toBe(true);
    expect(isLastResort(keyed)).toBe(false);
    expect(isLastResort({ ...keyed, provider: "bedrock", family: "codex" })).toBe(false);
  });

  it("are never picked by routing with paid API fallback off, only by hand", () => {
    const state = stateWith([out(cli), { ...sub, disabled: true }, bedrock]);
    expect(mostAvailable(state, "claude", usageOf, NOW)).toBeUndefined();
    expect(chooseAccount(state, { ...base, reason: "create", balanceNewAgents: true, usageOf })?.account.id).toBe(cli.id);
    const bound = stateWith([cli, bedrock], { bindings: { "agent-1": { accountId: bedrock.id, source: "user", at: "2026-09-23T00:00:00Z" } } });
    expect(chooseAccount(bound, { ...base, reason: "resume", usageOf })?.account.id).toBe(bedrock.id);
    const asDefault = stateWith([cli, bedrock], { defaults: { claude: bedrock.id, codex: null, pi: null, grok: null, cursor: null } });
    expect(chooseAccount(asDefault, { ...base, reason: "create", usageOf })?.account.id).toBe(bedrock.id);
  });

  it("with it on, stand in once every subscription is out, without pinning the agent there", () => {
    const bindings = { "agent-1": { accountId: cli.id, source: "user" as const, at: "2026-09-23T00:00:00Z" } };
    const state = stateWith([out(cli), out(sub), keyed, bedrock], { bindings });
    const decision = chooseAccount(state, { ...on, reason: "refresh", usageOf });
    expect(decision?.account.id).toBe(bedrock.id);
    expect(decision?.skipped?.account.id).toBe(cli.id);
    // The agent keeps its own account, and goes back to it once it has room.
    expect(decision?.bind).toBeNull();
    expect(chooseAccount(state, { ...on, reason: "refresh", now: NOW + 4 * 60 * 60_000, current: bedrock.id, usageOf })?.account.id).toBe(cli.id);
  });

  it("with it on, take new agents spread across accounts without binding them there", () => {
    const state = stateWith([out(cli), out(sub), bedrock]);
    const decision = chooseAccount(state, { ...on, reason: "create", balanceNewAgents: true, usageOf });
    expect(decision?.account.id).toBe(bedrock.id);
    expect(decision?.bind).toBeNull();
    expect(chooseAccount(stateWith([cli, out(sub), bedrock]), { ...on, reason: "create", balanceNewAgents: true, usageOf })?.account.id).toBe(cli.id);
  });

  it("with it on, aren't kept as a stand-in once another subscription could take over", () => {
    const bindings = { "agent-1": { accountId: cli.id, source: "user" as const, at: "2026-09-23T00:00:00Z" } };
    expect(chooseAccount(stateWith([out(cli), sub, bedrock], { bindings }), { ...on, reason: "refresh", current: bedrock.id, usageOf })?.account.id).toBe(sub.id);
    expect(chooseAccount(stateWith([out(cli), out(sub), bedrock], { bindings }), { ...on, reason: "refresh", current: bedrock.id, usageOf })?.account.id).toBe(bedrock.id);
  });

  it("hold an agent ZeroSub bound there by itself (a ChatGPT chat continued on Claude) only until a subscription can take it", () => {
    const bind = (source: "auto" | "user") => ({ "agent-1": { accountId: bedrock.id, source, at: "2026-09-23T00:00:00Z" } });
    // While every subscription is out, it stays.
    expect(chooseAccount(stateWith([out(cli), out(sub), bedrock], { bindings: bind("auto") }), { ...on, reason: "refresh", current: bedrock.id, usageOf })?.account.id).toBe(bedrock.id);
    // Once one has room, it goes there, unpinned; the default first.
    const back = chooseAccount(stateWith([cli, out(sub), bedrock], { bindings: bind("auto") }), { ...on, reason: "refresh", current: bedrock.id, usageOf });
    expect(back?.account.id).toBe(cli.id);
    expect(back?.bind).toBeNull();
    expect(chooseAccount(stateWith([out(cli), sub, bedrock], { bindings: bind("auto") }), { ...on, reason: "refresh", current: bedrock.id, usageOf })?.account.id).toBe(sub.id);
    // In Auto mode too (paid fallback withheld): leaving Bedrock is always fine.
    expect(chooseAccount(stateWith([cli, out(sub), bedrock], { bindings: bind("auto") }), { ...base, reason: "resume", usageOf })?.account.id).toBe(cli.id);
    // A limited subscription with a banked reset takes it with automatic resets on, not without.
    const banked = (id: string): Usage | null =>
      id === bedrock.id ? null : { ...usage(100), resets: { available: 1, usableNow: true, blockedReason: null, expiresAt: null, refills: [], label: null } };
    const allOut = stateWith([out(cli), out(sub), bedrock], { bindings: bind("auto") });
    expect(chooseAccount(allOut, { ...on, autoRedeem: true, reason: "refresh", current: bedrock.id, usageOf: banked })?.account.id).toBe(cli.id);
    expect(chooseAccount(allOut, { ...on, reason: "refresh", current: bedrock.id, usageOf: banked })?.account.id).toBe(bedrock.id);
    // One the user put there stays, room or not.
    expect(chooseAccount(stateWith([cli, sub, bedrock], { bindings: bind("user") }), { ...on, reason: "refresh", current: bedrock.id, usageOf })?.account.id).toBe(bedrock.id);
  });

  describe("with it on and a banked reset with automatic resets on", () => {
    const banked = (available: number, usableNow: boolean) => (id: string): Usage | null =>
      id === bedrock.id ? null : { ...usage(100), resets: { available, usableNow, blockedReason: null, expiresAt: null, refills: [], label: null } };
    const redeem = { ...on, autoRedeem: true };
    const bindings = { "agent-1": { accountId: cli.id, source: "user" as const, at: "2026-09-23T00:00:00Z" } };

    it("open a new agent on the limited subscription, whose first turn spends the reset", () => {
      const state = stateWith([out(cli), bedrock]);
      for (const balanceNewAgents of [false, true]) {
        const decision = chooseAccount(state, { ...redeem, reason: "create", balanceNewAgents, usageOf: banked(1, true) });
        expect(decision?.account.id).toBe(cli.id);
        expect(decision?.skipped).toBeNull();
      }
      // Another limited subscription with a reset goes before Bedrock too, when the default has none.
      const usageOf = (id: string) => (id === sub.id ? banked(2, true)(id) : banked(0, true)(id));
      expect(chooseAccount(stateWith([out(cli), out(sub), bedrock]), { ...redeem, reason: "create", usageOf })?.account.id).toBe(sub.id);
    });

    it("keep an existing agent on its limited subscription, so its next turn spends the reset, rather than move it to Bedrock", () => {
      const state = stateWith([out(cli), bedrock], { bindings });
      for (const reason of ["resume", "refresh"] as const) {
        const decision = chooseAccount(state, { ...redeem, reason, current: cli.id, usageOf: banked(1, true) });
        expect(decision?.account.id).toBe(cli.id);
        expect(decision?.skipped).toBeNull();
      }
      // One already standing in on Bedrock goes back to the account whose reset it can spend.
      expect(chooseAccount(state, { ...redeem, reason: "refresh", current: bedrock.id, usageOf: banked(1, true) })?.account.id).toBe(cli.id);
    });

    it("still go to Bedrock when the reset can't be used now, none is banked, or automatic resets are off", () => {
      const fresh = stateWith([out(cli), bedrock]);
      const bound = stateWith([out(cli), bedrock], { bindings });
      for (const usageOf of [banked(1, false), banked(0, true)]) {
        expect(chooseAccount(fresh, { ...redeem, reason: "create", usageOf })?.account.id).toBe(bedrock.id);
        expect(chooseAccount(bound, { ...redeem, reason: "resume", usageOf })?.account.id).toBe(bedrock.id);
      }
      expect(chooseAccount(fresh, { ...redeem, autoRedeem: false, reason: "create", usageOf: banked(1, true) })?.account.id).toBe(bedrock.id);
      expect(chooseAccount(fresh, { ...redeem, autoRedeem: false, reason: "create", balanceNewAgents: true, usageOf: banked(1, true) })?.account.id).toBe(bedrock.id);
      expect(chooseAccount(bound, { ...redeem, autoRedeem: false, reason: "resume", usageOf: banked(1, true) })?.account.id).toBe(bedrock.id);
    });

    it("only count for an account at a window limit, never a signed-out, disabled or budget-limited one", () => {
      for (const other of [{ ...out(sub), signedIn: false }, { ...out(sub), disabled: true }, { ...out(sub), limitKind: "budget" as const }]) {
        const decision = chooseAccount(stateWith([{ ...cli, signedIn: false }, other, bedrock]), { ...redeem, reason: "create", usageOf: banked(1, true) });
        expect(decision?.account.id).toBe(bedrock.id);
      }
    });

    it("never beat a subscription account with room", () => {
      const usageOf = (id: string) => (id === sub.id ? usage(40) : banked(1, true)(id));
      for (const balanceNewAgents of [false, true]) {
        expect(chooseAccount(stateWith([out(cli), sub, bedrock]), { ...redeem, reason: "create", balanceNewAgents, usageOf })?.account.id).toBe(sub.id);
      }
      expect(chooseAccount(stateWith([out(cli), sub, bedrock], { bindings }), { ...redeem, reason: "resume", usageOf })?.account.id).toBe(sub.id);
    });
  });
});

describe("pacing", () => {
  const PNOW = Date.parse("2026-09-23T17:00:00Z");
  const hours = (h: number) => new Date(PNOW + h * 3_600_000).toISOString();
  /** `fiveStarted` and `weekElapsed` are how long ago each window started, in hours and days. */
  function pace(five: number, fiveStarted: number, week: number, weekElapsed: number): Usage {
    return {
      fetchedAt: new Date(PNOW).toISOString(),
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: five, resetsAt: hours(5 - fiveStarted) },
        { id: "seven_day", label: "Weekly", usedPercent: week, resetsAt: hours((7 - weekElapsed) * 24) },
      ],
      error: null, cached: false, resets: null, credits: null,
    };
  }
  const readings: Record<string, Usage> = {
    "claude-main": pace(30, 0.5, 25, 3.5),
    "claude-work": pace(45, 4, 50, 6),
    "claude-personal": pace(20, 2, 70, 2),
    "claude-spare": pace(35, 3.5, 40, 4),
  };
  const state = stateWith(Object.keys(readings).map((id) => account({ id, createdAt: id === "claude-main" ? "2026-08-01T00:00:00Z" : "2026-09-01T00:00:00Z" })), {
    defaults: { claude: "claude-main", codex: null, pi: null },
  });
  const usageOf = (id: string) => readings[id];

  it("scores the example accounts", () => {
    const score = (id: string, pending = 0) => paceScore(readings[id], pending, PNOW);
    expect(score("claude-main")).toMatchObject({ fiveHour: 90, gated: true });
    expect(score("claude-work").score).toBeCloseTo(58.33, 2);
    expect(score("claude-spare").score).toBe(70);
    expect(score("claude-personal").score).toBeCloseTo(245, 5);
    expect(score("claude-work", 1).score).toBeCloseTo(66.25, 5);
    expect(score("claude-work", 2).score).toBeCloseTo(76.25, 5);
  });

  it("breaks the score into card parts", () => {
    expect(paceView(readings["claude-main"], 0, PNOW)).toMatchObject({
      fiveHourUsed: 30, fiveHourProjected: 90, pendingFiveHour: 0, weeklyUsed: 25, weekElapsed: 50, pending: 0, gated: true,
    });
    const work = paceView(readings["claude-work"], 2, PNOW);
    expect(work).toMatchObject({ fiveHourUsed: 45, pendingFiveHour: 20, pendingWeekly: 4, gated: false });
    expect(work.fiveHourProjected).toBeCloseTo(76.25, 5);
    expect(work.weekElapsed).toBeCloseTo(85.71, 2);
    expect(paceView(undefined, 0, PNOW)).toMatchObject({
      fiveHourUsed: null, fiveHourProjected: 50, weeklyUsed: null, weekElapsed: null, gated: false,
    });
  });

  it("agrees with paceScore for every example account", () => {
    for (const id of Object.keys(readings)) {
      for (const pending of [0, 1, 2]) {
        const view = paceView(readings[id], pending, PNOW);
        const score = paceScore(readings[id], pending, PNOW);
        expect(view.fiveHourProjected).toBe(score.fiveHour);
        expect(view.gated).toBe(score.gated);
      }
    }
  });

  it("places three paced creates on work, work, spare, where the unpaced pick is main", () => {
    expect(mostAvailable(state, "claude", usageOf, PNOW)?.id).toBe("claude-main");
    const picks: string[] = [];
    const pending = new Map<string, number>();
    for (let n = 0; n < 3; n += 1) {
      const pick = mostAvailable(state, "claude", usageOf, PNOW, new Set(), false, { pendingOf: (id) => pending.get(id) ?? 0 })!;
      picks.push(pick.id);
      pending.set(pick.id, (pending.get(pick.id) ?? 0) + 1);
    }
    expect(picks).toEqual(["claude-work", "claude-work", "claude-spare"]);
  });

  it("holds back an account whose week is nearly used", () => {
    const week = (percent: number, weekElapsed = 4) => paceScore(pace(20, 2, percent, weekElapsed), 0, PNOW).weekHeld;
    expect(week(98, 7 - 2 / 24)).toBe(true);
    expect(week(90)).toBe(true);
    expect(week(89.9)).toBe(false);
    expect(week(98, 8)).toBe(false);

    const both: Record<string, Usage> = { "claude-main": pace(20, 2, 98, 7 - 2 / 24), "claude-work": pace(20, 2, 60, 4) };
    const two = stateWith(Object.keys(both).map((id) => account({ id })), { defaults: { claude: "claude-main", codex: null, pi: null } });
    const pacing = { pendingOf: () => 0 };
    expect(mostAvailable(two, "claude", (id) => both[id], PNOW, new Set(), false, pacing)?.id).toBe("claude-work");
  });

  it("gates a raw 5-hour reading at 80% even with a slow burn, and scores unknown usage in the middle", () => {
    const slow = pace(85, 4.9, 10, 6);
    expect(paceScore(slow, 0, PNOW).fiveHour).toBeLessThan(90);
    expect(paceScore(slow, 0, PNOW).gated).toBe(true);
    expect(paceScore(undefined, 2, PNOW).score).toBe(70);
  });

  it("scores an account with no 5-hour or weekly window as unknown", () => {
    const odd: Usage = { ...pace(0, 1, 0, 1), windows: [{ id: "weekly_opus", label: "Weekly - Opus", usedPercent: 10, resetsAt: null }] };
    expect(paceScore(odd, 1, PNOW)).toMatchObject({ fiveHour: 60, weekly: 0, score: 60 });
  });

  it("treats an unparseable resetsAt like a missing one", () => {
    const bad: Usage = {
      ...pace(0, 1, 0, 1),
      windows: [
        { id: "five_hour", label: "5-hour", usedPercent: 85, resetsAt: "soon" },
        { id: "seven_day", label: "Weekly", usedPercent: 40, resetsAt: "soon" },
      ],
    };
    expect(paceScore(bad, 1, PNOW)).toMatchObject({ fiveHour: 95, weekly: 42, score: 95, gated: true });
  });

  it("ignores pending placements and ranks the legacy way when balancing is off", () => {
    const decision = (balanceNewAgents: boolean) => chooseAccount(state, {
      ...base, now: PNOW, balanceNewAgents, reason: "create", usageOf, pendingOf: () => 5,
    });
    expect(decision(false)?.account.id).toBe("claude-main");
    expect(decision(true)?.account.id).toBe("claude-spare");
  });
});

describe("limits of one model's own window", () => {
  const fableLimit = { fable: { until: "2026-09-25T12:00:00Z", at: "2026-09-23T11:00:00Z", source: "turn" as const } };
  const main = account({ id: "claude-main", kind: "main", home: null });
  const work = account({ id: "claude-work", modelLimits: fableLimit });
  const open = stateWith([main, work], { defaults: { claude: "claude-work", codex: null, pi: null } });
  const input = { ...base, reason: "resume" as const, usageOf: () => null };

  it("matches a scope to the models whose name holds all its words", () => {
    expect(scopeCoversModel("fable", "claude-fable-5-2")).toBe(true);
    expect(scopeCoversModel("fable", "fable")).toBe(true);
    expect(scopeCoversModel("Fable", "Claude-Fable-5.2")).toBe(true);
    expect(scopeCoversModel("opus", "claude-fable-5-2")).toBe(false);
    expect(scopeCoversModel("fable", "claude-fables")).toBe(false);
    expect(scopeCoversModel("gemini", "gemini-4-neon-high")).toBe(true);
    expect(scopeCoversModel("gemini", "gemini-pro-orchestrator-neon")).toBe(true);
    expect(scopeCoversModel("gemini", "claude-opus-5-5-high")).toBe(false);
    expect(scopeCoversModel("claude/gpt", "claude-opus-5-5-high")).toBe(true);
    expect(scopeCoversModel("claude/gpt", "gpt-oss-120b-medium")).toBe(true);
    expect(scopeCoversModel("claude/gpt", "gemini-4-neon-high")).toBe(false);
    expect(scopeCoversModel("claude/gpt", "claude/gpt")).toBe(true);
    expect(scopeCoversModel("fable", null)).toBe(false);
    expect(scopeCoversModel("fable", undefined)).toBe(false);
    expect(scopeCoversModel("fable", "default")).toBe(false);
    expect(scopeCoversModel("", "claude-fable-5-2")).toBe(false);
    expect(scopeCoversModel("/", "claude-fable-5-2")).toBe(false);
  });

  it("ranks Antigravity accounts by the model group's headroom when only group windows exist", () => {
    const mainAgy = account({ id: "antigravity-main", family: "antigravity", kind: "main", home: null });
    const spareAgy = account({ id: "antigravity-spare", family: "antigravity" });
    const state = stateWith([mainAgy, spareAgy], { defaults: { claude: null, codex: null, pi: null, antigravity: mainAgy.id } });
    const usage = (gemini: number, claudeGpt: number): Usage => ({
      fetchedAt: "2026-09-23T11:59:00Z",
      windows: [
        { id: "agy-gemini-models-weekly", label: "Weekly · Gemini Models", usedPercent: gemini, resetsAt: "2026-09-30T00:00:00Z" },
        { id: "agy-claude-and-gpt-models-weekly", label: "Weekly · Claude and GPT models", usedPercent: claudeGpt, resetsAt: null },
      ],
      error: null,
      cached: false,
      resets: null,
      credits: null,
    });
    const usageOf = (id: string) => (id === mainAgy.id ? usage(90, 5) : usage(20, 80));
    expect(mostAvailable(state, "antigravity", usageOf, NOW, new Set(), false, undefined, "gemini-4-neon-high")?.id).toBe(spareAgy.id);
    expect(mostAvailable(state, "antigravity", usageOf, NOW, new Set(), false, undefined, "claude-opus-5-5-high")?.id).toBe(mainAgy.id);
    expect(mostAvailable(state, "antigravity", usageOf, NOW, new Set(), false, { pendingOf: () => 0 }, "gemini-4-neon-high")?.id).toBe(spareAgy.id);
  });

  it("leaves paceScore unchanged for Codex accounts with a non-5h/7d account window even when a model is passed", () => {
    const codexDailyOnly: Usage = {
      fetchedAt: "2026-09-23T11:59:00Z",
      windows: [{ id: "primary", label: "1-day", usedPercent: 95, resetsAt: "2026-09-24T12:00:00Z", minutes: 1440 }],
      error: null,
      cached: false,
      resets: null,
      credits: null,
    };
    expect(paceScore(codexDailyOnly, 0, NOW)).toEqual({ fiveHour: 50, weekly: 0, score: 50, gated: false, weekHeld: false });
    expect(paceScore(codexDailyOnly, 0, NOW, "gpt-5")).toEqual({ fiveHour: 50, weekly: 0, score: 50, gated: false, weekHeld: false });
  });

  it("limits an account only for the model it covers, and only until it expires", () => {
    expect(isLimitedFor(work, NOW, "claude-fable-5-2")).toBe(true);
    expect(isLimitedFor(work, NOW, "claude-opus-4-1")).toBe(false);
    expect(isLimitedFor(work, NOW, null)).toBe(false);
    expect(isLimitedFor(work, NOW)).toBe(false);
    expect(isLimitedFor(work, Date.parse("2026-09-26T00:00:00Z"), "claude-fable-5-2")).toBe(false);
    expect(canStandIn(work, NOW, "claude-fable-5-2")).toBe(false);
    expect(canStandIn(work, NOW, "claude-opus-4-1")).toBe(true);
  });

  it("routes an agent on that model away, and leaves other models and unknown ones where they are", () => {
    const fable = chooseAccount(open, { ...input, model: "claude-fable-5-2" });
    expect(fable?.account.id).toBe("claude-main");
    expect(fable?.skipped).toMatchObject({ why: "limited" });
    for (const model of ["claude-opus-4-1", null, undefined]) {
      const decision = chooseAccount(open, { ...input, model });
      expect(decision?.account.id).toBe("claude-work");
      expect(decision?.skipped).toBeNull();
    }
  });

  it("ignores a limit that has expired", () => {
    const expired = account({ id: "claude-work", modelLimits: { fable: { until: "2026-09-23T11:00:00Z", at: "x", source: "turn" } } });
    const state = stateWith([main, expired], { defaults: { claude: "claude-work", codex: null, pi: null } });
    expect(chooseAccount(state, { ...input, model: "claude-fable-5-2" })?.account.id).toBe("claude-work");
  });

  it("keeps an agent where it stands in only while that account takes its model", () => {
    const stateAB = stateWith([main, work, account({ id: "claude-third" })], { defaults: { claude: "claude-main", codex: null, pi: null } });
    const fable = chooseAccount({ ...stateAB, bindings: { "agent-1": { accountId: "claude-work", source: "user", at: "x" } } }, { ...input, current: "claude-work", model: "claude-fable-5-2" });
    expect(fable?.account.id).not.toBe("claude-work");
  });

  it("spreads a new agent of that model off the account", () => {
    const state = stateWith([main, work]);
    const pick = (model: string | null) => mostAvailable(state, "claude", () => null, NOW, new Set(), false, undefined, model)?.id;
    expect(pick("claude-fable-5-2")).toBe("claude-main");
    // Same headroom: the default (main) wins for an unaffected model too, so exclude it to see work is still usable.
    expect(mostAvailable(state, "claude", () => null, NOW, new Set(["claude-main"]), false, undefined, "claude-opus-4-1")?.id).toBe("claude-work");
    expect(mostAvailable(state, "claude", () => null, NOW, new Set(["claude-main"]), false, undefined, "claude-fable-5-2")).toBeUndefined();
  });
});

describe("Claude API-key accounts with paid API fallback", () => {
  const main = account({ id: "claude-main", kind: "main", home: null });
  const key = account({ id: "claude-key", auth: "api", identity: "api|anthropic|0123456789abcdef", createdAt: "2026-08-01T00:00:00Z" });
  // A key for another endpoint (a gateway, a third-party service speaking Anthropic's API).
  const gateway = account({ id: "claude-gateway", auth: "api", identity: "api|https://gw.example.com|0123456789abcdef", createdAt: "2026-08-01T00:00:00Z" });
  const out = (entry: StoredAccount) => ({ ...entry, limitedUntil: "2026-09-23T15:00:00Z", limitKind: "window" as const });
  const bound = (state: ReturnType<typeof stateWith>) => ({ ...state, bindings: { "agent-1": { accountId: main.id, source: "user" as const, at: "2026-09-23T00:00:00Z" } } });

  it("take a limited agent over only with the setting on, and only once no subscription can", () => {
    const state = bound(stateWith([out(main), key]));
    const off = chooseAccount(state, { ...base, usageOf: () => null, reason: "resume", current: main.id });
    expect(off?.account.id).toBe(main.id);
    const on = chooseAccount(state, { ...base, usageOf: () => null, reason: "resume", current: main.id, paidFallback: true });
    expect(on?.account.id).toBe(key.id);
    expect(on?.skipped?.account.id).toBe(main.id);
    // Not re-pinned there: the agent keeps its own binding and returns once its account has room.
    expect(on?.bind).toBeNull();
    // A subscription with room goes first.
    const other = account({ id: "claude-work" });
    expect(chooseAccount(bound(stateWith([out(main), key, other])), { ...base, usageOf: () => null, reason: "resume", current: main.id, paidFallback: true })?.account.id).toBe(other.id);
  });

  it("keep an agent already on one only while no subscription could take over", () => {
    const other = account({ id: "claude-work" });
    expect(chooseAccount(bound(stateWith([out(main), key])), { ...base, usageOf: () => null, reason: "resume", current: key.id, paidFallback: true })?.account.id).toBe(key.id);
    expect(chooseAccount(bound(stateWith([out(main), key, other])), { ...base, usageOf: () => null, reason: "resume", current: key.id, paidFallback: true })?.account.id).toBe(other.id);
  });

  it("with the setting off, aren't stand-ins at all: following the default leaves one, though the default is at its limit", () => {
    // The user put the agent on the key, then set it back to follow the default, which is out.
    const state = stateWith([out(main), key]);
    expect(isPaidStandIn(key, false)).toBe(false);
    expect(chooseAccount(state, { ...base, usageOf: () => null, reason: "resume", current: key.id })?.account.id).toBe(main.id);
    // With it on, the key is where the agent waits for a subscription, as with Azure or Bedrock.
    expect(chooseAccount(state, { ...base, usageOf: () => null, reason: "resume", current: key.id, paidFallback: true })?.account.id).toBe(key.id);
  });

  it("only count on Anthropic's own API: a key for another endpoint is used only when chosen, even with the setting on", () => {
    expect(isPaidStandIn(gateway, true)).toBe(false);
    // Anthropic's API typed out, as earlier versions saved it, counts as Anthropic's.
    expect(isPaidStandIn({ ...key, identity: "api|https://api.anthropic.com|0123456789abcdef" }, true)).toBe(true);
    expect(isPaidStandIn({ ...key, identity: null }, true)).toBe(false);
    const state = bound(stateWith([out(main), gateway]));
    expect(chooseAccount(state, { ...base, usageOf: () => null, reason: "resume", current: main.id, paidFallback: true })?.account.id).toBe(main.id);
    expect(mostAvailable(state, "claude", () => null, NOW, new Set(), true)).toBeUndefined();
    // Nor is an agent the user put there held on it once it follows the default again.
    expect(chooseAccount(stateWith([out(main), gateway]), { ...base, usageOf: () => null, reason: "resume", current: gateway.id, paidFallback: true })?.account.id).toBe(main.id);
  });

  it("stay stand-ins by the setting when one choice turns paid fallback off (Claude's Auto mode, for Bedrock)", () => {
    const state = stateWith([out(main), key]);
    expect(chooseAccount(state, { ...base, usageOf: () => null, reason: "resume", current: key.id, paidFallback: false, paidApi: true })?.account.id).toBe(key.id);
  });
});
