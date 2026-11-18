import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { estimateApiCost, isBedrockAccount, type Usage } from "../shared/model";
import type { TurnEvent } from "./adapter";
import { ApiUsageStore } from "./api-usage";
import {
  bedrockEnv,
  bedrockIdentity,
  bedrockSettings,
  bedrockSummary,
  checkBedrock,
  checkEnv,
  detectHostRegion,
  findClaudeSession,
  isBedrockHome,
  normalizeRegion,
  parseClaudeSession,
  readBedrockAccount,
  writeBedrockAccount,
  type BedrockAccount,
} from "./bedrock";
import { ClaudeAdapter } from "./claude";
import { accountSettings, prepareClaudeHome, writeAccountProxy } from "./homes";
import { BEDROCK_QUOTA_MS, BEDROCK_THROTTLE_MS, detectBedrockAutoModeRefusal, detectBedrockLimit, detectBedrockModelUnavailable, detectBedrockRefusal } from "./limits";
import type { RunResult } from "./process";
import { canStandIn, isLastResort, mostAvailable } from "./routing";
import { emptyState, StoredAccountSchema, type StoredAccount } from "./state";

// AWS's own documentation examples, not real credentials.
const KEY_ID = "AKIAIOSFODNN7EXAMPLE";
const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const TOKEN = "IQoJb3JpZ2luX2VjEXAMPLESESSIONTOKEN";
const OPUS = "global.anthropic.claude-opus-example-v1:0";
const MODELS = { model: "", opus: OPUS, sonnet: "", haiku: "" };

function account(patch: Partial<BedrockAccount> = {}): BedrockAccount {
  return { region: "eu-central-1", source: "host", profile: null, accessKeyId: null, secretAccessKey: null, sessionToken: null, models: MODELS, prices: {}, ...patch };
}
const keys = account({ source: "keys", accessKeyId: KEY_ID, secretAccessKey: SECRET, sessionToken: TOKEN });

describe("bedrockEnv", () => {
  it("runs Claude Code on Bedrock in the region, with the host's own AWS setup untouched", () => {
    const env = bedrockEnv(account());
    expect(env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "eu-central-1",
      AWS_DEFAULT_REGION: "eu-central-1",
      ANTHROPIC_API_KEY: "",
      ANTHROPIC_AUTH_TOKEN: "",
      CLAUDE_CODE_OAUTH_TOKEN: "",
      ANTHROPIC_BASE_URL: "",
      CLAUDE_CODE_USE_VERTEX: "",
      CLAUDE_CODE_USE_FOUNDRY: "",
    });
    for (const key of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]) expect(env).not.toHaveProperty(key);
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe(OPUS);
    // No override: Claude Code's own Bedrock default, not a first-party model the daemon names.
    expect(env.ANTHROPIC_MODEL).toBe("");
  });

  it("names the profile, and blanks environment keys that would outrank it", () => {
    expect(bedrockEnv(account({ source: "profile", profile: "bedrock" }))).toMatchObject({
      AWS_PROFILE: "bedrock",
      AWS_ACCESS_KEY_ID: "",
      AWS_SECRET_ACCESS_KEY: "",
      AWS_SESSION_TOKEN: "",
      AWS_BEARER_TOKEN_BEDROCK: "",
    });
  });

  it("hands an access key over in the environment only, and the aws check gets the same", () => {
    expect(bedrockEnv(keys)).toMatchObject({ AWS_ACCESS_KEY_ID: KEY_ID, AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: TOKEN, AWS_PROFILE: "" });
    const check = checkEnv(account({ source: "profile", profile: "p" }), { AWS_ACCESS_KEY_ID: "daemon", PATH: "/bin" });
    expect(check.AWS_PROFILE).toBe("p");
    expect(check).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(check.PATH).toBe("/bin");
  });
});

describe("bedrockSettings", () => {
  const main = {
    apiKeyHelper: "~/bin/key",
    awsAuthRefresh: "aws sso login",
    model: "opus",
    env: {
      ANTHROPIC_API_KEY: "sk-ant-main",
      CLAUDE_CODE_USE_VERTEX: "1",
      AWS_ACCESS_KEY_ID: "AKIAMAINEXAMPLE0000",
      AWS_PROFILE: "main",
      ANTHROPIC_MODEL: "claude-first-party-model",
      OTHER: "kept",
    },
  };

  it("turns Bedrock on over main's settings and keeps no other provider or login", () => {
    const settings = bedrockSettings(accountSettings(main, {}), keys);
    expect(settings).not.toHaveProperty("apiKeyHelper");
    expect(settings).not.toHaveProperty("awsAuthRefresh");
    expect(settings.model).toBe("opus");
    const env = settings.env as Record<string, string>;
    expect(env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1", ANTHROPIC_DEFAULT_OPUS_MODEL: OPUS, OTHER: "kept" });
    expect(env).toMatchObject({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_USE_VERTEX: "", AWS_PROFILE: "" });
    // Left out rather than blanked: a blank in settings would beat the key the session is started with.
    expect(env).not.toHaveProperty("AWS_ACCESS_KEY_ID");
    expect(env).not.toHaveProperty("ANTHROPIC_MODEL");
    expect(JSON.stringify(settings)).not.toContain(SECRET);
    expect(JSON.stringify(settings)).not.toContain(KEY_ID);
  });

  it("keeps the host's own AWS setup for the host source, and sets a profile's name", () => {
    const host = bedrockSettings(main, account());
    expect(host.env).toMatchObject({ AWS_ACCESS_KEY_ID: "AKIAMAINEXAMPLE0000", AWS_PROFILE: "main" });
    expect(host.awsAuthRefresh).toBe("aws sso login");
    const profile = bedrockSettings(main, account({ source: "profile", profile: "bedrock" }));
    expect(profile.env).toMatchObject({ AWS_PROFILE: "bedrock", AWS_ACCESS_KEY_ID: "", AWS_BEARER_TOKEN_BEDROCK: "" });
  });

  it("keeps the account's own proxy and its pinned no-proxy list (#64)", () => {
    const generated = accountSettings(main, { env: { HTTPS_PROXY: "http://127.0.0.1:7890" } });
    const env = bedrockSettings(generated, account()).env as Record<string, string>;
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.NO_PROXY).toBeTruthy();
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
  });
});

describe("Bedrock account files", () => {
  let root: string;
  const saved = process.env.CLAUDE_CONFIG_DIR;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zerosub-bedrock-"));
    process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
    await mkdir(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
    await writeFile(join(process.env.CLAUDE_CONFIG_DIR, "settings.json"), JSON.stringify({ apiKeyHelper: "x", env: { ANTHROPIC_API_KEY: "sk-ant-main" } }));
  });
  afterEach(async () => {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  it("keeps secrets in bedrock.json only (mode 600), never in settings.json or the summary", async () => {
    const home = join(root, "home");
    await writeBedrockAccount(home, keys);
    expect((await stat(join(home, "bedrock.json"))).mode & 0o777).toBe(0o600);
    expect(await readBedrockAccount(home)).toEqual(keys);
    await prepareClaudeHome(home, true);
    const settings = await readFile(join(home, "settings.json"), "utf8");
    expect(JSON.parse(settings).env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1" });
    for (const file of ["settings.json", ".settings.generated.json", "settings.account.json"]) {
      const content = await readFile(join(home, file), "utf8");
      expect(content).not.toContain(SECRET);
      expect(content).not.toContain(TOKEN);
      expect(content).not.toContain("apiKeyHelper");
      expect(content).not.toContain("sk-ant-main");
    }
    const summary = JSON.stringify(bedrockSummary(keys, null));
    expect(summary).not.toContain(SECRET);
    expect(summary).not.toContain(TOKEN);
    expect(summary).not.toContain(KEY_ID);
    expect(bedrockSummary(keys, null)).toMatchObject({ keyHint: KEY_ID.slice(-4), sessionToken: true });
    expect(bedrockIdentity(keys)).not.toContain(KEY_ID);

    const adapter = new ClaudeAdapter();
    expect(await adapter.env(home)).toMatchObject({ CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_USE_BEDROCK: "1", AWS_SECRET_ACCESS_KEY: SECRET });
    expect(await adapter.identity(home)).toMatchObject({ signedIn: true, plan: "AWS Bedrock", identity: bedrockIdentity(keys) });
    expect(await adapter.egress(home)).toBeNull();
    expect((await adapter.usage(home)).windows).toEqual([]);
    await expect(adapter.login(home, "browser")).rejects.toThrow(/AWS credentials/);
  });

  it("drops a key it no longer uses, and keeps only what the source needs", async () => {
    const home = join(root, "home");
    await writeBedrockAccount(home, keys);
    await writeBedrockAccount(home, account({ source: "profile", profile: "bedrock", accessKeyId: KEY_ID, secretAccessKey: SECRET }));
    const file = await readFile(join(home, "bedrock.json"), "utf8");
    expect(file).not.toContain(SECRET);
    expect(file).not.toContain(KEY_ID);
    expect(await readBedrockAccount(home)).toMatchObject({ source: "profile", profile: "bedrock", accessKeyId: null });
  });

  it("is private to every Claude home: never linked in from ~/.claude, and only a Bedrock home has one", async () => {
    // Even if the main directory had one, an added account's home doesn't get it.
    await writeFile(join(process.env.CLAUDE_CONFIG_DIR!, "bedrock.json"), JSON.stringify({ region: "us-east-1", source: "host" }));
    const plain = join(root, "plain");
    await mkdir(plain, { recursive: true });
    await prepareClaudeHome(plain, true);
    expect(await lstat(join(plain, "bedrock.json")).catch(() => null)).toBeNull();
    expect(isBedrockHome(plain)).toBe(false);
    expect((await new ClaudeAdapter().env(plain)).CLAUDE_CODE_USE_BEDROCK).toBeUndefined();

    // A Bedrock home's own file stays a file of its own, and a proxy set for it (#64) leaves Bedrock on.
    const home = join(root, "home");
    await writeBedrockAccount(home, account());
    await prepareClaudeHome(home, true);
    expect((await lstat(join(home, "bedrock.json"))).isSymbolicLink()).toBe(false);
    await writeAccountProxy(home, "http://127.0.0.1:7890");
    const env = JSON.parse(await readFile(join(home, "settings.json"), "utf8")).env as Record<string, string>;
    expect(env).toMatchObject({ HTTPS_PROXY: "http://127.0.0.1:7890", CLAUDE_CODE_USE_BEDROCK: "1" });
  });

  it("finds a Claude Code session and counts each message once, from the turn's start", async () => {
    const projects = join(root, "claude", "projects");
    const session = "4b7c2a10-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
    await mkdir(join(projects, "-home-me-app"), { recursive: true });
    const line = (id: string, at: string, usage: Record<string, number>) => JSON.stringify({ type: "assistant", timestamp: at, message: { id, model: OPUS, usage } });
    const lines = [
      line("msg_old", "2026-11-15T09:00:00Z", { input_tokens: 999, output_tokens: 999 }),
      line("msg_1", "2026-11-15T10:00:01Z", { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 5 }),
      line("msg_1", "2026-11-15T10:00:02Z", { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 }),
      line("msg_2", "2026-11-15T10:00:05Z", { input_tokens: 3, output_tokens: 7 }),
      JSON.stringify({ type: "user", timestamp: "2026-11-15T10:00:03Z", message: { content: "hi" } }),
    ];
    await writeFile(join(projects, "-home-me-app", `${session}.jsonl`), lines.join("\n"));
    const path = await findClaudeSession(session, projects);
    expect(path).not.toBeNull();
    const messages = parseClaudeSession(await readFile(path!, "utf8"), Date.parse("2026-11-15T10:00:00Z"));
    expect(messages).toEqual([
      { id: "msg_1", model: OPUS, count: { input: 1210, cachedInput: 1000, cacheWrite: 200, output: 50 } },
      { id: "msg_2", model: OPUS, count: { input: 3, cachedInput: 0, cacheWrite: 0, output: 7 } },
    ]);
    const store = new ApiUsageStore(join(root, "api-usage.json"));
    const now = Date.parse("2026-11-15T10:01:00Z");
    expect(await store.countMessages("claude-b", session, messages, now)).toBe(2);
    expect(await store.countMessages("claude-b", session, messages, now)).toBe(0);
    const month = (await store.read()).accounts["claude-b"]!;
    expect(month.models[OPUS]).toEqual({ input: 1213, cachedInput: 1000, cacheWrite: 200, output: 57 });
    // Cache reads and writes priced on their own; a write without a price counts at the input price.
    expect(estimateApiCost(month, { [OPUS]: { input: 10, cachedInput: 1, cacheWrite: 20, output: 50 } }).usd).toBeCloseTo((13 * 10 + 1000 * 1 + 200 * 20 + 57 * 50) / 1e6);
    expect(estimateApiCost(month, { [OPUS]: { input: 10, cachedInput: 1, cacheWrite: null, output: 50 } }).usd).toBeCloseTo((13 * 10 + 1000 * 1 + 200 * 10 + 57 * 50) / 1e6);
    // Older files have no message marks; they read as none.
    await writeFile(join(root, "old.json"), JSON.stringify({ accounts: {}, threads: {} }));
    expect((await new ApiUsageStore(join(root, "old.json")).read()).messages).toEqual({});
  });
});

describe("checkBedrock", () => {
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
  const fail = (stderr: string, code: number | null = 255): RunResult => ({ code, stdout: "", stderr, timedOut: false });

  it("passes when STS and Bedrock answer", async () => {
    const calls: string[][] = [];
    const result = await checkBedrock(keys, async (args) => {
      calls.push([...args]);
      return args[0] === "sts" ? ok('{"Arn":"arn:aws:sts::111122223333:assumed-role/example/session"}') : ok("{}");
    });
    expect(result).toEqual({ ok: true, detail: "arn:aws:sts::111122223333:assumed-role/example/session" });
    expect(calls.map((args) => args.slice(0, 2))).toEqual([["sts", "get-caller-identity"], ["bedrock", "list-inference-profiles"]]);
    expect(calls.every((args) => args.includes("eu-central-1"))).toBe(true);
  });

  it("fails on refused or missing credentials, without the secret in the message", async () => {
    const refused = await checkBedrock(keys, async () => fail(`An error occurred (SignatureDoesNotMatch) when calling GetCallerIdentity: bad signature for ${SECRET}`));
    expect(refused).toMatchObject({ ok: false, fatal: true });
    expect(JSON.stringify(refused)).not.toContain(SECRET);
    expect(await checkBedrock(account(), async () => fail('Unable to locate credentials. You can configure credentials by running "aws configure".'))).toMatchObject({ fatal: true });
    expect(await checkBedrock(account({ source: "profile", profile: "nope" }), async () => fail("The config profile (nope) could not be found"))).toMatchObject({ fatal: true });
  });

  it("only warns without the aws command, offline, or when profiles can't be listed", async () => {
    expect(await checkBedrock(account(), async () => fail("spawn aws ENOENT", null))).toMatchObject({ ok: false, fatal: false });
    expect(await checkBedrock(account(), async () => fail('Could not connect to the endpoint URL: "https://sts.eu-central-1.amazonaws.com/"'))).toMatchObject({ fatal: false });
    expect(await checkBedrock(account(), async () => ({ ...fail(""), timedOut: true }))).toMatchObject({ fatal: false });
    const listing = await checkBedrock(account(), async (args) => (args[0] === "sts" ? ok("{}") : fail("An error occurred (AccessDeniedException) when calling ListInferenceProfiles")));
    expect(listing).toMatchObject({ ok: false, fatal: false });
  });
});

describe("detectHostRegion", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "zerosub-region-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });
  const noInstance = vi.fn(async () => null);

  it("takes the daemon's AWS_REGION first, then AWS_DEFAULT_REGION, without asking the instance", async () => {
    const instance = vi.fn(async () => "ap-south-1");
    expect(await detectHostRegion({ env: { AWS_REGION: "EU-West-1", AWS_DEFAULT_REGION: "us-east-2" }, instance })).toEqual({ region: "eu-west-1", source: "environment" });
    expect(await detectHostRegion({ env: { AWS_DEFAULT_REGION: "us-east-2" }, instance })).toEqual({ region: "us-east-2", source: "environment" });
    expect(instance).not.toHaveBeenCalled();
  });

  it("reads the region of the daemon's profile from the AWS config file", async () => {
    const config = join(root, "config");
    await writeFile(config, ["[default]", "region = us-west-2", "", "[profile work]", "output = json", "region = eu-north-1"].join("\n"));
    expect(await detectHostRegion({ env: { AWS_CONFIG_FILE: config }, instance: noInstance })).toEqual({ region: "us-west-2", source: "config" });
    expect(await detectHostRegion({ env: { AWS_CONFIG_FILE: config, AWS_PROFILE: "work" }, instance: noInstance })).toEqual({ region: "eu-north-1", source: "config" });
    expect(noInstance).not.toHaveBeenCalled();
  });

  it("asks the EC2 metadata service last, and gives up quickly when it doesn't answer", async () => {
    const env = { AWS_CONFIG_FILE: join(root, "missing") };
    expect(await detectHostRegion({ env, instance: async () => "ca-central-1" })).toEqual({ region: "ca-central-1", source: "instance" });
    const started = Date.now();
    const never = () => new Promise<string | null>(() => undefined);
    expect(await detectHostRegion({ env, instance: never, timeoutMs: 50 })).toEqual({ region: null, source: null });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(await detectHostRegion({ env, instance: async () => null })).toEqual({ region: null, source: null });
  });
});

describe("Bedrock errors", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const turn = (text: string, failed = false): TurnEvent => ({
    outcome: failed ? { kind: "failed", error: { message: text } } : { kind: "completed" },
    timeline: [{ type: "assistant_message", text }] as never,
    turnId: "t1",
  });

  it("takes throttling for a minute's cooldown and an exceeded service quota for five", () => {
    expect(detectBedrockLimit(turn("API Error: 429 Too many tokens, please wait before trying again.", true), now)).toMatchObject({
      kind: "window",
      resetsAt: new Date(now.getTime() + BEDROCK_THROTTLE_MS).toISOString(),
    });
    expect(detectBedrockLimit(turn("ThrottlingException: Rate exceeded", true), now)?.kind).toBe("window");
    expect(detectBedrockLimit(turn("API Error: ServiceQuotaExceededException: Too many tokens per day", true), now)).toMatchObject({
      kind: "budget",
      resetsAt: new Date(now.getTime() + BEDROCK_QUOTA_MS).toISOString(),
    });
    expect(BEDROCK_THROTTLE_MS).toBe(60_000);
    expect(BEDROCK_QUOTA_MS).toBe(5 * 60_000);
  });

  it("tells a model Bedrock won't run, which needs no credential check, from refused credentials or access, which does", () => {
    expect(detectBedrockRefusal(turn("API Error: 403 AccessDeniedException: You don't have access to the model with the specified model ID.", true))).toEqual({
      message: "403 AccessDeniedException: You don't have access to the model with the specified model ID.",
      model: true,
    });
    expect(detectBedrockRefusal(turn(`API Error (${OPUS}): 400 The provided model identifier is invalid.`, true))).toMatchObject({ model: true });
    expect(detectBedrockRefusal(turn("API Error: 403 The security token included in the request is invalid.", true))).toMatchObject({
      message: expect.stringMatching(/security token/),
      model: false,
    });
    expect(detectBedrockRefusal(turn("API Error: 403 AccessDeniedException: User is not authorized to perform bedrock:InvokeModel", true))).toMatchObject({ model: false });
    expect(detectBedrockLimit(turn("API Error: 403 AccessDeniedException", true), now)).toBeNull();
    expect(detectBedrockRefusal(turn("API Error: 429 Too many tokens, please wait before trying again.", true))).toBeNull();
  });

  it("reads Claude Code's API Error replies in a completed turn too, as Paseo before 0.16 reports them, but never its warnings or error rows", () => {
    const completed = (reply: string): TurnEvent => ({
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "Fix the build." },
        { type: "notification", level: "warning", message: "MCP client for github failed to start: HTTP 401 Unauthorized" },
        { type: "error", message: "An error occurred (AccessDeniedException) when calling the ListBuckets operation: Access Denied" },
        { type: "assistant_message", text: reply },
      ] as never,
      turnId: "t1",
    });
    expect(detectBedrockLimit(completed("API Error: 429 Too many tokens, please wait before trying again."), now)).toMatchObject({ kind: "window" });
    expect(detectBedrockRefusal(completed("API Error: 403 The security token included in the request is expired"))).toMatchObject({ model: false });
    expect(detectBedrockRefusal(completed(`API Error (${OPUS}): 400 The provided model identifier is invalid.`))).toMatchObject({ model: true });
    expect(detectBedrockRefusal(turn("API Error: 403 AccessDeniedException: You don't have access to the model with the specified model ID."))).toMatchObject({ model: true });
    // The warning and the tool's AccessDenied are other services': with an ordinary reply, nothing counts.
    const ordinary = completed("The bucket listing was refused, so I used the cached list.");
    expect(detectBedrockLimit(ordinary, now)).toBeNull();
    expect(detectBedrockRefusal(ordinary)).toBeNull();
    // Only the last reply or two: an API Error earlier in the turn was retried past.
    const earlier: TurnEvent = {
      outcome: { kind: "completed" },
      timeline: [
        { type: "user_message", text: "Fix the build." },
        { type: "assistant_message", text: "API Error: 429 Too many tokens, please wait before trying again." },
        { type: "assistant_message", text: "Retrying." },
        { type: "assistant_message", text: "The build passes now." },
      ] as never,
      turnId: "t1",
    };
    expect(detectBedrockLimit(earlier, now)).toBeNull();
  });

  it("tells a model the region doesn't offer, in a failed or completed turn, and names it", () => {
    const text = "The model eu.anthropic.claude-sonnet-4-5-20250929-v1:0 is not available on your bedrock deployment. Try --model to switch to global.anthropic.claude-sonnet-5-5.";
    for (const failed of [false, true]) {
      expect(detectBedrockModelUnavailable(turn(text, failed))).toEqual({
        message: text,
        model: "eu.anthropic.claude-sonnet-4-5-20250929-v1:0",
      });
      // Not taken for a refusal or a limit, so it never signs the account out or sets it aside.
      expect(detectBedrockRefusal(turn(text, failed))).toBeNull();
      expect(detectBedrockLimit(turn(text, failed), now)).toBeNull();
    }
    expect(detectBedrockModelUnavailable(turn("I checked: the model isn't available on your bedrock deployment, so I used Opus."))).toBeNull();
  });

  it("tells Paseo's refusal of Claude's Auto mode, in a failed or completed turn, from a refusal or a limit", () => {
    const text = "Claude Auto mode requires the Anthropic API. Switch this agent to another mode to use Bedrock.";
    for (const failed of [false, true]) {
      expect(detectBedrockAutoModeRefusal(turn(text, failed))).toBe(text);
      expect(detectBedrockRefusal(turn(text, failed))).toBeNull();
      expect(detectBedrockLimit(turn(text, failed), now)).toBeNull();
    }
    expect(detectBedrockAutoModeRefusal(turn("API Error: 429 Too many tokens, please wait before trying again.", true))).toBeNull();
  });

  it("ignores ordinary replies that only talk about these errors", () => {
    const prose = turn("I fixed the handler so a 429 ThrottlingException is retried, and AccessDeniedException is logged.");
    expect(detectBedrockLimit(prose, now)).toBeNull();
    expect(detectBedrockRefusal(prose)).toBeNull();
    // Nor in a failed turn: only the failure itself and Claude Code's "API Error" replies are read.
    const failed: TurnEvent = { ...prose, outcome: { kind: "failed", error: { message: "The agent stopped." } } };
    expect(detectBedrockLimit(failed, now)).toBeNull();
    expect(detectBedrockRefusal(failed)).toBeNull();
  });
});

describe("Bedrock accounts among Claude accounts", () => {
  const base = (id: string, patch: Partial<StoredAccount> = {}): StoredAccount =>
    StoredAccountSchema.parse({ id, family: "claude", label: id, kind: "managed", home: `/h/${id}`, createdAt: "2026-09-01T00:00:00Z", ...patch });
  const NOW = Date.parse("2026-11-15T12:00:00Z");
  const sub = base("claude-sub");
  const bedrock = base("claude-bedrock", { auth: "api", provider: "bedrock", createdAt: "2026-01-01T00:00:00Z" });
  // An API-key account from #65: a Claude account on a key, with no marker.
  const keyed = base("claude-key", { auth: "api", identity: "api|https://api.anthropic.com|0123456789abcdef" });
  const busy: Usage = { fetchedAt: "2026-11-15T11:59:00Z", windows: [{ id: "five_hour", label: "5-hour", usedPercent: 95, resetsAt: null }], error: null, cached: false, resets: null, credits: null };
  const usageOf = (id: string) => (id === sub.id ? busy : null);
  const out = { ...sub, limitedUntil: "2026-11-15T15:00:00Z", limitKind: "window" as const };

  it("are told apart by their marker only: an API-key Claude account is never one", () => {
    expect(isBedrockAccount(bedrock)).toBe(true);
    expect(isBedrockAccount(keyed)).toBe(false);
    expect(isBedrockAccount({ ...keyed, provider: "azure" })).toBe(false);
    expect(isBedrockAccount({ ...bedrock, family: "codex" })).toBe(false);
    expect(isLastResort(bedrock)).toBe(true);
    expect(isLastResort(keyed)).toBe(false);
    // Neither stands in by itself like a subscription does.
    expect(canStandIn(bedrock, NOW)).toBe(false);
    expect(canStandIn(keyed, NOW)).toBe(false);
    for (const paidFallback of [false, true]) {
      expect(mostAvailable({ ...emptyState(), accounts: [out, keyed] }, "claude", usageOf, NOW, new Set(), paidFallback)).toBeUndefined();
    }
  });

  it("are passed over while a subscription account can stand in, however full", () => {
    expect(mostAvailable({ ...emptyState(), accounts: [sub, bedrock] }, "claude", usageOf, NOW, new Set(), true)?.id).toBe(sub.id);
  });

  it("take over once every subscription account is out, only with paid API fallback on", () => {
    expect(mostAvailable({ ...emptyState(), accounts: [out, bedrock] }, "claude", usageOf, NOW)).toBeUndefined();
    expect(mostAvailable({ ...emptyState(), accounts: [out, bedrock] }, "claude", usageOf, NOW, new Set(), true)?.id).toBe(bedrock.id);
    expect(mostAvailable({ ...emptyState(), accounts: [{ ...sub, disabled: true }, bedrock] }, "claude", usageOf, NOW, new Set(), true)?.id).toBe(bedrock.id);
    expect(mostAvailable({ ...emptyState(), accounts: [{ ...sub, signedIn: false }, keyed, bedrock] }, "claude", usageOf, NOW, new Set(), true)?.id).toBe(bedrock.id);
  });
});

describe("normalizeRegion", () => {
  it("takes region codes only", () => {
    expect(normalizeRegion(" EU-Central-1 ")).toBe("eu-central-1");
    expect(normalizeRegion("us-gov-west-1")).toBe("us-gov-west-1");
    expect(() => normalizeRegion("Frankfurt")).toThrow(/region/);
  });
});
