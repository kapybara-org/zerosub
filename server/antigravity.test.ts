import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { preferences } from "../shared/preferences";
import type { FamilyAdapter, Identity, UsageRead } from "./adapter";
import { AntigravityAdapter, AntigravityLogin, antigravityEmail, antigravityModelScope, parseAntigravityUsage } from "./antigravity";
import { absentPi } from "./fakes.test-support";
import { familiesFromConfig } from "./families";
import { detectAntigravityLimit, detectAntigravitySignOut } from "./limits";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, type StoredState } from "./state";

describe("Antigravity accounts", () => {
  it("routes the built-in provider and leaves independently configured homes and keys alone", () => {
    expect(familiesFromConfig({}).antigravity).toBe("antigravity");
    const families = familiesFromConfig({
      work: { extends: "antigravity" },
      separate: { extends: "antigravity", command: ["agy", "acp", "--gemini-dir", "/other"] },
      key: { extends: "antigravity", env: { GEMINI_API_KEY: "fixture" } },
    });
    expect(families).toMatchObject({ antigravity: "antigravity", work: "antigravity" });
    expect(families).not.toHaveProperty("separate");
    expect(families).not.toHaveProperty("key");
    expect(familiesFromConfig({ antigravity: { env: { HOME: "/other" } } }).antigravity).toBeUndefined();
    expect(familiesFromConfig({ antigravity: { command: ["agy", "acp", "--app-data-dir=/other"] } }).antigravity).toBeUndefined();
  });

  it.skipIf(process.platform !== "linux")("keeps the CLI environment and isolates the added sign-in", async () => {
    const adapter = new AntigravityAdapter();
    expect(await adapter.env(null)).toEqual({});
    expect(await adapter.env("/isolated")).toMatchObject({
      HOME: "/isolated", SSH_CONNECTION: "paseo", GEMINI_API_KEY: "", GOOGLE_APPLICATION_CREDENTIALS: "",
    });
  });

  it.skipIf(process.platform !== "linux")("passes the pasted code to the official login process", async () => {
    const home = await mkdtemp(join(tmpdir(), "zerosub-agy-login-"));
    const command = join(home, "agy");
    await writeFile(command, '#!/bin/sh\nprintf "https://accounts.google.com/sign-in\\n"\nread -r code\n[ "$code" = "test-code" ]\n', { mode: 0o700 });
    const login = new AntigravityLogin(command, { ...process.env, HOME: home });
    try {
      await vi.waitFor(() => expect(login.progress).toMatchObject({ step: "waiting", codeUrl: "https://accounts.google.com/sign-in" }));
      await expect(login.submitCode("first\nsecond")).rejects.toThrow("single authorization code");
      await login.submitCode("test-code");
      await expect(login.finished).resolves.toMatchObject({ ok: true });
    } finally {
      login.cancel();
      await login.finished;
      await rm(home, { recursive: true });
    }
  });

  it("matches personal Google identities without retaining credential fields", () => {
    expect(antigravityEmail('{"auth_method":"consumer","id_token_email":" Example@Google.com ","token":{}}')).toBe("example@google.com");
    expect(antigravityEmail('{"auth_method":"enterprise","id_token_email":"example@google.com"}')).toBeNull();
    expect(antigravityEmail('{"auth_method":"consumer","id_token_email":"invalid"}')).toBeNull();
    expect(antigravityEmail("malformed JSON")).toBeNull();
  });

  it("shows quota buckets as usage and ignores disabled, epoch-zero resets, and malformed windows", () => {
    expect(parseAntigravityUsage(JSON.stringify({ response: [
      "Gemini Models\tWeekly Limit Remaining\t25%\t2026-11-30T19:58:00Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t99.5%\t",
      "Claude and GPT models\tWeekly Limit Remaining\t100%\t1970-01-01T00:00:00Z",
      "Gemini Models\tFive Hour Limit Remaining\tdisabled\t",
      "invalid",
      "Other\tWeekly Limit Remaining\t101%",
    ].join("\n") }))).toEqual([
      { id: "agy-gemini-models-weekly", label: "Weekly · Gemini Models", usedPercent: 75, resetsAt: "2026-11-30T19:58:00.000Z" },
      { id: "agy-claude-and-gpt-models-5-hour", label: "5-hour · Claude and GPT models", usedPercent: 0.5, resetsAt: null },
      { id: "agy-claude-and-gpt-models-weekly", label: "Weekly · Claude and GPT models", usedPercent: 0, resetsAt: null },
    ]);
    expect(parseAntigravityUsage("<error>")).toEqual([]);
  });

  it("maps Antigravity model IDs to their fallback quota-bucket scope", () => {
    expect(antigravityModelScope("gemini-4-neon-high")).toBe("gemini");
    expect(antigravityModelScope("gemini-pro-orchestrator-neon")).toBe("gemini");
    expect(antigravityModelScope("claude-opus-5-5-high")).toBe("claude/gpt");
    expect(antigravityModelScope("gpt-oss-120b-medium")).toBe("claude/gpt");
    expect(antigravityModelScope("default")).toBeNull();
    expect(antigravityModelScope(null)).toBeNull();
  });
});

describe("Antigravity failover and hand-off", () => {
  const MAIN = MAIN_ACCOUNT_ID.antigravity;
  const WORK = "antigravity-work";
  const AGENT = "agy-agent-1";

  type FakeAgent = {
    id: string;
    provider: string;
    title: string;
    status: string;
    cwd: string;
    workspaceId: string | null;
    archivedAt: string | null;
    lastUserMessageAt: string | null;
    currentModeId?: string | null;
    labels?: Record<string, string>;
    model?: string;
    runtimeInfo?: { model?: string };
  };

  async function setUp(options: {
    model?: string | null;
    usage?: (home: string | null) => UsageRead;
    identity?: (home: string | null) => Identity;
    extraAccounts?: Array<{ id: string; label: string; kind: "managed"; home: string; identity?: string; email?: string }>;
  } = {}) {
    const dir = await mkdtemp(join(tmpdir(), "zerosub-agy-failover-"));
    const previousHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = dir;
    const store = new StateStore(join(dir, "state.json"));
    const main = {
      id: MAIN,
      family: "antigravity" as const,
      label: "personal",
      kind: "main" as const,
      home: null,
      email: "personal@example.com",
      identity: "antigravity|personal@example.com",
      createdAt: "2026-09-23T00:00:00.000Z",
    };
    const work = {
      id: WORK,
      family: "antigravity" as const,
      label: "work",
      kind: "managed" as const,
      home: join(dir, "work"),
      email: "work@example.com",
      identity: "antigravity|work@example.com",
      createdAt: "2026-09-23T01:00:00.000Z",
    };
    const extras = (options.extraAccounts ?? []).map((entry) => ({
      ...entry,
      family: "antigravity" as const,
      createdAt: "2026-09-23T02:00:00.000Z",
    }));
    await store.update((draft: StoredState) => {
      draft.accounts = [main, work, ...extras] as never;
      draft.defaults.antigravity = MAIN;
      draft.sessions[AGENT] = { accountId: MAIN, family: "antigravity", openedAt: "2026-09-23T07:00:00.000Z" };
    });

    const created: Array<{ agentId: string; title: string; prompt?: string; labels?: Record<string, string>; config?: { provider?: string } }> = [];
    const sent: Array<{ agentId: string; text: string; messageId?: string }> = [];
    const notes: Array<{
      from: string | null;
      to: string;
      outcome: string;
      detail: string | null;
      resetsAt: string | null;
      continuedIn?: { agentId: string; title: string } | null;
    }> = [];
    const agents = new Map<string, FakeAgent>();
    const timelines = new Map<string, Array<{ seqEnd: number; turnId: string; timestamp: string; item: { type: string; text: string; clientMessageId?: string } }>>();
    const rootAgent: FakeAgent = {
      id: AGENT,
      provider: "antigravity",
      title: "Build parser",
      status: "idle",
      cwd: "/repo",
      workspaceId: null,
      archivedAt: null,
      lastUserMessageAt: "2026-09-23T07:00:00.000Z",
      currentModeId: "auto",
      runtimeInfo: { model: options.model === undefined ? "gemini-4-neon-high" : (options.model ?? undefined) },
    };
    agents.set(AGENT, rootAgent);
    timelines.set(AGENT, [
      { seqEnd: 1, turnId: "t1", timestamp: "2026-09-23T07:00:00.000Z", item: { type: "user_message", text: "Fix the failing parser" } },
      { seqEnd: 2, turnId: "t1", timestamp: "2026-09-23T07:00:01.000Z", item: { type: "assistant_message", text: "Checking parser.ts now." } },
    ]);

    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      providers: { listModels: async () => ({ models: [{ id: "gemini-4-neon-high", isDefault: true }] }) },
      agents: {
        list: async () => ({ entries: [...agents.values()].map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
        create: async (request: { agentId: string; title: string; prompt?: string; labels?: Record<string, string>; config?: { provider?: string } }) => {
          created.push(request);
          agents.set(request.agentId, {
            id: request.agentId,
            provider: "antigravity",
            title: request.title,
            status: "idle",
            cwd: "/repo",
            workspaceId: null,
            archivedAt: null,
            lastUserMessageAt: null,
            currentModeId: "auto",
            labels: request.labels,
            runtimeInfo: { model: "gemini-4-neon-high" },
          });
          timelines.set(request.agentId, []);
          return { agent: { id: request.agentId } };
        },
        ref: (id: string = AGENT) => ({
          refresh: async () => ({ agent: agents.get(id) ?? null }),
          send: async (text: string, opts?: { messageId?: string }) => {
            sent.push({ agentId: id, text, messageId: opts?.messageId });
            const list = timelines.get(id) ?? [];
            const seq = (list.at(-1)?.seqEnd ?? 0) + 1;
            const nowIso = new Date().toISOString();
            list.push({ seqEnd: seq, turnId: `t-${seq}`, timestamp: nowIso, item: { type: "user_message", text, clientMessageId: opts?.messageId } });
            timelines.set(id, list);
            const target = agents.get(id);
            if (target) target.lastUserMessageAt = nowIso;
          },
          timeline: {
            append: async (item: { data: (typeof notes)[number] }) => void notes.push(item.data),
            refetch: async () => {
              const entries = timelines.get(id) ?? [];
              return {
                epoch: "e1",
                window: { maxSeq: entries.at(-1)?.seqEnd ?? 0 },
                entries,
                hasOlder: false,
                gap: false,
                staleCursor: false,
              };
            },
          },
        }),
      },
    };
    const adapter: FamilyAdapter = {
      ...absentPi(),
      family: "antigravity",
      portable: false,
      usageSpacingMs: 0,
      available: async () => ({ ok: true, detail: null }),
      env: async (home) => (home ? { HOME: home, SSH_CONNECTION: "paseo" } : ({} as Record<string, string>)),
      identity: async (home) =>
        options.identity?.(home) ?? { signedIn: true, email: home ? "work@example.com" : "personal@example.com", plan: null, organization: null, identity: `antigravity|${home ? "work" : "personal"}@example.com` },
      usage: async (home) =>
        options.usage?.(home) ?? { fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null },
      detectLimit: detectAntigravityLimit,
      detectSignOut: detectAntigravitySignOut,
    };
    const service = new Service(
      { claude: absentPi(), codex: absentPi(), pi: absentPi(), grok: absentPi(), cursor: absentPi(), antigravity: adapter },
      store,
    );
    service.setPreferences(preferences.schema.parse({ autoSwitch: true, autoContinue: true }));
    service.signOutRecheckMs = 0;

    return {
      service,
      store,
      paseo,
      created,
      sent,
      notes,
      agents,
      timelines,
      cleanup: async () => {
        await service.stop();
        if (previousHome === undefined) delete process.env.PASEO_HOME;
        else process.env.PASEO_HOME = previousHome;
        await rm(dir, { recursive: true, force: true, maxRetries: 5 });
      },
    };
  }

  it("limits only the agent's model group, preserves the turn reset duration, and hands off in an Antigravity tab", async () => {
    const weeklyReset = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const { service, store, paseo, created, sent, notes, cleanup } = await setUp({
      model: "gemini-4-neon-high",
      usage: () => ({
        fetchedAt: new Date().toISOString(),
        // Weekly is at 99% (1% left), while the turn hit the 5-hour limit resetting in 2h2m18s.
        windows: [
          { id: "agy-gemini-models-weekly", label: "Weekly · Gemini Models", usedPercent: 99, resetsAt: weeklyReset },
          { id: "agy-gemini-models-5-hour", label: "5-hour · Gemini Models", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
          { id: "agy-claude-and-gpt-models-weekly", label: "Weekly · Claude and GPT models", usedPercent: 0, resetsAt: null },
        ],
        error: null,
        cached: false,
        resets: null,
      }),
    });
    try {
      const before = Date.now();
      await service.onTurnEnded(
        {
          agent: { id: AGENT, provider: "antigravity" },
          turnId: "t1",
          outcome: { kind: "failed", error: { message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h2m18s." } },
          timeline: [{ type: "user_message", text: "Fix the failing parser" }],
        } as never,
        { paseo } as never,
      );

      await vi.waitFor(() => expect(sent).toHaveLength(1));
      const state = await store.read();
      const personal = state.accounts.find((entry) => entry.id === MAIN)!;
      expect(personal.limitedUntil).toBeNull();
      expect(personal.modelLimits.gemini).toBeDefined();
      const untilMs = Date.parse(personal.modelLimits.gemini!.until);
      expect(untilMs).toBeGreaterThanOrEqual(before + (2 * 3600 + 2 * 60 + 18) * 1000 - 2000);
      expect(untilMs).toBeLessThan(Date.parse(weeklyReset) - 86_400_000);
      expect(personal.modelLimits["claude/gpt"]).toBeUndefined();

      expect(created).toHaveLength(1);
      expect(created[0]?.title).toBe("Build parser (continued)");
      expect(sent[0]?.text).toContain("its Antigravity account (personal) reached its usage limit");
      expect(sent[0]?.text).not.toContain("ChatGPT");
      expect(sent[0]?.text).not.toContain("Codex");
      expect(state.bindings[created[0]!.agentId]?.accountId).toBe(WORK);
      expect(Object.keys(state.continuations)).toHaveLength(1);
      expect(notes[0]).toMatchObject({ from: "personal", to: "work", outcome: "continued" });
    } finally {
      await cleanup();
    }
  });

  it("matches a custom usage bucket from cached readings and ignores 99% weekly windows when the error has no reset duration", async () => {
    const fiveHourReset = new Date(Date.now() + 2 * 3600_000).toISOString();
    const weeklyReset = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const { service, store, paseo, cleanup } = await setUp({
      model: "custom-model-v1",
      usage: () => ({
        fetchedAt: new Date().toISOString(),
        windows: [
          { id: "agy-custom-models-5-hour", label: "5-hour · Custom Models", usedPercent: 100, resetsAt: fiveHourReset },
          { id: "agy-custom-models-weekly", label: "Weekly · Custom Models", usedPercent: 99, resetsAt: weeklyReset },
        ],
        error: null,
        cached: false,
        resets: null,
      }),
    });
    try {
      // Populate usage cache first so scopeAntigravityHit takes the cached-window matching branch.
      await service.refreshUsage(MAIN, true);
      await service.onTurnEnded(
        {
          agent: { id: AGENT, provider: "antigravity" },
          turnId: "t1",
          outcome: { kind: "failed", error: { message: "Error 429 [reason:QUOTA_EXHAUSTED]" } },
          timeline: [{ type: "user_message", text: "Fix it" }],
        } as never,
        { paseo } as never,
      );
      const personal = (await store.read()).accounts.find((entry) => entry.id === MAIN)!;
      expect(personal.modelLimits.custom?.until).toBe(fiveHourReset);
    } finally {
      await cleanup();
    }
  });

  it("propagates a model-group limit across Antigravity slots sharing the same Google identity", async () => {
    const { service, store, paseo, cleanup } = await setUp({
      extraAccounts: [{
        id: "antigravity-twin",
        label: "personal-isolated",
        kind: "managed",
        home: join(tmpdir(), "agy-twin"),
        email: "personal@example.com",
        identity: "antigravity|personal@example.com",
      }],
    });
    try {
      await service.onTurnEnded(
        {
          agent: { id: AGENT, provider: "antigravity" },
          turnId: "t1",
          outcome: { kind: "failed", error: { message: "Individual quota reached. Resets in 1h." } },
          timeline: [{ type: "user_message", text: "Fix it" }],
        } as never,
        { paseo } as never,
      );
      const state = await store.read();
      expect(state.accounts.find((entry) => entry.id === MAIN)?.modelLimits.gemini).toBeDefined();
      expect(state.accounts.find((entry) => entry.id === "antigravity-twin")?.modelLimits.gemini).toBeDefined();
    } finally {
      await cleanup();
    }
  });

  it("prevents duplicate tabs on repeated manual switches and follow-up failover turns on the parked source tab", async () => {
    const { service, paseo, created, sent, notes, cleanup } = await setUp();
    try {
      const first = await service.setAgentAccount(paseo as never, AGENT, WORK);
      expect(created).toHaveLength(1);
      expect(sent).toHaveLength(1);
      expect(first.continuedIn?.agentId).toBe(created[0]!.agentId);
      expect(sent[0]?.text).toContain('you moved the work to your Antigravity account "work"');

      // Picking the same account a second time reuses the existing tab instead of creating a second one.
      const second = await service.setAgentAccount(paseo as never, AGENT, WORK);
      expect(created).toHaveLength(1);
      expect(second.continuedIn?.agentId).toBe(first.continuedIn?.agentId);

      // A limit hit on the parked source tab notes the existing continuation instead of opening another tab.
      await service.onTurnEnded(
        {
          agent: { id: AGENT, provider: "antigravity" },
          turnId: "t2",
          outcome: { kind: "failed", error: { message: "Individual quota reached. Resets in 2h." } },
          timeline: [{ type: "user_message", text: "Try again" }],
        } as never,
        { paseo } as never,
      );
      expect(created).toHaveLength(1);
      expect(notes.at(-1)?.outcome).toBe("stayed");
      expect(notes.at(-1)?.detail).toContain("Build parser (continued)");
    } finally {
      await cleanup();
    }
  });

  it("creates only one tab when manual switch and failover race on the same Antigravity agent", async () => {
    const { service, paseo, created, notes, cleanup } = await setUp();
    try {
      const [manual] = await Promise.all([
        service.setAgentAccount(paseo as never, AGENT, WORK),
        service.onTurnEnded(
          {
            agent: { id: AGENT, provider: "antigravity" },
            turnId: "t1",
            outcome: { kind: "failed", error: { message: "Individual quota reached. Resets in 2h." } },
            timeline: [{ type: "user_message", text: "Fix it" }],
          } as never,
          { paseo } as never,
        ),
      ]);
      expect(created).toHaveLength(1);
      expect(manual.continuedIn?.agentId).toBe(created[0]!.agentId);
      expect(notes.some((note) => note.outcome === "continued" && note.continuedIn?.agentId === created[0]!.agentId)).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it.each(["default", null] as const)(
    "infers the sole 100%% model-group bucket when the Antigravity agent reports model %s",
    async (reportedModel) => {
      const { service, store, paseo, cleanup } = await setUp({
        model: reportedModel,
        usage: () => ({
          fetchedAt: new Date().toISOString(),
          windows: [
            { id: "agy-gemini-models-5-hour", label: "5-hour · Gemini Models", usedPercent: 100, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
            { id: "agy-claude-and-gpt-models-5-hour", label: "5-hour · Claude and GPT models", usedPercent: 10, resetsAt: new Date(Date.now() + 2 * 3600_000).toISOString() },
          ],
          error: null,
          cached: false,
          resets: null,
        }),
      });
      try {
        await service.refreshUsage(MAIN, true);
        await service.onTurnEnded(
          {
            agent: { id: AGENT, provider: "antigravity" },
            turnId: "t-default-scope",
            outcome: { kind: "failed", error: { message: "Individual quota reached. Resets in 2h." } },
            timeline: [{ type: "user_message", text: "Continue" }],
          } as never,
          { paseo } as never,
        );
        const personal = (await store.read()).accounts.find((entry) => entry.id === MAIN)!;
        expect(personal.limitedUntil).toBeNull();
        expect(personal.modelLimits.gemini).toBeDefined();
        expect(personal.modelLimits["claude/gpt"]).toBeUndefined();
      } finally {
        await cleanup();
      }
    },
  );

  it("keeps a model-group limit while one of its windows is full, extends reading limits to a later reset, and lifts once all windows have room", async () => {
    const fiveHourReset = new Date(Date.now() + 3 * 3600_000).toISOString();
    const weeklyReset = new Date(Date.now() + 4 * 86_400_000).toISOString();
    let fiveHourUsed = 100;
    let weeklyUsed = 40;
    const { service, store, cleanup } = await setUp({
      usage: () => ({
        fetchedAt: new Date().toISOString(),
        windows: [
          { id: "agy-gemini-models-5-hour", label: "5-hour · Gemini Models", usedPercent: fiveHourUsed, resetsAt: fiveHourReset },
          { id: "agy-gemini-models-weekly", label: "Weekly · Gemini Models", usedPercent: weeklyUsed, resetsAt: weeklyReset },
        ],
        error: null,
        cached: false,
        resets: null,
      }),
    });
    try {
      await service.refreshUsage(MAIN, true);
      expect((await store.read()).accounts.find((entry) => entry.id === MAIN)?.modelLimits.gemini?.until).toBe(fiveHourReset);

      // If the longer weekly window also reaches 100%, the reading-set limit extends to the later reset.
      weeklyUsed = 100;
      await service.refreshUsage(MAIN, true);
      expect((await store.read()).accounts.find((entry) => entry.id === MAIN)?.modelLimits.gemini?.until).toBe(weeklyReset);

      fiveHourUsed = 20;
      weeklyUsed = 20;
      await service.refreshUsage(MAIN, true);
      expect((await store.read()).accounts.find((entry) => entry.id === MAIN)?.modelLimits.gemini).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("does not falsely clear an account-level Antigravity limit when usage has no account-wide windows", async () => {
    const { service, store, paseo, cleanup } = await setUp({
      model: null,
      usage: () => ({
        fetchedAt: new Date().toISOString(),
        windows: [
          { id: "agy-gemini-models-weekly", label: "Weekly · Gemini Models", usedPercent: 50, resetsAt: new Date(Date.now() + 4 * 86_400_000).toISOString() },
        ],
        error: null,
        cached: false,
        resets: null,
      }),
    });
    try {
      await service.onTurnEnded(
        {
          agent: { id: AGENT, provider: "antigravity" },
          turnId: "t1",
          outcome: { kind: "failed", error: { message: "Individual quota reached. Resets in 2h." } },
          timeline: [{ type: "user_message", text: "Fix it" }],
        } as never,
        { paseo } as never,
      );
      await store.update((draft) => {
        const personal = draft.accounts.find((entry) => entry.id === MAIN)!;
        personal.limitedAt = new Date(Date.now() - 30 * 60_000).toISOString();
      });
      await service.refreshUsage(MAIN, true);
      expect((await store.read()).accounts.find((entry) => entry.id === MAIN)?.limitedUntil).not.toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("hands off an Antigravity conversation when the account signs out", async () => {
    let mainSignedIn = false;
    const { service, store, paseo, created, sent, cleanup } = await setUp({
      identity: (home) => ({
        signedIn: home ? true : mainSignedIn,
        email: home ? "work@example.com" : mainSignedIn ? "personal@example.com" : null,
        plan: null,
        organization: null,
        identity: home ? "antigravity|work@example.com" : mainSignedIn ? "antigravity|personal@example.com" : null,
      }),
    });
    try {
      await service.onTurnEnded(
        {
          agent: { id: AGENT, provider: "antigravity" },
          turnId: "t2",
          outcome: { kind: "failed", error: { message: "Authentication required" } },
          timeline: [{ type: "user_message", text: "Continue" }],
        } as never,
        { paseo } as never,
      );
      await vi.waitFor(() => expect(sent).toHaveLength(1));
      expect(created).toHaveLength(1);
      expect((await store.read()).accounts.find((entry) => entry.id === MAIN)?.signedIn).toBe(false);
      expect(sent[0]?.text).toContain("its Antigravity account (personal) was signed out");
    } finally {
      await cleanup();
    }
  });

  it("reuses the task's Antigravity tab even when the account has no personal identity", async () => {
    const { service, store, paseo, created, sent, cleanup } = await setUp({
      identity: () => ({
        signedIn: true,
        email: null,
        plan: null,
        organization: null,
        identity: null,
      }),
    });
    try {
      await store.update((draft) => {
        for (const entry of draft.accounts) {
          entry.identity = null;
          entry.email = null;
        }
      });
      const first = await service.setAgentAccount(paseo as never, AGENT, WORK);
      const workTab = first.continuedIn!.agentId;
      expect(created).toHaveLength(1);
      // In real Paseo, opening the new tab triggers interactive session.open and records its live session on WORK.
      await service.onSessionOpen(
        { agentId: workTab, provider: "antigravity", purpose: "interactive", reason: "create", cwd: "/repo" } as never,
        { paseo } as never,
      );

      const back = await service.setAgentAccount(paseo as never, workTab, MAIN);
      expect(back.continuedIn?.agentId).toBe(AGENT);
      expect(created).toHaveLength(1);

      const again = await service.setAgentAccount(paseo as never, AGENT, WORK);
      expect(again.continuedIn?.agentId).toBe(workTab);
      expect(created).toHaveLength(1);
      expect(sent).toHaveLength(3);
    } finally {
      await cleanup();
    }
  });
});
