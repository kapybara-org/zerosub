import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ApiMonth, ApiPrice, AzureSummary, TokenCount } from "../shared/model";
import { cleanPrices } from "./api-usage";
import { Mutex, readJson, writeJsonAtomic } from "./json-file";
import { mainCodexHome } from "./paths";
import { providerEnv } from "./provider-env";
import { bypassesProxy, proxiedFetch, proxyFromEnv } from "./proxy";

/**
 * Azure OpenAI accounts: a ChatGPT (Codex) account that runs Codex on an Azure OpenAI resource with an
 * API key instead of a ChatGPT sign-in. Its home is a Codex home like any added account's, except:
 *
 * - `azure.json` (mode 600) holds the endpoint, the key and the user's price table. The key is never
 *   logged, never written to the registry, and never sent to the app (only its last four characters).
 * - `config.toml` isn't a link to `~/.codex/config.toml`: it's that file with `model_provider` set to
 *   ZeroSub's Azure provider, whose key Codex reads from `AZURE_KEY_ENV` (set for each session it opens).
 * - There's no `auth.json`: nothing signs in.
 */

/** The account's own settings file, in its home. */
export const AZURE_FILE = "azure.json";
/** The variable the generated provider reads its key from (`env_key`). */
export const AZURE_KEY_ENV = "ZEROSUB_AZURE_OPENAI_API_KEY";
/** The provider's id in the generated `config.toml`. */
export const AZURE_PROVIDER_ID = "zerosub_azure";
/** Keys shorter than this get no hint: their last four characters would give away too much. */
const KEY_HINT_MIN_LENGTH = 12;

export interface AzureAccount {
  endpoint: string;
  key: string;
  prices: Record<string, ApiPrice>;
}

/**
 * Whether `home` is an Azure OpenAI account's (it has `azure.json`), for the Codex adapter, which only
 * sees homes. The registry marks the account itself (`provider: "azure"`), and that's what routing and
 * the app go by. No other Codex home can have the file: it's never linked in from `~/.codex`.
 */
export function isAzureHome(home: string | null | undefined): home is string {
  return Boolean(home) && existsSync(join(home!, AZURE_FILE));
}

/**
 * Checks the endpoint typed by the user: https only, no credentials, query or fragment, and no trailing
 * slash. A bare resource URL gets Azure's v1 API path (`/openai/v1`), and `/openai` gets `/v1`.
 */
export function normalizeAzureEndpoint(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter the endpoint as a URL, like https://<resource>.openai.azure.com/openai/v1");
  }
  if (url.protocol !== "https:") throw new Error("The endpoint must start with https://");
  if (url.username || url.password) throw new Error("Put the key in the key field, not in the endpoint URL");
  if (url.search || url.hash) throw new Error("The endpoint can't have a query or fragment (Azure's v1 API needs no api-version)");
  let path = url.pathname.replace(/\/+$/, "");
  if (path === "") path = "/openai/v1";
  else if (/\/openai$/i.test(path)) path = `${path}/v1`;
  return `https://${url.host}${path}`;
}

export function azureKeyHint(key: string): string {
  return key.length >= KEY_HINT_MIN_LENGTH ? key.slice(-4) : "";
}

/** A short hash of the key, to tell two accounts with the same key apart from the registry without storing it. */
export function azureIdentity(endpoint: string, key: string): string {
  return `azure|${endpoint}|${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** The account's settings; throws when the file is missing or has no endpoint or key. */
export async function readAzureAccount(home: string): Promise<AzureAccount> {
  const raw = await readJson(join(home, AZURE_FILE)).catch(() => undefined);
  const value = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const endpoint = typeof value?.endpoint === "string" ? value.endpoint.trim() : "";
  const key = typeof value?.key === "string" ? value.key.trim() : "";
  if (!endpoint || !key) throw new Error(`${home} has no readable ${AZURE_FILE}`);
  return { endpoint, key, prices: cleanPrices(value?.prices) };
}

/** Writes the account's settings, readable only by the user (mode 600, in a folder only they can open). */
export async function writeAzureAccount(home: string, account: AzureAccount): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await writeJsonAtomic(join(home, AZURE_FILE), { endpoint: account.endpoint, key: account.key, prices: account.prices }, { mode: 0o600 });
}

/** What the app may see of the account: no key, only its hint. */
export function azureSummary(account: AzureAccount, usage: ApiMonth | null): AzureSummary {
  let host = account.endpoint;
  try {
    host = new URL(account.endpoint).host;
  } catch {
    // Kept as typed.
  }
  return { endpoint: account.endpoint, host, keyHint: azureKeyHint(account.key), prices: account.prices, usage };
}

// --------------------------------------------------------------------------- config.toml

const TABLE_HEADER = /^\s*\[\[?([^[\]#]+)\]\]?\s*(?:#.*)?$/;

/** A table header's name with quotes and spaces taken out (`model_providers."x"` → `model_providers.x`). */
function tableName(raw: string): string {
  return raw.replace(/["'\s]/g, "");
}

/**
 * Walks a TOML line outside strings: how much `[`/`]` nesting it opens or closes, and whether it
 * leaves a multi-line string (`"""` or `'''`) open. Comments end the line.
 */
function scanLine(line: string, openString: string | null): { depth: number; openString: string | null } {
  let depth = 0;
  let index = 0;
  let quote = openString;
  while (index < line.length) {
    if (quote) {
      if (quote.length === 3) {
        const end = line.indexOf(quote, index);
        if (end < 0) return { depth, openString: quote };
        index = end + 3;
        quote = null;
        continue;
      }
      const char = line[index]!;
      if (quote === '"' && char === "\\") index += 2;
      else {
        if (char === quote) quote = null;
        index += 1;
      }
      continue;
    }
    const rest = line.slice(index);
    if (rest.startsWith('"""') || rest.startsWith("'''")) {
      quote = rest.slice(0, 3);
      index += 3;
      continue;
    }
    const char = line[index]!;
    if (char === "#") break;
    if (char === '"' || char === "'") quote = char;
    else if (char === "[") depth += 1;
    else if (char === "]") depth -= 1;
    index += 1;
  }
  // A single-line string can't stay open past its line.
  return { depth, openString: quote && quote.length === 3 ? quote : null };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * The Azure home's `config.toml`: the shared one, with Codex's provider set to ZeroSub's Azure
 * provider. Only what that needs changes: a top-level `model_provider` (and a top-level dotted key or
 * table for the `zerosub_azure` provider) is taken out, `model_provider` goes in first (before any
 * table header, so it stays top-level), and the provider's table goes at the end. Everything else,
 * comments, profiles and other providers included, stays as it is. A `profile` that sets its own
 * `model_provider` still wins over this, as it would in Codex.
 */
export function azureConfigToml(shared: string, endpoint: string): string {
  const out: string[] = [];
  let table: string | null = null;
  let dropTable = false;
  let depth = 0;
  let openString: string | null = null;
  let dropValue = false;
  for (const line of shared.replace(/\r\n/g, "\n").split("\n")) {
    // Inside a value that spans lines (a multi-line string or array): it goes wherever its key went.
    if (openString || depth > 0) {
      const scanned = scanLine(line, openString);
      openString = scanned.openString;
      depth = Math.max(0, depth + scanned.depth);
      if (!dropValue && !dropTable) out.push(line);
      continue;
    }
    const header = TABLE_HEADER.exec(line);
    if (header?.[1]) {
      table = tableName(header[1]);
      dropTable = table === `model_providers.${AZURE_PROVIDER_ID}` || table.startsWith(`model_providers.${AZURE_PROVIDER_ID}.`);
      if (!dropTable) out.push(line);
      continue;
    }
    const scanned = scanLine(line, null);
    openString = scanned.openString;
    depth = Math.max(0, scanned.depth);
    const key = /^\s*([A-Za-z0-9_."'-]+?)\s*=/.exec(line)?.[1];
    const name = key ? tableName(key) : null;
    dropValue =
      table === null &&
      name !== null &&
      (name === "model_provider" || name === `model_providers.${AZURE_PROVIDER_ID}` || name.startsWith(`model_providers.${AZURE_PROVIDER_ID}.`));
    if (!dropValue && !dropTable) out.push(line);
  }
  while (out.length > 0 && out[out.length - 1]!.trim() === "") out.pop();
  return [
    "# Made by ZeroSub for an Azure OpenAI account from ~/.codex/config.toml; it's remade when that changes,",
    "# so edit ~/.codex/config.toml instead. The API key isn't here: Codex reads it from " + AZURE_KEY_ENV + ".",
    `model_provider = ${tomlString(AZURE_PROVIDER_ID)}`,
    "",
    ...(out.length > 0 ? [...out, ""] : []),
    `[model_providers.${AZURE_PROVIDER_ID}]`,
    `name = ${tomlString("Azure OpenAI")}`,
    `base_url = ${tomlString(endpoint)}`,
    `env_key = ${tomlString(AZURE_KEY_ENV)}`,
    `wire_api = ${tomlString("responses")}`,
    "",
  ].join("\n");
}

const configLocks = new Map<string, Mutex>();

/**
 * Remakes the Azure home's `config.toml` from the shared one when what it would hold has changed (a
 * read of two small files and a compare, so it runs at every session open). A link to the shared file
 * left by an earlier sync is replaced by the file, never written through.
 */
export function syncAzureConfig(home: string): Promise<void> {
  let lock = configLocks.get(home);
  if (!lock) configLocks.set(home, (lock = new Mutex()));
  return lock.run(async () => {
    const { endpoint } = await readAzureAccount(home);
    const shared = await readFile(join(mainCodexHome(), "config.toml"), "utf8").catch(() => "");
    const next = azureConfigToml(shared, endpoint);
    const target = join(home, "config.toml");
    const current = await lstat(target).catch(() => null);
    if (current?.isFile() && (await readFile(target, "utf8").catch(() => null)) === next) return;
    if (current?.isSymbolicLink()) await unlink(target);
    const temporary = join(home, `.config.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(next);
      } finally {
        await file.close();
      }
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  });
}

// --------------------------------------------------------------------------- checking a key

export type AzureCheck = { ok: true } | { ok: false; fatal: boolean; message: string };

type Fetcher = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<{ status: number }>;

const defaultFetcher: Fetcher = (url, init) => {
  const env = { ...process.env, ...providerEnv("codex") };
  const proxy = proxyFromEnv(env);
  const direct = !proxy || bypassesProxy(env.no_proxy ?? env.NO_PROXY ?? null, url);
  return proxiedFetch(direct ? null : proxy, url, init);
};

/**
 * Asks the endpoint for its models with the key (`GET {endpoint}/models`, `api-key` header). A refused
 * key (401/403) is `fatal`; anything else that goes wrong (the network, a timeout, another status) is
 * only a warning, so an account can be saved while Azure can't be reached from here. Error text never
 * includes the key.
 */
export async function checkAzureKey(endpoint: string, key: string, fetcher: Fetcher = defaultFetcher, timeoutMs = 15_000): Promise<AzureCheck> {
  try {
    const response = await fetcher(`${endpoint}/models`, { headers: { "api-key": key, accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status >= 200 && response.status < 300) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, fatal: true, message: `Azure refused the key (HTTP ${response.status}). Check the key and that it belongs to this resource.` };
    }
    return {
      ok: false,
      fatal: false,
      message:
        response.status === 404
          ? "The endpoint answered 404 for its model list: check that it ends in /openai/v1."
          : `The endpoint answered HTTP ${response.status} for its model list.`,
    };
  } catch (error) {
    const reason = error instanceof Error ? (error.name === "TimeoutError" ? "it didn't answer in time" : error.message) : String(error);
    return { ok: false, fatal: false, message: `Couldn't reach the endpoint to check the key (${reason.replaceAll(key, "…")}).` };
  }
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * A Codex thread's tokens so far, from its rollout file: the last `token_count` event's
 * `total_token_usage`, and the model of its last `turn_context`. Null when the file has neither.
 */
export function parseRollout(text: string): { model: string | null; total: TokenCount } | null {
  let model: string | null = null;
  let total: TokenCount | null = null;
  for (const line of text.split("\n")) {
    if (!line.includes("token_count") && !line.includes("turn_context")) continue;
    let entry: { type?: unknown; payload?: Record<string, unknown> };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    const payload = entry.payload;
    if (!payload || typeof payload !== "object") continue;
    if (entry.type === "turn_context" && typeof payload.model === "string") model = payload.model;
    if (entry.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info as { total_token_usage?: Record<string, unknown> } | null | undefined;
      const usage = info?.total_token_usage;
      if (usage) total = { input: number(usage.input_tokens), cachedInput: number(usage.cached_input_tokens), cacheWrite: 0, output: number(usage.output_tokens) };
    }
  }
  return total ? { model, total } : null;
}

const rolloutPaths = new Map<string, string>();
const ROLLOUT_DAYS_SEARCHED = 120;

/** Where Codex keeps a thread's rollout: `sessions/YYYY/MM/DD/rollout-<time>-<thread id>.jsonl`, newest days first. */
export async function findRollout(threadId: string, sessions = join(mainCodexHome(), "sessions")): Promise<string | null> {
  const known = rolloutPaths.get(threadId);
  if (known && existsSync(known)) return known;
  if (!/^[\w-]{8,}$/.test(threadId)) return null;
  const sorted = async (dir: string) => (await readdir(dir).catch(() => [] as string[])).filter((name) => /^\d+$/.test(name)).sort().reverse();
  let days = 0;
  for (const year of await sorted(sessions)) {
    for (const month of await sorted(join(sessions, year))) {
      for (const day of await sorted(join(sessions, year, month))) {
        if (days++ >= ROLLOUT_DAYS_SEARCHED) return null;
        const dir = join(sessions, year, month, day);
        const name = (await readdir(dir).catch(() => [] as string[])).find((entry) => entry.startsWith("rollout-") && entry.endsWith(`${threadId}.jsonl`));
        if (name) {
          const path = join(dir, name);
          rolloutPaths.set(threadId, path);
          return path;
        }
      }
    }
  }
  return null;
}
