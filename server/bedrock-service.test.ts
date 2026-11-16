import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FamilyAdapter } from "./adapter";
import { ApiUsageStore } from "./api-usage";
import type { BedrockCheck, BedrockHost } from "./bedrock";
import { ClaudeAdapter } from "./claude";
import { absentPi } from "./fakes.test-support";
import type { FamilyResolver } from "./families";
import { BEDROCK_THROTTLE_MS } from "./limits";
import type { Reopener } from "./reopen";
import { Service } from "./service";
import { StateStore, findAccount } from "./state";

// AWS's own documentation examples, not real credentials.
const KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const OPUS = "global.anthropic.claude-opus-example-v1:0";
const SESSION = "4b7c2a10-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
const ENV_KEYS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "PASEO_HOME", "CLAUDE_CONFIG_DIR", "AWS_REGION", "AWS_DEFAULT_REGION", "ZEROSUB_LAUNCHER_DIR"] as const;

let root: string;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};
const services: Service[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-bedrock-service-"));
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.PASEO_HOME = join(root, "paseo");
  process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
  process.env.ZEROSUB_LAUNCHER_DIR = join(root, "scripts");
  await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  await writeFile(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ apiKeyHelper: "~/bin/key", env: { ANTHROPIC_API_KEY: "sk-ant-main" } }));
});

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** The host's AWS setup as the tests want it: no metadata service, no aws command, nothing on the network. */
function fakeAws(check: BedrockCheck = { ok: true, detail: null }) {
  const aws = {
    result: check,
    checked: [] as Array<{ region: string; source: string }>,
    detectRegion: vi.fn(async () => ({ region: "eu-central-1", source: "config" as const })),
    check: vi.fn(async (account: { region: string; source: string }) => {
      aws.checked.push({ region: account.region, source: account.source });
      return aws.result;
    }),
  };
  return aws;
}

function fakePaseo(persistence: { sessionId: string } | null = null) {
  const agent = { id: "agent-1", provider: "claude", status: "idle", archivedAt: null, lastUserMessageAt: null, persistence, model: "opus" };
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

/**
 * The real Claude adapter for added accounts' homes, except that it never asks Anthropic's edge where
 * it's seen from, and takes Claude Code for installed with nobody signed in to the CLI login, so
 * nothing runs the host's own `claude`.
 */
function claudeAdapter(): ClaudeAdapter {
  const adapter = new ClaudeAdapter();
  const identity = adapter.identity.bind(adapter);
  adapter.egress = async () => null;
  adapter.available = async () => ({ ok: true, detail: null });
  adapter.identity = async (home) => (home ? identity(home) : { signedIn: false, email: null, plan: null, organization: null, identity: null });
  return adapter;
}

function setUp(aws: BedrockHost = fakeAws(), claude: FamilyAdapter = claudeAdapter()) {
  const store = new StateStore(join(root, "paseo", "zerosub", "state.json"));
  const families = { resolve: async () => ({ claude: "claude" }) } as unknown as FamilyResolver;
  const reopener = { locate: async () => null, reopen: async () => ({ ok: true as const }) } as unknown as Reopener;
  const apiUsage = new ApiUsageStore(join(root, "paseo", "zerosub", "api-usage.json"));
  const service = new Service({ claude, codex: { ...absentPi(), family: "codex" } as FamilyAdapter, pi: absentPi() }, store, families, reopener, apiUsage, aws);
  services.push(service);
  return { service, store, apiUsage };
}

const open = (service: Service, paseo: unknown) =>
  service.onSessionOpen({ agentId: "agent-1", provider: "claude", reason: "create", purpose: "interactive", env: {}, workspaceId: "w", cwd: root } as never, { paseo } as never);

const endTurn = (service: Service, paseo: unknown, message: string) =>
  service.onTurnEnded({ agent: { id: "agent-1", provider: "claude" }, turnId: null, outcome: { kind: "failed", error: { message } }, timeline: [] } as never, { paseo } as never);

describe("AWS Bedrock accounts in the service", () => {
  it("keeps an access key's secret out of the registry, the app's view, settings and the log, and hands it to the session", async () => {
    const logged: string[] = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(" ")));
    }
    const aws = fakeAws();
    const { service, store } = setUp(aws);
    const { accountId, warning } = await service.addBedrockAccount({
      label: "Bedrock",
      region: "eu-central-1",
      source: "keys",
      accessKeyId: KEY_ID,
      secretAccessKey: SECRET,
      models: { opus: OPUS },
    });
    expect(warning).toBeNull();
    expect(aws.checked).toEqual([{ region: "eu-central-1", source: "keys" }]);
    const account = findAccount(await store.read(), accountId)!;
    expect(account).toMatchObject({ family: "claude", auth: "api", provider: "bedrock", plan: "AWS Bedrock", kind: "managed" });
    const registry = await readFile(join(root, "paseo", "zerosub", "state.json"), "utf8");
    expect(registry).not.toContain(SECRET);
    expect(registry).not.toContain(KEY_ID);

    const { paseo } = fakePaseo();
    const view = await service.view(paseo as never);
    const card = view.accounts.find((entry) => entry.id === accountId)!;
    expect(card.bedrock).toMatchObject({ region: "eu-central-1", source: "keys", keyHint: KEY_ID.slice(-4), models: { opus: OPUS } });
    expect(card.api).toBeNull();
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
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_DEFAULT_OPUS_MODEL: OPUS,
    });
    const settings = await readFile(join(account.home!, "settings.json"), "utf8");
    expect(JSON.parse(settings).env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_API_KEY: "" });
    expect(settings).not.toContain(SECRET);
    expect(settings).not.toContain("apiKeyHelper");
    expect(settings).not.toContain("sk-ant-main");

    // An empty secret keeps the stored one for the same key ID; moving to the host's own credentials drops it.
    await service.updateBedrockAccount(accountId, { source: "keys", secretAccessKey: "" });
    expect(await readFile(join(account.home!, "bedrock.json"), "utf8")).toContain(SECRET);
    await service.updateBedrockAccount(accountId, { source: "host" });
    expect(await readFile(join(account.home!, "bedrock.json"), "utf8")).not.toContain(SECRET);
    expect(logged.join("\n")).not.toContain(SECRET);
  });

  it("refuses credentials AWS refuses, and saves ones it couldn't check with a warning", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const aws = fakeAws({ ok: false, fatal: true, message: "AWS refused the credentials: InvalidClientTokenId" });
    const { service, store } = setUp(aws);
    await expect(service.addBedrockAccount({ label: "Bad", region: "eu-central-1", source: "host" })).rejects.toThrow(/refused/);
    expect((await store.read()).accounts).toHaveLength(0);
    expect(Object.keys((await store.read()).cleanup)).toEqual([]);
    aws.result = { ok: false, fatal: false, message: "The aws command isn't installed here, so the credentials weren't checked." };
    const { warning } = await service.addBedrockAccount({ label: "Host", region: "eu-central-1", source: "host" });
    expect(warning).toMatch(/^Saved, but the aws command/);
    await expect(service.addBedrockAccount({ label: "Twice", region: "eu-central-1", source: "host" })).rejects.toThrow(/already added/);
    await expect(service.addBedrockAccount({ label: "Nameless", region: "eu-central-1", source: "profile" })).rejects.toThrow(/profile/);
    await expect(service.addBedrockAccount({ label: "Nowhere", region: "Frankfurt", source: "host" })).rejects.toThrow(/region/);
  });

  it("cools down after throttling, and shows AWS's refusal on the card until the settings change", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service, store } = setUp();
    const { accountId } = await service.addBedrockAccount({ label: "Bedrock", region: "eu-central-1", source: "host" });
    const { paseo } = fakePaseo();
    await service.setAgentAccount(paseo as never, "agent-1", accountId).catch(() => undefined);
    await open(service, paseo);
    const before = Date.now();
    await endTurn(service, paseo, "API Error: 429 Too many tokens, please wait before trying again.");
    let account = findAccount(await store.read(), accountId)!;
    expect(account.signedIn).toBe(true);
    expect(Date.parse(account.limitedUntil ?? "") - before).toBeGreaterThanOrEqual(BEDROCK_THROTTLE_MS - 1_000);
    expect(Date.parse(account.limitedUntil ?? "") - before).toBeLessThanOrEqual(BEDROCK_THROTTLE_MS + 5_000);
    await service.clearLimit(accountId);
    await endTurn(service, paseo, "API Error: 403 AccessDeniedException: You don't have access to the model with the specified model ID.");
    account = findAccount(await store.read(), accountId)!;
    expect(account.signedIn).toBe(false);
    const card = (await service.view(paseo as never)).accounts.find((entry) => entry.id === accountId)!;
    expect(card.status).toBe("signed_out");
    expect(card.apiError).toMatch(/AccessDeniedException/);
    await service.updateBedrockAccount(accountId, { models: { model: "eu.anthropic.claude-sonnet-example-v1:0" } });
    expect(findAccount(await store.read(), accountId)).toMatchObject({ signedIn: true, apiError: null });
  });

  /** A Bedrock account an agent runs on, with the host's AWS setup as `aws` says. */
  async function onBedrock(aws = fakeAws()) {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service, store } = setUp(aws);
    const { accountId } = await service.addBedrockAccount({ label: "Bedrock", region: "eu-central-1", source: "host" });
    const { paseo } = fakePaseo();
    await service.setAgentAccount(paseo as never, "agent-1", accountId).catch(() => undefined);
    await open(service, paseo);
    aws.check.mockClear();
    const account = async () => findAccount(await store.read(), accountId)!;
    return { service, paseo, aws, account };
  }

  it("leaves the account usable after a completed turn whose warnings or tool output carry another service's refusal", async () => {
    const t = await onBedrock();
    await t.service.onTurnEnded(
      {
        agent: { id: "agent-1", provider: "claude" },
        turnId: "t1",
        outcome: { kind: "completed" },
        timeline: [
          { type: "user_message", text: "List the buckets." },
          { type: "notification", level: "warning", message: "MCP client for github failed to start: HTTP 401 Unauthorized" },
          { type: "error", message: "An error occurred (AccessDeniedException) when calling the ListBuckets operation: Access Denied" },
          { type: "assistant_message", text: "The bucket listing was refused (AccessDenied), so I used the cached list." },
        ],
      } as never,
      { paseo: t.paseo } as never,
    );
    expect(await t.account()).toMatchObject({ signedIn: true, limitedUntil: null });
    // Nothing looked like Bedrock's own refusal, so the credentials weren't even checked.
    expect(t.aws.check).not.toHaveBeenCalled();
  });

  it("checks the credentials again before taking a failed turn's refusal for signed out", async () => {
    // AWS still takes them: the 403 was another service's, so the account stays usable.
    const t = await onBedrock();
    await endTurn(t.service, t.paseo, "API Error: 403 AccessDeniedException: User is not authorized to perform this operation");
    expect(t.aws.check).toHaveBeenCalledTimes(1);
    expect(await t.account()).toMatchObject({ signedIn: true });

    // The check can't get an answer (no aws command, the network): nothing is decided on the turn's word alone.
    t.aws.result = { ok: false, fatal: false, message: "The aws command isn't installed here, so the credentials weren't checked." };
    await endTurn(t.service, t.paseo, "API Error: 403 The security token included in the request is expired");
    expect(t.aws.check).toHaveBeenCalledTimes(2);
    expect(await t.account()).toMatchObject({ signedIn: true });

    // AWS refuses them too: now it's signed out, with AWS's answer on the card.
    t.aws.result = { ok: false, fatal: true, message: "AWS refused the credentials: ExpiredToken" };
    await endTurn(t.service, t.paseo, "API Error: 403 The security token included in the request is expired");
    expect(t.aws.check).toHaveBeenCalledTimes(3);
    expect(await t.account()).toMatchObject({ signedIn: false, apiError: "AWS refused the credentials: ExpiredToken" });
  });

  it("signs it out without a check when Bedrock names the model as one it won't run", async () => {
    const t = await onBedrock();
    await endTurn(t.service, t.paseo, "API Error (eu.anthropic.claude-example-v1:0): 400 The provided model identifier is invalid.");
    expect(t.aws.check).not.toHaveBeenCalled();
    expect(await t.account()).toMatchObject({ signedIn: false, apiError: expect.stringMatching(/model identifier is invalid/) });
  });

  it("counts a turn's tokens from the Claude Code session file into the month the card shows", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { service } = setUp();
    const { accountId } = await service.addBedrockAccount({ label: "Bedrock", region: "eu-central-1", source: "host" });
    await service.updateBedrockAccount(accountId, { prices: { [OPUS]: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 } } });
    const { paseo } = fakePaseo({ sessionId: SESSION });
    await service.setAgentAccount(paseo as never, "agent-1", accountId).catch(() => undefined);
    await open(service, paseo);
    const projects = join(root, "claude", "projects", "-work-app");
    await mkdir(projects, { recursive: true });
    await service.onTurnStarted({ id: "agent-1", provider: "claude" }, { paseo } as never);
    const usage = { input_tokens: 1_000, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 2_000, output_tokens: 500 };
    await writeFile(join(projects, `${SESSION}.jsonl`), `${JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { id: "msg_1", model: OPUS, usage } })}\n`);
    await service.onTurnEnded({ agent: { id: "agent-1", provider: "claude" }, turnId: null, outcome: { kind: "completed" }, timeline: [] } as never, { paseo } as never);
    await vi.waitFor(
      async () => {
        const card = (await service.view(paseo as never)).accounts.find((entry) => entry.id === accountId)!;
        expect(card.bedrock?.usage?.models[OPUS]).toEqual({ input: 13_000, cachedInput: 10_000, cacheWrite: 2_000, output: 500 });
      },
      { timeout: 5_000, interval: 100 },
    );
  });
});

describe("a Bedrock account's home (#69)", () => {
  it("stays in homes/ with no terminal script, is never imported as a subscription, and goes with its account", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const claude = claudeAdapter();
    // Nothing runs on any home, so every home that's due to move would.
    claude.homesInUse = async () => new Set<string>();
    const { service, store } = setUp(fakeAws(), claude);
    const { accountId } = await service.addBedrockAccount({ label: "Bedrock", region: "eu-central-1", source: "keys", accessKeyId: KEY_ID, secretAccessKey: SECRET });
    const home = findAccount(await store.read(), accountId)!.home!;
    expect(dirname(home)).toBe(join(root, "paseo", "zerosub", "homes"));
    await service.placeHomes();
    expect(findAccount(await store.read(), accountId)?.home).toBe(home);
    expect((await store.read()).moves).toEqual({});
    expect(await readFile(join(home, "bedrock.json"), "utf8")).toContain(SECRET);
    const scripts = await readdir(join(root, "scripts")).catch(() => [] as string[]);
    expect(scripts.filter((name) => name.startsWith("claude-"))).toEqual([]);

    // Removed, it waits in homes/ to be deleted, bedrock.json and all, and can't come back as a subscription account.
    const { paseo } = fakePaseo();
    await service.remove(paseo as never, accountId);
    expect(Object.keys((await store.read()).cleanup)).toEqual([home]);
    await writeFile(join(home, ".claude.json"), "{}");
    await expect(service.importAccount(home)).rejects.toThrow(/AWS Bedrock account's folder/);
    expect((await store.read()).accounts.some((account) => account.home === home)).toBe(false);
    expect(Object.keys((await store.read()).cleanup)).toEqual([home]);
  });
});

describe("the host's AWS region", () => {
  /** A Claude adapter that touches nothing on the host. */
  function quietClaude(): FamilyAdapter {
    return {
      family: "claude",
      portable: true,
      usageSpacingMs: 0,
      available: async () => ({ ok: true, detail: null }),
      prepareHome: async () => undefined,
      env: async () => ({}),
      identity: async () => ({ signedIn: false, email: null, plan: null, organization: null, identity: null }),
      usage: async () => ({ fetchedAt: new Date().toISOString(), windows: [], error: null, cached: false, resets: null }),
      redeemReset: async () => ({ outcome: "none", message: "none", left: 0 }),
      login: async () => {
        throw new Error("not in tests");
      },
      logout: async () => undefined,
      detectLimit: () => null,
      detectSignOut: () => null,
    } as unknown as FamilyAdapter;
  }

  it("is never looked up at startup, by upkeep or for the state view, only when the Bedrock form asks", async () => {
    const aws = fakeAws();
    const { service } = setUp(aws, quietClaude());
    const { paseo } = fakePaseo();
    service.attach(paseo as never);
    await service.start();
    const view = await service.view(paseo as never, true);
    expect(view).not.toHaveProperty("awsRegion");
    await service.view(paseo as never);
    expect(aws.detectRegion).not.toHaveBeenCalled();

    expect(await service.detectBedrockRegion()).toEqual({ region: "eu-central-1", source: "config" });
    expect(aws.detectRegion).toHaveBeenCalledTimes(1);
  });

  it("answers no region rather than an error when the lookup fails", async () => {
    const aws = fakeAws();
    aws.detectRegion.mockRejectedValueOnce(new Error("metadata service unreachable"));
    const { service } = setUp(aws, quietClaude());
    expect(await service.detectBedrockRegion()).toEqual({ region: null, source: null });
  });
});

describe("Bedrock and API-key Claude accounts (#65) stay apart", () => {
  it("never takes an API-key account for Bedrock, nor the other way round", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const aws = fakeAws();
    const { service, store } = setUp(aws);
    const keyed = await service.addApiAccount({ family: "claude", label: "Key", keyKind: "api_key", key: "sk-ant-api03-example-key-0123456789" });
    const { accountId: bedrock } = await service.addBedrockAccount({ label: "Bedrock", region: "eu-central-1", source: "host" });
    const state = await store.read();
    expect(findAccount(state, keyed)).toMatchObject({ family: "claude", auth: "api" });
    expect(findAccount(state, keyed)?.provider).toBeUndefined();
    expect(findAccount(state, bedrock)?.provider).toBe("bedrock");

    const { paseo } = fakePaseo();
    const cards = (await service.view(paseo as never)).accounts;
    const keyCard = cards.find((entry) => entry.id === keyed)!;
    const bedrockCard = cards.find((entry) => entry.id === bedrock)!;
    expect(keyCard).toMatchObject({ bedrock: null, apiEditable: true, api: { keyKind: "api_key" } });
    expect(bedrockCard).toMatchObject({ apiEditable: false, api: null, bedrock: { region: "eu-central-1", source: "host" } });

    // Each keeps its own form.
    await service.updateApiAccount(keyed, { keyKind: "api_key", baseUrl: "", disableTelemetry: true });
    expect((await service.view(paseo as never)).accounts.find((entry) => entry.id === keyed)?.api?.disableTelemetry).toBe(true);
    await expect(service.updateBedrockAccount(keyed, { region: "us-east-1" })).rejects.toThrow(/isn't an AWS Bedrock account/);
    await expect(service.updateApiAccount(bedrock, { keyKind: "api_key", key: "sk-ant-api03-other-key-0123456789" })).rejects.toThrow(/AWS Bedrock account/);
    await expect(service.startLogin("claude", "browser", bedrock)).rejects.toThrow(/AWS credentials/);

    // An API-key account's session is the #65 one: its key from settings, no Bedrock.
    await service.setAgentAccount(paseo as never, "agent-1", keyed).catch(() => undefined);
    const opened = await open(service, paseo);
    expect(opened?.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    const settings = JSON.parse(await readFile(join(findAccount(state, keyed)!.home!, "settings.json"), "utf8"));
    expect(settings.env).toMatchObject({ ANTHROPIC_API_KEY: "sk-ant-api03-example-key-0123456789", CLAUDE_CODE_USE_BEDROCK: "" });
    expect(aws.checked).toHaveLength(1);
  });
});
