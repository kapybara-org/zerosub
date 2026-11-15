import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Usage } from "../shared/model";
import type { TurnEvent } from "./adapter";
import { ApiUsageStore } from "./api-usage";
import {
  bedrockEnv,
  bedrockIdentity,
  bedrockSettings,
  bedrockSummary,
  checkBedrock,
  checkEnv,
  findClaudeSession,
  normalizeRegion,
  parseClaudeSession,
  writeBedrockAccount,
  type BedrockAccount,
} from "./bedrock";
import { ClaudeAdapter } from "./claude";
import { prepareClaudeHome } from "./homes";
import { BEDROCK_QUOTA_MS, BEDROCK_THROTTLE_MS, detectBedrockLimit, detectBedrockRefusal } from "./limits";
import type { RunResult } from "./process";
import { mostAvailable } from "./routing";
import { emptyState, type StoredAccount } from "./state";

const SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
const TOKEN = "IQoJb3JpZ2luX2VjEXAMPLESESSIONTOKEN";
const MODELS = { model: "", opus: "global.anthropic.claude-opus-5-5", sonnet: "", haiku: "" };

function account(patch: Partial<BedrockAccount> = {}): BedrockAccount {
  return { region: "eu-central-1", source: "host", profile: null, accessKeyId: null, secretAccessKey: null, sessionToken: null, models: MODELS, prices: {}, ...patch };
}
const keys = account({ source: "keys", accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: SECRET, sessionToken: TOKEN });

describe("bedrockEnv", () => {
  it("runs Claude Code on Bedrock in the region, with the host's own AWS setup untouched", () => {
    const env = bedrockEnv(account());
    expect(env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1", AWS_DEFAULT_REGION: "eu-central-1", ANTHROPIC_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "" });
    for (const key of ["AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_BEARER_TOKEN_BEDROCK"]) expect(env).not.toHaveProperty(key);
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe("global.anthropic.claude-opus-5-5");
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
  it("hands an access key over in the environment only", () => {
    expect(bedrockEnv(keys)).toMatchObject({ AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", AWS_SECRET_ACCESS_KEY: SECRET, AWS_SESSION_TOKEN: TOKEN, AWS_PROFILE: "" });
    // The aws CLI check gets the same, minus what's blank.
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
    env: { ANTHROPIC_API_KEY: "sk-ant-main", CLAUDE_CODE_USE_VERTEX: "1", AWS_ACCESS_KEY_ID: "AKIAMAIN", AWS_PROFILE: "main", ANTHROPIC_MODEL: "claude-opus-first-party", OTHER: "kept" },
  };
  it("turns Bedrock on over main's settings and keeps no other provider or login", () => {
    const settings = bedrockSettings(main, keys);
    expect(settings).not.toHaveProperty("apiKeyHelper");
    expect(settings).not.toHaveProperty("awsAuthRefresh");
    expect(settings.model).toBe("opus");
    expect(settings.env).toEqual({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1", ANTHROPIC_DEFAULT_OPUS_MODEL: "global.anthropic.claude-opus-5-5", OTHER: "kept" });
    expect(JSON.stringify(settings)).not.toContain(SECRET);
  });
  it("keeps the host's own AWS setup for the host source, and sets a profile's name", () => {
    expect(bedrockSettings(main, account()).env).toMatchObject({ AWS_ACCESS_KEY_ID: "AKIAMAIN", AWS_PROFILE: "main" });
    expect(bedrockSettings(main, account()).awsAuthRefresh).toBe("aws sso login");
    expect(bedrockSettings(main, account({ source: "profile", profile: "bedrock" })).env).toMatchObject({ AWS_PROFILE: "bedrock" });
    expect(bedrockSettings(main, account({ source: "profile", profile: "bedrock" })).env).not.toHaveProperty("AWS_ACCESS_KEY_ID");
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
    await rm(root, { recursive: true, force: true });
  });

  it("keeps secrets in bedrock.json only (mode 600), never in settings.json or the summary", async () => {
    const home = join(root, "home");
    await writeBedrockAccount(home, keys);
    expect((await stat(join(home, "bedrock.json"))).mode & 0o777).toBe(0o600);
    await prepareClaudeHome(home, true);
    const settings = await readFile(join(home, "settings.json"), "utf8");
    expect(JSON.parse(settings).env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "eu-central-1" });
    expect(settings).not.toContain(SECRET);
    expect(settings).not.toContain("apiKeyHelper");
    expect(settings).not.toContain("sk-ant-main");
    const summary = JSON.stringify(bedrockSummary(keys, null));
    expect(summary).not.toContain(SECRET);
    expect(summary).not.toContain(TOKEN);
    expect(summary).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(bedrockIdentity(keys)).not.toContain("AKIAIOSFODNN7EXAMPLE");

    const env = await new ClaudeAdapter().env(home);
    expect(env).toMatchObject({ CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_USE_BEDROCK: "1", AWS_SECRET_ACCESS_KEY: SECRET });
    expect(await new ClaudeAdapter().identity(home)).toMatchObject({ signedIn: true, plan: "AWS Bedrock" });
  });

  it("finds a Claude Code session and counts each message once, from the turn's start", async () => {
    const projects = join(root, "claude", "projects");
    const session = "4b7c2a10-1d2e-4f3a-9b8c-7d6e5f4a3b2c";
    await mkdir(join(projects, "-home-me-app"), { recursive: true });
    const line = (id: string, at: string, usage: Record<string, number>, model = "global.anthropic.claude-opus-5-5") =>
      JSON.stringify({ type: "assistant", timestamp: at, message: { id, model, usage } });
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
      { id: "msg_1", model: "global.anthropic.claude-opus-5-5", count: { input: 1210, cachedInput: 1000, cacheWrite: 200, output: 50 } },
      { id: "msg_2", model: "global.anthropic.claude-opus-5-5", count: { input: 3, cachedInput: 0, cacheWrite: 0, output: 7 } },
    ]);
    const store = new ApiUsageStore(join(root, "api-usage.json"));
    const now = Date.parse("2026-11-15T10:01:00Z");
    expect(await store.countMessages("claude-b", session, messages, now)).toBe(2);
    expect(await store.countMessages("claude-b", session, messages, now)).toBe(0);
    expect((await store.read()).accounts["claude-b"]?.models["global.anthropic.claude-opus-5-5"]).toEqual({ input: 1213, cachedInput: 1000, cacheWrite: 200, output: 57 });
  });
});

describe("checkBedrock", () => {
  const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
  const fail = (stderr: string, code: number | null = 255): RunResult => ({ code, stdout: "", stderr, timedOut: false });
  it("passes when STS and Bedrock answer", async () => {
    const calls: string[][] = [];
    const result = await checkBedrock(keys, async (args) => {
      calls.push([...args]);
      return args[0] === "sts" ? ok('{"Arn":"arn:aws:sts::123456789012:assumed-role/bedrock/i-0"}') : ok("{}");
    });
    expect(result).toEqual({ ok: true, detail: "arn:aws:sts::123456789012:assumed-role/bedrock/i-0" });
    expect(calls.map((args) => args.slice(0, 2))).toEqual([["sts", "get-caller-identity"], ["bedrock", "list-inference-profiles"]]);
  });
  it("fails on refused credentials, without the secret in the message", async () => {
    const result = await checkBedrock(keys, async () => fail(`An error occurred (SignatureDoesNotMatch) when calling GetCallerIdentity: bad signature for ${SECRET}`));
    expect(result).toMatchObject({ ok: false, fatal: true });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(await checkBedrock(account(), async () => fail("Unable to locate credentials. You can configure credentials by running \"aws configure\"."))).toMatchObject({ fatal: true });
  });
  it("only warns without the aws command, offline, or when profiles can't be listed", async () => {
    expect(await checkBedrock(account(), async () => fail("spawn aws ENOENT", null))).toMatchObject({ ok: false, fatal: false });
    expect(await checkBedrock(account(), async () => fail('Could not connect to the endpoint URL: "https://sts.eu-central-1.amazonaws.com/"'))).toMatchObject({ fatal: false });
    const listing = await checkBedrock(account(), async (args) => (args[0] === "sts" ? ok("{}") : fail("An error occurred (AccessDeniedException) when calling ListInferenceProfiles")));
    expect(listing).toMatchObject({ ok: false, fatal: false });
  });
});

describe("Bedrock errors", () => {
  const now = new Date("2026-11-15T12:00:00Z");
  const turn = (text: string, failed = false): TurnEvent => ({
    outcome: failed ? { kind: "failed", error: { message: text } } : { kind: "completed" },
    timeline: [{ type: "assistant_message", text }] as never,
    turnId: "t1",
  });
  it("takes throttling for a short cooldown and an exceeded quota for a longer one", () => {
    expect(detectBedrockLimit(turn("API Error: 429 Too many tokens, please wait before trying again."), now)).toMatchObject({
      kind: "window",
      resetsAt: new Date(now.getTime() + BEDROCK_THROTTLE_MS).toISOString(),
    });
    expect(detectBedrockLimit(turn("ThrottlingException: Rate exceeded", true), now)?.kind).toBe("window");
    expect(detectBedrockLimit(turn("API Error: ServiceQuotaExceededException: daily tokens", true), now)).toMatchObject({
      kind: "budget",
      resetsAt: new Date(now.getTime() + BEDROCK_QUOTA_MS).toISOString(),
    });
  });
  it("reports refused access or a model that isn't enabled", () => {
    expect(detectBedrockRefusal(turn("API Error: 403 AccessDeniedException: You don't have access to the model with the specified model ID."))).toMatch(/AccessDenied/);
    expect(detectBedrockRefusal(turn("API Error (global.anthropic.claude-opus-5-5): 400 The provided model identifier is invalid."))).toMatch(/model identifier/);
    expect(detectBedrockLimit(turn("API Error: 403 AccessDeniedException"), now)).toBeNull();
  });
  it("ignores ordinary replies that only talk about these errors", () => {
    const prose = turn("I fixed the handler so a 429 ThrottlingException is retried, and AccessDeniedException is logged.");
    expect(detectBedrockLimit(prose, now)).toBeNull();
    expect(detectBedrockRefusal(prose)).toBeNull();
  });
});

describe("Bedrock: last resort among Claude accounts", () => {
  const base = (id: string, patch: Partial<StoredAccount> = {}): StoredAccount => ({
    id, family: "claude", label: id, autoLabel: false, kind: "managed", auth: "subscription", home: `/h/${id}`, email: null, plan: null,
    organization: null, identity: null, signedIn: true, disabled: false, limitedUntil: null, limitKind: null, limitedAt: null, createdAt: "2026-09-01T00:00:00Z", ...patch,
  });
  const NOW = Date.parse("2026-11-15T12:00:00Z");
  const sub = base("claude-sub");
  const bedrock = base("claude-bedrock", { auth: "api", createdAt: "2026-01-01T00:00:00Z" });
  const busy: Usage = { fetchedAt: "2026-11-15T11:59:00Z", windows: [{ id: "five_hour", label: "5-hour", usedPercent: 95, resetsAt: null }], error: null, cached: false, resets: null, credits: null };
  const usageOf = (id: string) => (id === sub.id ? busy : null);
  it("is passed over while a subscription account can stand in, however full", () => {
    expect(mostAvailable({ ...emptyState(), accounts: [sub, bedrock] }, "claude", usageOf, NOW)?.id).toBe(sub.id);
  });
  it("takes over once every subscription account is out", () => {
    const out = { ...sub, limitedUntil: "2026-11-15T15:00:00Z", limitKind: "window" as const };
    expect(mostAvailable({ ...emptyState(), accounts: [out, bedrock] }, "claude", usageOf, NOW)?.id).toBe(bedrock.id);
    expect(mostAvailable({ ...emptyState(), accounts: [{ ...sub, disabled: true }, bedrock] }, "claude", usageOf, NOW)?.id).toBe(bedrock.id);
  });
});

describe("normalizeRegion", () => {
  it("takes region codes only", () => {
    expect(normalizeRegion(" EU-Central-1 ")).toBe("eu-central-1");
    expect(normalizeRegion("us-gov-west-1")).toBe("us-gov-west-1");
    expect(() => normalizeRegion("Frankfurt")).toThrow(/region/);
  });
});
