import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { request } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  BedrockModelsSchema,
  BedrockSourceSchema,
  type ApiMonth,
  type ApiPrice,
  type BedrockModels,
  type BedrockSource,
  type BedrockSummary,
  type TokenCount,
} from "../shared/model";
import type { EnvPatch } from "./adapter";
import { cleanPrices } from "./api-usage";
import { readJson, writeJsonAtomic } from "./json-file";
import { mainClaudeDir } from "./paths";
import { run, type RunResult } from "./process";
import { providerEnv } from "./provider-env";

/**
 * AWS Bedrock accounts: a Claude account that runs Claude Code on Amazon Bedrock instead of a Claude
 * subscription. Its home is a Claude home like any added account's (shared entries linked, settings
 * generated), with no sign-in in it, except:
 *
 * - `bedrock.json` (mode 600) holds the region, where its AWS credentials come from, model overrides
 *   and the price table, and, only for an access key, the key. It's private to every Claude home, so
 *   none links it in from `~/.claude`, and nothing in it is ever logged or sent to the app.
 * - Each session gets `CLAUDE_CODE_USE_BEDROCK=1` and the AWS variables of its source (see
 *   `bedrockEnv`), and the generated `settings.json` is made to agree (see `bedrockSettings`).
 */

export const BEDROCK_FILE = "bedrock.json";

export interface BedrockAccount {
  region: string;
  source: BedrockSource;
  profile: string | null;
  accessKeyId: string | null;
  secretAccessKey: string | null;
  sessionToken: string | null;
  models: BedrockModels;
  prices: Record<string, ApiPrice>;
}

/** Claude Code's model variables, by the override they come from. */
export const MODEL_ENV: Readonly<Record<keyof BedrockModels, string>> = {
  model: "ANTHROPIC_MODEL",
  opus: "ANTHROPIC_DEFAULT_OPUS_MODEL",
  sonnet: "ANTHROPIC_DEFAULT_SONNET_MODEL",
  haiku: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
};

/** AWS credentials from the environment, which the default chain reads before a profile. */
const AWS_KEY_ENV = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;
/** A Bedrock API key, which Claude Code uses before any AWS credentials. */
const AWS_BEARER_ENV = "AWS_BEARER_TOKEN_BEDROCK";
/**
 * What would send a Bedrock account's sessions to another Claude provider, sign them in with a key
 * or token instead, or skip AWS auth: blanked for every session, and in its settings.
 */
const OTHER_PROVIDER_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
  "CLAUDE_CODE_USE_MANTLE",
  "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
] as const;

const REGION = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;

/**
 * Whether `home` is an AWS Bedrock account's (it has `bedrock.json`), for the Claude adapter, which
 * only sees homes. The registry marks the account itself (`provider: "bedrock"`), and that's what
 * routing and the app go by. No other Claude home can have the file: it's never linked in.
 */
export function isBedrockHome(home: string | null | undefined): home is string {
  return Boolean(home) && existsSync(join(home!, BEDROCK_FILE));
}

/** An AWS region code, like `us-east-1` or `eu-central-1`. */
export function normalizeRegion(input: string): string {
  const region = input.trim().toLowerCase();
  if (!REGION.test(region)) throw new Error("Enter the AWS region as a code, like eu-central-1");
  return region;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const NO_MODELS: BedrockModels = { model: "", opus: "", sonnet: "", haiku: "" };

/** The account's settings; throws when the file is missing or unusable. */
export async function readBedrockAccount(home: string): Promise<BedrockAccount> {
  const raw = await readJson(join(home, BEDROCK_FILE)).catch(() => undefined);
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const region = text(value?.region);
  const source = BedrockSourceSchema.safeParse(value?.source);
  if (!region || !REGION.test(region) || !source.success) throw new Error(`${home} has no readable ${BEDROCK_FILE}`);
  const account: BedrockAccount = {
    region,
    source: source.data,
    profile: text(value?.profile),
    accessKeyId: text(value?.accessKeyId),
    secretAccessKey: text(value?.secretAccessKey),
    sessionToken: text(value?.sessionToken),
    models: BedrockModelsSchema.safeParse(value?.models ?? {}).data ?? { ...NO_MODELS },
    prices: cleanPrices(value?.prices),
  };
  if (account.source === "profile" && !account.profile) throw new Error(`${home}'s ${BEDROCK_FILE} names no profile`);
  if (account.source === "keys" && (!account.accessKeyId || !account.secretAccessKey)) throw new Error(`${home}'s ${BEDROCK_FILE} has no access key`);
  return account;
}

/** Writes the account's settings, readable only by the user. Only the fields its source uses are kept. */
export async function writeBedrockAccount(home: string, account: BedrockAccount): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const value: Record<string, unknown> = { region: account.region, source: account.source, models: account.models, prices: account.prices };
  if (account.source === "profile") value.profile = account.profile;
  if (account.source === "keys") {
    value.accessKeyId = account.accessKeyId;
    value.secretAccessKey = account.secretAccessKey;
    if (account.sessionToken) value.sessionToken = account.sessionToken;
  }
  await writeJsonAtomic(join(home, BEDROCK_FILE), value, { mode: 0o600 });
}

/** What the app may see of the account: never the secret or session token, only the access key ID's last four characters. */
export function bedrockSummary(account: BedrockAccount, usage: ApiMonth | null): BedrockSummary {
  return {
    region: account.region,
    source: account.source,
    profile: account.source === "profile" ? account.profile : null,
    keyHint: account.source === "keys" && account.accessKeyId ? account.accessKeyId.slice(-4) : null,
    sessionToken: account.source === "keys" && Boolean(account.sessionToken),
    models: account.models,
    prices: account.prices,
    usage,
  };
}

/** Tells two Bedrock accounts apart without storing a secret: region and source (a key by a short hash of its ID). */
export function bedrockIdentity(account: Pick<BedrockAccount, "region" | "source" | "profile" | "accessKeyId">): string {
  const who =
    account.source === "profile"
      ? `profile:${account.profile}`
      : account.source === "keys"
        ? `key:${createHash("sha256").update(account.accessKeyId ?? "").digest("hex").slice(0, 16)}`
        : "host";
  return `bedrock|${account.region}|${who}`;
}

/**
 * A session's environment on the account: Claude Code on Bedrock in its region, with the AWS
 * credentials of its source, and nothing that would send it elsewhere. Variables another source would
 * read first are blanked: environment keys outrank a profile, and a Bedrock API key outranks both.
 * The host source leaves the AWS variables the daemon has as they are (that's its default chain).
 * A model without an override is blanked too, so Claude Code's own Bedrock defaults apply rather than
 * a first-party model ID the daemon names for subscriptions.
 */
export function bedrockEnv(account: BedrockAccount): EnvPatch {
  const patch: EnvPatch = { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: account.region, AWS_DEFAULT_REGION: account.region };
  for (const key of OTHER_PROVIDER_ENV) patch[key] = "";
  if (account.source === "profile") {
    patch.AWS_PROFILE = account.profile ?? "";
    for (const key of AWS_KEY_ENV) patch[key] = "";
    patch[AWS_BEARER_ENV] = "";
  } else if (account.source === "keys") {
    patch.AWS_ACCESS_KEY_ID = account.accessKeyId ?? "";
    patch.AWS_SECRET_ACCESS_KEY = account.secretAccessKey ?? "";
    patch.AWS_SESSION_TOKEN = account.sessionToken ?? "";
    patch.AWS_PROFILE = "";
    patch[AWS_BEARER_ENV] = "";
  }
  for (const [field, name] of Object.entries(MODEL_ENV) as Array<[keyof BedrockModels, string]>) patch[name] = account.models[field].trim();
  return patch;
}

type Json = Record<string, unknown>;

/**
 * The account's generated `settings.json` (main's with the account's own overrides, as for any added
 * account: see `accountSettings` in homes.ts), made to agree with its sessions' environment. Claude
 * Code applies `env` from settings over what it's started with, so main's `env` could otherwise turn
 * Bedrock off, send it to another provider, or put other AWS credentials or model IDs in place of the
 * account's: those are blanked or set here, as #65 does for API-key accounts. `apiKeyHelper` goes too
 * (it would sign the account in with a key instead), and, unless the account uses the host's own AWS
 * setup, `awsAuthRefresh` and `awsCredentialExport`, which fetch credentials of their own. A proxy
 * the account has of its own (and its no-proxy list) stays. Secrets never go in here: an access key
 * reaches a session only through its environment.
 */
export function bedrockSettings(generated: Json, account: BedrockAccount): Json {
  const settings: Json = { ...generated };
  delete settings.apiKeyHelper;
  if (account.source !== "host") {
    delete settings.awsAuthRefresh;
    delete settings.awsCredentialExport;
  }
  const env: Json = settings.env && typeof settings.env === "object" && !Array.isArray(settings.env) ? { ...(settings.env as Json) } : {};
  for (const key of OTHER_PROVIDER_ENV) env[key] = "";
  env.CLAUDE_CODE_USE_BEDROCK = "1";
  env.AWS_REGION = account.region;
  delete env.AWS_DEFAULT_REGION;
  if (account.source === "profile") {
    env.AWS_PROFILE = account.profile ?? "";
    for (const key of AWS_KEY_ENV) env[key] = "";
    env[AWS_BEARER_ENV] = "";
  } else if (account.source === "keys") {
    // Left out, never blanked: a blank here would beat the key the session is started with.
    for (const key of AWS_KEY_ENV) delete env[key];
    env.AWS_PROFILE = "";
    env[AWS_BEARER_ENV] = "";
  }
  for (const [field, name] of Object.entries(MODEL_ENV) as Array<[keyof BedrockModels, string]>) {
    const model = account.models[field].trim();
    if (model) env[name] = model;
    else delete env[name];
  }
  settings.env = env;
  return settings;
}

// --------------------------------------------------------------------------- checking credentials

export type BedrockCheck = { ok: true; detail: string | null } | { ok: false; fatal: boolean; message: string };

/** The AWS CLI's (and AWS's) words for credentials that are missing, wrong or refused. */
const AWS_AUTH_FAILURE =
  /Unable to locate credentials|InvalidClientTokenId|SignatureDoesNotMatch|ExpiredToken|UnrecognizedClientException|InvalidSignatureException|AuthFailure|security token included in the request is (?:invalid|expired)|The config profile \(.+\) could not be found|Error loading SSO Token|Token has expired|AccessDenied/i;
const AWS_NETWORK_FAILURE = /Could not connect|EndpointConnectionError|Connect timeout|Read timeout|timed out|Name or service not known|getaddrinfo|ENOTFOUND|ECONNREFUSED|ProxyConnectionError/i;

export type AwsRunner = (args: readonly string[], env: NodeJS.ProcessEnv) => Promise<RunResult>;

const awsCli: AwsRunner = (args, env) => run("aws", args, { env, timeoutMs: 20_000 });

/** The environment the `aws` CLI checks the account with: the daemon's (and Paseo's for Claude), with the account's AWS variables. */
export function checkEnv(account: BedrockAccount, base: NodeJS.ProcessEnv = { ...process.env, ...providerEnv("claude") }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, AWS_PAGER: "" };
  for (const [key, value] of Object.entries(bedrockEnv(account))) {
    if (!key.startsWith("AWS_")) continue;
    if (value === null || value === "") delete env[key];
    else env[key] = value;
  }
  return env;
}

/** The last lines of the CLI's answer, without the secret or session token. */
function scrub(message: string, account: BedrockAccount): string {
  let out = message.trim().split("\n").filter(Boolean).slice(-2).join(" ");
  for (const secret of [account.secretAccessKey, account.sessionToken]) if (secret) out = out.replaceAll(secret, "…");
  return out.slice(0, 400);
}

/**
 * Checks the account's credentials with the `aws` CLI, if the host has it: `sts get-caller-identity`
 * (who they are), then `bedrock list-inference-profiles` in the region (that Bedrock answers them).
 * Missing, wrong or expired credentials are `fatal`. Anything else (no CLI, the network, a role that
 * may call Claude models but not list profiles) is only a warning: the first turn tells for sure.
 */
export async function checkBedrock(account: BedrockAccount, runner: AwsRunner = awsCli): Promise<BedrockCheck> {
  const env = checkEnv(account);
  const who = await runner(["sts", "get-caller-identity", "--output", "json", "--region", account.region], env);
  if (who.code === null && /ENOENT|not found/i.test(who.stderr)) {
    return { ok: false, fatal: false, message: "The aws command isn't installed here, so the credentials weren't checked; the first agent turn will tell." };
  }
  if (who.timedOut) return { ok: false, fatal: false, message: "AWS didn't answer in time, so the credentials weren't checked." };
  if (who.code !== 0) {
    const detail = scrub(who.stderr || who.stdout, account);
    if (AWS_NETWORK_FAILURE.test(detail)) return { ok: false, fatal: false, message: `AWS couldn't be reached, so the credentials weren't checked: ${detail}` };
    if (AWS_AUTH_FAILURE.test(detail)) return { ok: false, fatal: true, message: `AWS refused the credentials: ${detail}` };
    return { ok: false, fatal: false, message: `Couldn't check the credentials: ${detail}` };
  }
  let arn: string | null = null;
  try {
    arn = text((JSON.parse(who.stdout) as { Arn?: unknown }).Arn);
  } catch {
    // Only shown.
  }
  const profiles = await runner(["bedrock", "list-inference-profiles", "--max-results", "1", "--region", account.region, "--output", "json"], env);
  if (profiles.code !== 0) {
    const detail = scrub(profiles.stderr || profiles.stdout, account);
    const why = profiles.timedOut || AWS_NETWORK_FAILURE.test(detail) ? "Bedrock couldn't be reached" : "Bedrock didn't list inference profiles for them";
    return { ok: false, fatal: false, message: `The credentials work${arn ? ` (${arn})` : ""}, but ${why}: ${detail || "no answer"}` };
  }
  return { ok: true, detail: arn };
}

// --------------------------------------------------------------------------- the host's region

/** Where a region the host names came from. */
export type RegionSource = "environment" | "config" | "instance";

export interface RegionLookup {
  /** The daemon's environment, for AWS_REGION, AWS_DEFAULT_REGION, AWS_PROFILE and AWS_CONFIG_FILE. */
  env?: NodeJS.ProcessEnv;
  /** Asks the EC2 instance metadata service, giving up after `timeoutMs`. */
  instance?: (timeoutMs: number) => Promise<string | null>;
  /** How long the whole lookup may take. */
  timeoutMs?: number;
}

/** How long the Bedrock form waits for the host's region before leaving the field for the user. */
export const REGION_LOOKUP_MS = 1_500;

/** The region in the AWS config file for the profile the daemon would use. */
async function configRegion(env: NodeJS.ProcessEnv): Promise<string | null> {
  const path = env.AWS_CONFIG_FILE?.trim() || join(homedir(), ".aws", "config");
  const config = await readFile(path, "utf8").catch(() => "");
  const profile = env.AWS_PROFILE?.trim() || "default";
  const escaped = profile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = profile === "default" ? /^\s*\[\s*(?:default|profile\s+default)\s*\]/ : new RegExp(`^\\s*\\[\\s*profile\\s+${escaped}\\s*\\]`);
  let inSection = false;
  for (const line of config.split("\n")) {
    if (/^\s*\[/.test(line)) inSection = header.test(line);
    else if (inSection) {
      const match = /^\s*region\s*=\s*([a-z0-9-]+)/.exec(line);
      if (match?.[1] && REGION.test(match[1])) return match[1];
    }
  }
  return null;
}

/** The EC2 instance's region, from its metadata service (IMDSv2), when the host is one. */
export function instanceRegion(timeoutMs: number): Promise<string | null> {
  const call = (method: string, path: string, headers: Record<string, string>) =>
    new Promise<string | null>((resolve) => {
      const req = request({ host: "169.254.169.254", path, method, headers, timeout: timeoutMs }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve(res.statusCode === 200 ? body : null));
        res.on("error", () => resolve(null));
      });
      req.on("timeout", () => req.destroy());
      req.on("error", () => resolve(null));
      req.end();
    });
  return (async () => {
    const token = await call("PUT", "/latest/api/token", { "X-aws-ec2-metadata-token-ttl-seconds": "60" });
    const region = (await call("GET", "/latest/meta-data/placement/region", token ? { "X-aws-ec2-metadata-token": token } : {}))?.trim();
    return region && REGION.test(region) ? region : null;
  })();
}

/**
 * The region the host's own AWS setup names, to fill in the Bedrock form: the daemon's environment,
 * then the AWS config file, then (on an EC2 instance) its metadata service. Only asked for when that
 * form opens, never at startup, and given up on after `timeoutMs`: off EC2 the metadata service
 * never answers, so the field is left for the user to fill.
 */
export async function detectHostRegion(lookup: RegionLookup = {}): Promise<{ region: string | null; source: RegionSource | null }> {
  const env = lookup.env ?? process.env;
  const timeoutMs = lookup.timeoutMs ?? REGION_LOOKUP_MS;
  const named = env.AWS_REGION?.trim().toLowerCase() || env.AWS_DEFAULT_REGION?.trim().toLowerCase();
  if (named && REGION.test(named)) return { region: named, source: "environment" };
  const configured = await configRegion(env).catch(() => null);
  if (configured) return { region: configured, source: "config" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
    timer.unref?.();
  });
  const instance = await Promise.race([(lookup.instance ?? instanceRegion)(Math.max(100, timeoutMs / 2)).catch(() => null), late]).finally(() =>
    clearTimeout(timer),
  );
  return instance ? { region: instance, source: "instance" } : { region: null, source: null };
}

/** What the service uses to look at the host's AWS setup; tests put stand-ins in its place. */
export interface BedrockHost {
  detectRegion(): Promise<{ region: string | null; source: RegionSource | null }>;
  check(account: BedrockAccount): Promise<BedrockCheck>;
}

export const HOST_AWS: BedrockHost = {
  detectRegion: () => detectHostRegion(),
  check: (account) => checkBedrock(account),
};

// --------------------------------------------------------------------------- tokens

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * The assistant messages in a Claude Code session file written at or after `since` (ms), with their
 * usage, one entry per message (Claude Code can write a message's usage on several lines; the last
 * wins). `input` counts every input token: Anthropic's `input_tokens` plus cache reads and writes.
 */
export function parseClaudeSession(text: string, since: number): Array<{ id: string; model: string; count: TokenCount }> {
  const messages = new Map<string, { id: string; model: string; count: TokenCount }>();
  for (const line of text.split("\n")) {
    if (!line.includes('"usage"')) continue;
    let entry: { type?: unknown; timestamp?: unknown; message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown> } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "assistant" || !entry.message?.usage) continue;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (!Number.isFinite(at) || at < since) continue;
    const id = typeof entry.message.id === "string" ? entry.message.id : null;
    const model = typeof entry.message.model === "string" ? entry.message.model : "unknown";
    if (!id || model === "<synthetic>") continue;
    const usage = entry.message.usage;
    const cachedInput = count(usage.cache_read_input_tokens);
    const cacheWrite = count(usage.cache_creation_input_tokens);
    messages.set(id, {
      id,
      model,
      count: { input: count(usage.input_tokens) + cachedInput + cacheWrite, cachedInput, cacheWrite, output: count(usage.output_tokens) },
    });
  }
  return [...messages.values()];
}

/** Where Claude Code keeps a session: `projects/<project>/<session id>.jsonl`, shared by every Claude home. */
export async function findClaudeSession(sessionId: string, projects = join(mainClaudeDir(), "projects")): Promise<string | null> {
  if (!/^[\w-]{8,}$/.test(sessionId)) return null;
  for (const project of await readdir(projects).catch(() => [] as string[])) {
    const path = join(projects, project, `${sessionId}.jsonl`);
    if (existsSync(path)) return path;
  }
  return null;
}
