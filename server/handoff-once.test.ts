import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentTimelineItem, FamilyAdapter } from "./adapter";
import type { FamilyResolver } from "./families";
import { buildTranscript, continuationPrompt, shortenEarlierHandOff } from "./handoff";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore } from "./state";

const CODEX_MAIN = MAIN_ACCOUNT_ID.codex;
const SECOND = "codex-second";
const AGENT = "agent-1";

let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-handoff-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true });
});

function user(text: string): AgentTimelineItem {
  return { type: "user_message", text } as AgentTimelineItem;
}

describe("quoting an earlier hand-off", () => {
  it("leaves a message without one alone", () => {
    expect(shortenEarlierHandOff("Fix the build")).toBe("Fix the build");
  });

  it("keeps the original request but not every earlier session nested inside the next", () => {
    let prompt = continuationPrompt(buildTranscript([user("ORIGINAL: fix the build"), user("x".repeat(30_000))]), "limit");
    for (let hop = 0; hop < 4; hop += 1) {
      prompt = continuationPrompt(buildTranscript([user(prompt), user(`hop ${hop} ${"y".repeat(30_000)}`)]), "limit");
    }
    expect(prompt).toContain("ORIGINAL: fix the build");
    expect(prompt).toContain("hop 3");
    expect(prompt.length).toBeLessThan(45_000);
    // Only the last hand-off carries a long history; each earlier one is at most a short opening.
    const [, ...nested] = prompt.split("<previous-session>");
    expect(nested.slice(1).every((part) => part.split("</previous-session>")[0]!.length < 2_100)).toBe(true);
  });

  it("keeps its tags paired however deep the nesting and wherever the cut falls", () => {
    const count = (text: string, tag: string) => text.split(tag).length - 1;
    for (const filler of [10, 1_000, 1_990, 2_500]) {
      let prompt = continuationPrompt(buildTranscript([user("ORIGINAL")]), "limit");
      for (let hop = 0; hop < 5; hop += 1) {
        prompt = continuationPrompt(buildTranscript([user(`${"f".repeat(filler)}\n${prompt}`)]), "limit");
      }
      const shortened = shortenEarlierHandOff(prompt);
      expect(count(shortened, "<previous-session>")).toBe(count(shortened, "</previous-session>"));
      // Inside the outer block, nothing can close it early.
      const body = shortened.slice(shortened.indexOf("<previous-session>") + 18, shortened.lastIndexOf("</previous-session>"));
      expect(body).not.toMatch(/<\/?previous-session>/);
    }
  });

  it("copes with an earlier hand-off that was cut off before its end", () => {
    const shortened = shortenEarlierHandOff(`Carry on.\n<previous-session>\nUser: ORIGINAL\n${"z".repeat(10_000)}`);
    expect(shortened).toContain("User: ORIGINAL");
    expect(shortened).toContain("</previous-session>");
    expect(shortened.length).toBeLessThan(2_200);
  });
});

describe("switching a ChatGPT agent's account", () => {
  async function setUp(existing: string[] = []) {
    const store = new StateStore(join(root, "state.json"));
    const account = (id: string, label: string, kind: "main" | "managed") => ({
      id,
      family: "codex" as const,
      label,
      kind,
      home: kind === "main" ? null : join(tmpdir(), id),
      createdAt: "2026-09-23T00:00:00.000Z",
    });
    await store.update((draft) => {
      Object.assign(draft, {
        accounts: [account(CODEX_MAIN, "hello", "main"), account(SECOND, "second", "managed")],
        defaults: { claude: null, codex: CODEX_MAIN },
      });
      draft.bindings[AGENT] = { accountId: CODEX_MAIN, source: "thread", at: "2026-09-23T07:00:00.000Z" };
      existing.forEach((accountId, index) => {
        draft.bindings[`earlier-${index}`] = { accountId, source: "thread", at: "2026-09-23T07:01:00.000Z" };
      });
    });
    const source = {
      id: AGENT,
      provider: "codex",
      status: "idle",
      title: "Fix the build",
      model: "gpt-5.6-sol",
      workspaceId: "ws-1",
      archivedAt: null,
      lastUserMessageAt: "2026-09-23T07:00:00.000Z",
      labels: {},
    };
    const agents: Array<Record<string, unknown>> = [source];
    existing.forEach((_, index) => {
      agents.push({ id: `earlier-${index}`, provider: "codex", status: "idle", title: "Fix the build (continued)", archivedAt: null, labels: { "zerosub.continued-from": AGENT } });
    });
    const created: Array<{ agentId: string; title: string; labels: Record<string, string> }> = [];
    const paseo = {
      config: { get: async () => ({ config: { providers: {} } }) },
      providers: { listModels: async () => ({ models: [{ id: "gpt-5.6-sol", isDefault: true }] }) },
      workspaces: {
        ref: () => ({
          agents: {
            create: async (request: (typeof created)[number]) => {
              await new Promise((resolve) => setTimeout(resolve, 20));
              created.push(request);
              agents.push({ id: request.agentId, provider: "codex", status: "running", title: request.title, archivedAt: null, labels: request.labels });
            },
          },
        }),
      },
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
        ref: () => ({
          refresh: async () => ({ agent: source }),
          send: async () => undefined,
          timeline: { append: async () => undefined, refetch: async () => ({ entries: [] }) },
        }),
      },
    };
    const codex = {
      family: "codex",
      portable: false,
      usageSpacingMs: 0,
      available: async () => ({ ok: true, detail: null }),
      prepareHome: async () => undefined,
      env: async () => ({}),
      identity: async () => null,
      usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
      detectLimit: () => null,
      detectSignOut: () => null,
    } as unknown as FamilyAdapter;
    const service = new Service(
      { claude: { ...codex, family: "claude", portable: true } as FamilyAdapter, codex },
      store,
      { resolve: async () => ({ claude: "claude" as const, codex: "codex" as const }) } as unknown as FamilyResolver,
      { locate: async () => "/usr/local/bin/paseo", reopen: async () => ({ ok: true as const }) } as unknown as Reopener,
    );
    return { service, paseo: paseo as never, created };
  }

  it("starts one continuation even when switched twice at the same moment", async () => {
    const { service, paseo, created } = await setUp();
    const [first, second] = await Promise.all([service.setAgentAccount(paseo, AGENT, SECOND), service.setAgentAccount(paseo, AGENT, SECOND)]);
    expect(created).toHaveLength(1);
    expect(first.continuedIn?.agentId).toBe(created[0]?.agentId);
    expect(second.continuedIn?.agentId).toBe(created[0]?.agentId);
  });

  it("points at the earlier continuation when switched again to the same account", async () => {
    const { service, paseo, created } = await setUp();
    const first = await service.setAgentAccount(paseo, AGENT, SECOND);
    const again = await service.setAgentAccount(paseo, AGENT, SECOND);
    expect(created).toHaveLength(1);
    expect(again.continuedIn?.agentId).toBe(first.continuedIn?.agentId);
  });

  it("reuses a continuation started automatically instead of starting another", async () => {
    const { service, paseo, created } = await setUp([SECOND]);
    const result = await service.setAgentAccount(paseo, AGENT, SECOND);
    expect(created).toHaveLength(0);
    expect(result.continuedIn?.agentId).toBe("earlier-0");
  });

  it("reuses the continuation already on the account switched to, among several", async () => {
    const { service, paseo, created } = await setUp([CODEX_MAIN, SECOND]);
    const result = await service.setAgentAccount(paseo, AGENT, SECOND);
    expect(created).toHaveLength(0);
    expect(result.continuedIn?.agentId).toBe("earlier-1");
  });

  it("refuses to start a second copy on another account and names the first", async () => {
    const { service, paseo, created } = await setUp([SECOND]);
    await expect(service.setAgentAccount(paseo, AGENT, "nope")).rejects.toThrow();
    await expect(service.setAgentAccount(paseo, AGENT, CODEX_MAIN)).resolves.toBeDefined(); // already there: nothing to do
    await setUp([CODEX_MAIN]).then(async (other) => {
      await expect(other.service.setAgentAccount(other.paseo, AGENT, SECOND)).rejects.toThrow(/already continues in “Fix the build \(continued\)”/);
      expect(other.created).toHaveLength(0);
    });
    expect(created).toHaveLength(0);
  });
});
