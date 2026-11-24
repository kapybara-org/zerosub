import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginBeforeRequests, PluginHookContext } from "@getpaseo/plugin/server";
import { setCodexFastUntil } from "../shared/rpc";
import type { Usage } from "../shared/model";
import type { FamilyAdapter } from "./adapter";
import { CODEX_FAST_METADATA_KEY, type CodexSpeedState } from "./codex-fast";
import { WEEK_MINUTES } from "./codex";
import { Service } from "./service";
import { MAIN_ACCOUNT_ID, StateStore, StoredAccountSchema } from "./state";

const MAIN = MAIN_ACCOUNT_ID.codex;
const OTHER = "codex-other";
const UNTIL = "2026-11-24";
const CUTOFF = Date.parse("2026-11-25T00:00:00Z");
const FAST_CONTROLS = [{
  type: "select",
  key: "service_tier",
  choices: [{ value: "default", label: "Normal" }, { value: "priority", label: "Fast" }],
}];

let root: string;
let previousHome: string | undefined;
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-codex-fast-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = root;
  vi.spyOn(Date, "now").mockReturnValue(CUTOFF - 90_000);
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function live(id: string, speed: CodexSpeedState = {}) {
  return {
    id,
    provider: "codex",
    status: "running",
    updatedAt: new Date().toISOString(),
    controls: FAST_CONTROLS as CodexSpeedState["controls"],
    options: {} as Record<string, unknown>,
    metadata: {} as Record<string, unknown>,
    ...speed,
  };
}

async function setUp(agents: ReturnType<typeof live>[] = []) {
  const account = (id: string, kind: "main" | "managed") => StoredAccountSchema.parse({
    id,
    family: "codex",
    kind,
    label: id,
    home: kind === "main" ? null : join(root, id),
    createdAt: new Date().toISOString(),
    ...(kind === "main" ? { codexFastUntil: UNTIL } : {}),
  });
  const store = new StateStore(join(root, "state.json"));
  await store.update((draft) => {
    draft.accounts = [account(MAIN, "main"), account(OTHER, "managed")];
    draft.sessions.other = { accountId: OTHER, family: "codex", openedAt: new Date().toISOString() };
  });

  const listControls = vi.fn(async (_draft: unknown) => ({ controls: FAST_CONTROLS } as CodexSpeedState));
  const setOptions = vi.fn(async (id: string, patch: Record<string, unknown>) => {
    const agent = agents.find((entry) => entry.id === id);
    if (agent) agent.options = { ...agent.options, ...patch, service_tier: patch.service_tier === "fast" ? "priority" : patch.service_tier };
  });
  const setMetadata = vi.fn(async (id: string, patch: Record<string, true | null>) => {
    const agent = agents.find((entry) => entry.id === id);
    if (agent) agent.metadata = { ...agent.metadata, ...patch };
  });
  const context = {
    paseo: {
      config: { get: async () => ({ config: {} }) },
      providers: { listControls },
      agents: {
        list: async () => ({ entries: agents.map((agent) => ({ agent })), pageInfo: { hasMore: false, nextCursor: null } }),
        ref: (id: string) => ({
          refresh: async () => ({ agent: agents.find((entry) => entry.id === id) }),
          setOptions: (patch: Record<string, unknown>) => setOptions(id, patch),
          setMetadata: (patch: Record<string, true | null>) => setMetadata(id, patch),
        }),
      },
    },
  } as unknown as PluginHookContext;
  const usage: Usage = {
    fetchedAt: new Date(Date.now()).toISOString(), error: null, cached: false, resets: null, credits: null,
    windows: [{ id: "secondary", label: "Weekly", minutes: WEEK_MINUTES, usedPercent: 20, resetsAt: new Date(CUTOFF + 60_000).toISOString() }],
  };
  const codex = { family: "codex", usage: async () => usage, usageSpacingMs: 0 } as unknown as FamilyAdapter;
  const service = new Service({ claude: codex, codex }, store);
  services.push(service);
  await service.refreshUsage(MAIN);
  await service.refreshUsage(OTHER);
  const request: PluginBeforeRequests["agent.create"] = {
    config: { provider: "codex", cwd: "/repo", model: "codex-test-model", featureValues: { plan_mode: true } },
  };
  return { service, context, request, store, listControls, setOptions, setMetadata, usage };
}

describe("temporary Fast mode for one ChatGPT account", () => {
  it("sets Fast on an eligible create through the end of the UTC date", async () => {
    const { service, context, request, listControls } = await setUp();
    vi.mocked(Date.now).mockReturnValue(CUTOFF - 1);
    await expect(service.onAgentCreate(request, context)).resolves.toMatchObject({
      config: { providerOptions: { service_tier: "fast", plan_mode: true } },
      metadata: { [CODEX_FAST_METADATA_KEY]: true },
    });
    expect(listControls).toHaveBeenCalledWith({ provider: "codex/codex-test-model", cwd: "/repo", providerOptions: { plan_mode: true } });
    vi.mocked(Date.now).mockReturnValue(CUTOFF);
    await expect(service.onAgentCreate(request, context)).resolves.toBeUndefined();
    expect(listControls).toHaveBeenCalledOnce();
  });

  it("leaves models without a Fast choice alone at creation and while open", async () => {
    const { service, context, request, listControls, setOptions, setMetadata } = await setUp([
      live("unsupported", { controls: [] }), live("supported"),
    ]);
    listControls.mockResolvedValue({ controls: [{ type: "select", key: "service_tier", choices: [{ value: "flex", label: "Flex" }] }] });
    await expect(service.onAgentCreate(request, context)).resolves.toBeUndefined();
    await service.setCodexFastUntil(context.paseo, MAIN, UNTIL);
    await vi.waitFor(() => expect(setOptions).toHaveBeenCalledExactlyOnceWith("supported", { service_tier: "fast" }));
    expect(setMetadata).toHaveBeenCalledExactlyOnceWith("supported", { [CODEX_FAST_METADATA_KEY]: true });
  });

  it("updates a running agent on the opted-in account and rolls back only its Fast choice", async () => {
    const agents = [live("running"), live("other"), live("manual", { options: { service_tier: "priority" } })];
    const { service, context, setOptions, setMetadata } = await setUp(agents);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await service.setCodexFastUntil(context.paseo, MAIN, UNTIL);
    await vi.waitFor(() => expect(setOptions).toHaveBeenCalledExactlyOnceWith("running", { service_tier: "fast" }));
    expect(setMetadata).toHaveBeenCalledExactlyOnceWith("running", { [CODEX_FAST_METADATA_KEY]: true });
    vi.mocked(Date.now).mockReturnValue(CUTOFF);
    await vi.advanceTimersByTimeAsync(90_000);
    await vi.waitFor(() => expect(setMetadata).toHaveBeenLastCalledWith("running", { [CODEX_FAST_METADATA_KEY]: null }));
    expect(setOptions.mock.calls).toEqual([
      ["running", { service_tier: "fast" }],
      ["running", { service_tier: "default" }],
    ]);
  });

  it("applies the weekly guard and waits for a fresh window after its reset", async () => {
    const { service, context, store, request, usage, setOptions } = await setUp([
      live("managed", { options: { service_tier: "priority" }, metadata: { [CODEX_FAST_METADATA_KEY]: true } }),
    ]);
    usage.windows[0]!.usedPercent = 90;
    vi.mocked(Date.now).mockReturnValue(CUTOFF - 40_000);
    await store.update((draft) => { draft.accounts[0]!.codexFastUntil = "2026-11-25"; });
    await service.refreshUsage(MAIN, true);
    await expect(service.onAgentCreate(request, context)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(setOptions).toHaveBeenCalledExactlyOnceWith("managed", { service_tier: "default" }));
    usage.windows[0]!.usedPercent = 20;
    vi.mocked(Date.now).mockReturnValue(CUTOFF + 60_000);
    await service.refreshUsage(MAIN, true);
    await expect(service.onAgentCreate(request, context)).resolves.toBeUndefined();
    usage.windows[0]!.resetsAt = "2026-12-02T00:01:00Z";
    vi.mocked(Date.now).mockReturnValue(CUTOFF + 61_000);
    await service.refreshUsage(MAIN, true);
    await expect(service.onAgentCreate(request, context)).resolves.toMatchObject({
      config: { providerOptions: { service_tier: "fast" } },
    });
  });

  it("validates the date and clears only the specified account", async () => {
    const { service, context, store } = await setUp();
    expect(setCodexFastUntil.input.safeParse({ accountId: MAIN, until: "2026-02-30" }).success).toBe(false);
    await service.setCodexFastUntil(context.paseo, OTHER, "2026-11-30");
    await service.setCodexFastUntil(context.paseo, MAIN, "");
    const state = await store.read();
    expect(state.accounts.map((account) => account.codexFastUntil)).toEqual([undefined, "2026-11-30"]);
  });
});
