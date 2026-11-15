import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter } from "./adapter";
import { ApiUsageStore } from "./api-usage";
import { absentPi } from "./fakes.test-support";
import type { FamilyResolver } from "./families";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore, findAccount } from "./state";
import { BEDROCK_THROTTLE_MS } from "./limits";
import { ClaudeAdapter } from "./claude";
import { writeFile } from "node:fs/promises";

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const KEY_ID = "AKIAIOSFODNN7EXAMPLE";

const checks: Array<{ region: string; source: string }> = [];
let checkResult: { ok: true; detail: string | null } | { ok: false; fatal: boolean; message: string } = { ok: true, detail: null };
vi.mock("./bedrock", async (original) => ({
  ...(await original<typeof import("./bedrock")>()),
  checkBedrock: async (account: { region: string; source: string }) => {
    checks.push({ region: account.region, source: account.source });
    return checkResult;
  },
  detectHostRegion: async () => "eu-central-1",
}));
const PROXY_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "CODEX_HOME", "PASEO_HOME", "CLAUDE_CONFIG_DIR"] as const;

let root: string;
const saved: Partial<Record<(typeof PROXY_KEYS)[number], string>> = {};
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-azure-service-"));
  for (const key of PROXY_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PASEO_HOME = join(root, "paseo");
  process.env.CODEX_HOME = join(root, "codex");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  await mkdir(process.env.CODEX_HOME, { recursive: true });
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), "{}");
  checks.length = 0;
  checkResult = { ok: true, detail: null };
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of PROXY_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});


function fakePaseo() {
  const agent = { id: "agent-1", provider: "claude", status: "idle", archivedAt: null, lastUserMessageAt: null, persistence: null, model: "gpt-5" };
  const notes: unknown[] = [];
  const paseo = {
    config: { get: async () => ({ config: { providers: {} } }) },
    providers: { listAvailable: async () => ({ providers: [] }) },
    agents: {
      list: async () => ({ entries: [{ agent }], pageInfo: { hasMore: false, nextCursor: null } }),
      ref: () => ({
        refresh: async () => ({ agent }),
        send: async () => undefined,
        timeline: { append: async (item: unknown) => void notes.push(item), refetch: async () => ({ entries: [] }) },
      }),
    },
  };
  return { paseo, notes };
}

function setUp() {
  const store = new StateStore(join(root, "paseo", "zerosub", "state.json"));
  const families = { resolve: async () => ({ claude: "claude" }) } as unknown as FamilyResolver;
  const reopener = { locate: async () => null, reopen: async () => ({ ok: true as const }) } as unknown as Reopener;
  const azureUsage = new ApiUsageStore(join(root, "paseo", "zerosub", "azure-usage.json"));
  const service = new Service({ claude: new ClaudeAdapter(), codex: { ...absentPi(), family: "codex" } as FamilyAdapter, pi: absentPi() }, store, families, reopener, azureUsage);
  services.push(service);
  return { service, store };
}

describe("AWS Bedrock accounts in the service", () => {
  const open = (service: Service, paseo: unknown) =>
    service.onSessionOpen(
      { agentId: "agent-1", provider: "claude", reason: "create", purpose: "interactive", env: {}, workspaceId: "w", cwd: root } as never,
      { paseo } as never,
    );

  it("keeps an access key's secret out of the registry, the app's view and the log, and hands it to the session", async () => {
    const logged: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
    const { service, store } = setUp();
    const { accountId, warning } = await service.addBedrockAccount({
      label: "Bedrock",
      region: "eu-central-1",
      source: "keys",
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      models: { opus: "global.anthropic.claude-opus-5-5" },
    });
    expect(warning).toBeNull();
    expect(checks).toEqual([{ region: "eu-central-1", source: "keys" }]);
    const account = findAccount(await store.read(), accountId)!;
    expect(account).toMatchObject({ family: "claude", auth: "api", plan: "AWS Bedrock" });
    expect(await readFile(join(root, "paseo", "zerosub", "state.json"), "utf8")).not.toContain(SECRET);
    expect(JSON.stringify(await store.read())).not.toContain(KEY_ID);

    const { paseo } = fakePaseo();
    const view = await service.view(paseo as never);
    expect(view.awsRegion).toBe("eu-central-1");
    const card = view.accounts.find((entry) => entry.id === accountId)!;
    expect(card.bedrock).toMatchObject({ region: "eu-central-1", source: "keys", keyHint: KEY_ID.slice(-4), models: { opus: "global.anthropic.claude-opus-5-5" } });
    expect(card.apiEditable).toBe(false);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify(view)).not.toContain(KEY_ID);

    await service.setAgentAccount(paseo as never, "agent-1", accountId).catch(() => undefined);
    const opened = await open(service, paseo);
    expect(opened?.env).toMatchObject({
      CLAUDE_CONFIG_DIR: account.home,
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: KEY_ID,
      AWS_SECRET_ACCESS_KEY: SECRET,
      ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-5-5",
    });
    const settings = await readFile(join(account.home!, "settings.json"), "utf8");
    expect(settings).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(settings).not.toContain(SECRET);

    // Moving it to the host's own credentials drops the stored key altogether.
    await service.updateBedrockAccount(accountId, { source: "host" });
    expect(await readFile(join(account.home!, "bedrock.json"), "utf8")).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("refuses credentials AWS refuses, and saves ones it couldn't check with a warning", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service, store } = setUp();
    checkResult = { ok: false, fatal: true, message: "AWS refused the credentials: InvalidClientTokenId" };
    await expect(service.addBedrockAccount({ label: "Bad", region: "eu-central-1", source: "host" })).rejects.toThrow(/refused/);
    expect((await store.read()).accounts).toHaveLength(0);
    checkResult = { ok: false, fatal: false, message: "The aws command isn't installed here, so the credentials weren't checked." };
    const { warning } = await service.addBedrockAccount({ label: "Host", region: "eu-central-1", source: "host" });
    expect(warning).toMatch(/aws command/);
    await expect(service.addBedrockAccount({ label: "Twice", region: "eu-central-1", source: "host" })).rejects.toThrow(/already added/);
    await expect(service.addBedrockAccount({ label: "Nameless", region: "eu-central-1", source: "profile" })).rejects.toThrow(/profile/);
  });

  it("cools down after throttling, and shows AWS's refusal on the card", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service, store } = setUp();
    const { accountId } = await service.addBedrockAccount({ label: "Bedrock", region: "eu-central-1", source: "host" });
    const { paseo } = fakePaseo();
    await service.setAgentAccount(paseo as never, "agent-1", accountId).catch(() => undefined);
    await open(service, paseo);
    const turn = (message: string) =>
      service.onTurnEnded(
        { agent: { id: "agent-1", provider: "claude" }, turnId: null, outcome: { kind: "failed", error: { message } }, timeline: [] } as never,
        { paseo } as never,
      );
    const before = Date.now();
    await turn("API Error: 429 Too many tokens, please wait before trying again.");
    let account = findAccount(await store.read(), accountId)!;
    expect(account.signedIn).toBe(true);
    expect(Date.parse(account.limitedUntil ?? "") - before).toBeGreaterThanOrEqual(BEDROCK_THROTTLE_MS - 1_000);
    await service.clearLimit(accountId);
    await turn("API Error: 403 AccessDeniedException: You don't have access to the model with the specified model ID.");
    account = findAccount(await store.read(), accountId)!;
    expect(account.signedIn).toBe(false);
    const card = (await service.view(paseo as never)).accounts.find((entry) => entry.id === accountId)!;
    expect(card.status).toBe("signed_out");
    expect(card.apiError).toMatch(/AccessDeniedException/);
    await service.updateBedrockAccount(accountId, { models: { model: "eu.anthropic.claude-sonnet-5-5" } });
    expect(findAccount(await store.read(), accountId)).toMatchObject({ signedIn: true, apiError: null });
  });
});
