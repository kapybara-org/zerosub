import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import type { ApiSummary, LoginMethod } from "../shared/model";
import type { EnvPatch, FamilyAdapter, Identity, LoginHandle, ProxyState, RedeemReply, TurnEvent, UsageRead } from "./adapter";
import { providerCommand } from "./binaries";
import { eachProcessEnvironment, homesInEnvironment, parseTrace } from "./processes";
import { PI_LAUNCH_ENV } from "./launchers";
import { forgetSyncs, normalizeBaseUrl, preparePiHome, readPiAccount, readPiAccountApi, writePiAccountApi, writePiAccountProxy } from "./homes";
import { Mutex, readJson, writeJsonAtomic } from "./json-file";
import { detectPiSignOut } from "./limits";
import { dataDir, mainPiDir, shownPath } from "./paths";
import { run } from "./process";
import { providerEnv } from "./provider-env";
import { NO_PROXY_KEYS, PROXY_KEYS, bypassesProxy, noProxyFromEnv, proxiedFetch, proxyFromEnv, withRequiredNoProxy, withoutDomains } from "./proxy";

const ANTHROPIC_API = "https://api.anthropic.com";
/** Anthropic's edge answers this with the address it sees the request come from (see `claudeEgress`). */
const TRACE = `${ANTHROPIC_API}/cdn-cgi/trace`;
/** Where Anthropic's API and sign-in live; a proxy set here must not be gone around for them. */
const ANTHROPIC_DOMAINS = ["anthropic.com", "claude.ai", "claude.com"];

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- the CLI login's proxy

function mainSettingsPath(): string {
  return join(mainPiDir(), "settings.json");
}

/** `httpProxy` in Pi's own `settings.json`, which Pi applies when the environment names no proxy. */
async function settingsProxy(): Promise<string | null> {
  const settings = await readJson(mainSettingsPath()).catch(() => undefined);
  return isObject(settings) && typeof settings.httpProxy === "string" && settings.httpProxy.trim() ? settings.httpProxy.trim() : null;
}

/** Pi's own login's proxy: `httpProxy` in its settings; null without one. */
function readPiMainProxy(): Promise<string | null> {
  return settingsProxy();
}

/**
 * Sets (or clears, with `null`) Pi's own login's proxy as `httpProxy` in its `settings.json`, so
 * `pi` started anywhere goes through it too, as long as its environment names no proxy. Paseo's
 * agents on the CLI login, and on added accounts without a proxy of their own (which share these
 * settings), get it as environment variables too, which nothing they inherit outranks. The file
 * is written where it really is, keeping the rest of it and its permissions, under Pi's own lock on
 * it, after a copy of it as it was goes to ZeroSub's `backups/`.
 */
async function writePiMainProxy(proxy: string | null): Promise<void> {
  await mainWrites.run(async () => {
    await withPiLock(mainSettingsPath(), async () => {
      const path = await realpath(mainSettingsPath()).catch(() => mainSettingsPath());
      const settings = await readJson(path);
      if (settings !== undefined && !isObject(settings)) throw new Error(`${shownPath(mainSettingsPath())} isn't a JSON object`);
      if (settings === undefined && !proxy) return;
      const next: Record<string, unknown> = { ...(settings ?? {}) };
      if (proxy) next.httpProxy = proxy;
      else delete next.httpProxy;
      if (settings) await backUp("settings", settings);
      const mode = (await stat(path).catch(() => null))?.mode;
      await writeJsonAtomic(path, next, mode === undefined ? 0o600 : mode & 0o777);
    });
    // Added accounts with a proxy of their own have settings made from these.
    forgetSyncs();
  });
}

/** The base URL the CLI login's `models.json` sends Anthropic's requests to, if it sets one. */
async function mainAnthropicBaseUrl(): Promise<string | null> {
  const models = await readJson(join(mainPiDir(), "models.json")).catch(() => undefined);
  const providers = isObject(models) && isObject(models.providers) ? models.providers : {};
  const anthropic = isObject(providers.anthropic) ? providers.anthropic : {};
  return typeof anthropic.baseUrl === "string" && anthropic.baseUrl.trim() ? anthropic.baseUrl.trim() : null;
}

/**
 * The folder Pi keeps the CLI login's sessions for `cwd` in: `sessions/--<cwd with / as ->--` in its
 * agent directory, as Pi names it (`getDefaultSessionDirPath`, 1.4.0 to 1.5.0). Pi names it after its
 * `process.cwd()`, which is the folder's real path (`/private/tmp/x` for `/tmp/x` on macOS).
 */
export async function piSessionDir(cwd: string): Promise<string> {
  const real = await realpath(cwd).catch(() => resolve(cwd));
  const safe = `--${real.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(mainPiDir(), "sessions", safe);
}

/** Whether Pi's sessions directory is set somewhere other than its default under the agent directory. */
async function sessionDirConfigured(): Promise<boolean> {
  if (process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || providerEnv("pi").PI_CODING_AGENT_SESSION_DIR?.trim()) return true;
  const settings = await readJson(join(mainPiDir(), "settings.json")).catch(() => undefined);
  return isObject(settings) && typeof settings.sessionDir === "string" && settings.sessionDir.trim() !== "";
}

/**
 * The variables that send a Pi process through `proxy`: all four proxy variables, so nothing it
 * inherits outranks it, and both no-proxy variables (Pi reads the lower-case one first), set to the
 * list it would otherwise have without the entries that would send Anthropic's traffic, or the
 * account's base URL's, past the proxy, plus localhost and 127.0.0.1 so a gateway on this machine
 * stays direct.
 */
function proxyVariables(proxy: string, baseUrl: string | null): Record<string, string> {
  const inherited = { ...process.env, ...providerEnv("pi") };
  const base = hostOf(baseUrl);
  const noProxy = withRequiredNoProxy(withoutDomains(noProxyFromEnv(inherited), base ? [...ANTHROPIC_DOMAINS, base] : ANTHROPIC_DOMAINS));
  const env: Record<string, string> = {};
  for (const key of PROXY_KEYS) env[key] = proxy;
  for (const key of NO_PROXY_KEYS) env[key] = noProxy;
  return env;
}

/**
 * The proxy a Pi process reaches `target` through, from the environment it starts with, else Pi's
 * `httpProxy` setting, then the no-proxy list; null when it goes direct.
 */
async function piProxyFor(env: Record<string, string | undefined>, target: string): Promise<string | null> {
  const proxy = proxyFromEnv(env) ?? (await settingsProxy());
  return proxy && !bypassesProxy(noProxyFromEnv(env), target) ? proxy : null;
}

/**
 * The proxy Pi goes through when an account has none of its own, and where that's set: the CLI
 * login's (`httpProxy` in Pi's `settings.json`, see `writePiMainProxy`), else the Pi provider's
 * `env` in Paseo's config over the daemon's environment. For the CLI login (`main`) its own doesn't
 * count. Null when it goes direct, or the no-proxy list sends `target` past it.
 */
export async function inheritedPiProxy(target = ANTHROPIC_API, main = false): Promise<{ proxy: string; from: string } | null> {
  // An added account without a proxy of its own goes through the CLI login's, which ZeroSub gives its agents.
  if (!main) {
    const own = await readPiMainProxy();
    if (own) return { proxy: own, from: (await settingsProxy()) ? `the CLI login (httpProxy in ${shownPath(mainSettingsPath())})` : "the CLI login" };
  }
  const provider = providerEnv("pi");
  const env: Record<string, string | undefined> = { ...process.env, ...provider };
  const key = PROXY_KEYS.find((name) => env[name]?.trim());
  if (bypassesProxy(noProxyFromEnv(env), target)) return null;
  if (key) return { proxy: env[key]!.trim(), from: key in provider ? "the Pi provider's env in Paseo's config" : "the daemon's environment" };
  return null;
}

// --------------------------------------------------------------------------- the CLI login's key

/** Keys shorter than this get no hint, as for Claude API accounts. */
const KEY_HINT_MIN_LENGTH = 12;

function mainAuthPath(): string {
  return join(mainPiDir(), "auth.json");
}

function mainModelsPath(): string {
  return join(mainPiDir(), "models.json");
}

/** The Anthropic API key Pi's own login keeps in its `auth.json`; null when it has none (or signs in to Anthropic with OAuth). */
async function mainAnthropicKey(): Promise<string | null> {
  const auth = await readJson(mainAuthPath()).catch(() => undefined);
  const entry = isObject(auth) ? auth.anthropic : undefined;
  return isObject(entry) && entry.type === "api_key" && typeof entry.key === "string" && entry.key.trim() ? entry.key.trim() : null;
}

/** Pi's own login's Anthropic key (reduced to a hint) and base URL; null without an Anthropic API key. */
async function readMainPiApi(): Promise<ApiSummary | null> {
  const key = await mainAnthropicKey();
  if (!key) return null;
  return { keyHint: key.length >= KEY_HINT_MIN_LENGTH ? key.slice(-4) : "", baseUrl: await mainAnthropicBaseUrl() };
}

const PI_BACKUPS = 5;

/**
 * Keeps a copy of one of Pi's own files as it was before ZeroSub changes it, in ZeroSub's
 * `backups/` (readable only by you), the last five of each.
 */
async function backUp(kind: "auth" | "models" | "settings", value: unknown): Promise<void> {
  const backups = join(dataDir(), "backups");
  await writeJsonAtomic(join(backups, `pi-${kind}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), value);
  const pattern = new RegExp(`^pi-${kind}-\\d{4}-\\d{2}-\\d{2}T[\\d-]+Z\\.json$`);
  const kept = (await readdir(backups)).filter((name) => pattern.test(name)).sort();
  for (const name of kept.slice(0, -PI_BACKUPS)) await rm(join(backups, name), { force: true });
}

/**
 * How long Pi's lock on one of its files may go untouched before it's taken for one a crash left.
 * Pi's own async lock on `auth.json` (refreshing a sign-in) counts as stale after 30 s and is only
 * touched every 15 s, so anything shorter could take a live one.
 */
const PI_LOCK_STALE_MS = 30_000;

/**
 * Runs `action` holding the lock Pi takes on `file` (`auth.json`, `settings.json`: proper-lockfile's
 * `<file>.lock` folder), so a Pi process writing it meanwhile doesn't write over the change, or the
 * other way round.
 */
async function withPiLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  const lock = `${file}.lock`;
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const age = Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? 0);
    if (age < PI_LOCK_STALE_MS) throw new Error(`Pi is writing ${shownPath(file)} right now. Try again in a moment.`);
    await rmdir(lock).catch(() => undefined);
    await mkdir(lock);
  }
  try {
    return await action();
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

const mainWrites = new Mutex();

/**
 * Sets the Anthropic API key (`null` keeps the current one) and base URL of Pi's own login, in Pi's
 * own files, which `pi` in a terminal reads too: `anthropic` in `auth.json` (an OAuth sign-in to
 * Anthropic there is replaced by the key) and `providers.anthropic.baseUrl` in `models.json` (taken
 * out for Anthropic's own API). Each file is written where it really is, keeping its permissions,
 * after a copy of it as it was goes to ZeroSub's `backups/`. As for an API account, a kept key
 * only goes where it went before. Added accounts' files, made from these, are remade at their next sync.
 */
async function writeMainPiApi(config: { key: string | null; baseUrl: string | null }): Promise<void> {
  await mainWrites.run(async () => {
    const baseUrl = config.baseUrl?.trim() ? normalizeBaseUrl(config.baseUrl) : null;
    const typed = config.key?.trim() || null;
    const previousBase = await mainAnthropicBaseUrl();
    await withPiLock(mainAuthPath(), async () => {
      const authPath = await realpath(mainAuthPath()).catch(() => mainAuthPath());
      const auth = await readJson(authPath);
      if (auth !== undefined && !isObject(auth)) throw new Error(`${shownPath(mainAuthPath())} isn't a JSON object`);
      const current = auth?.anthropic;
      const kept = isObject(current) && current.type === "api_key" && typeof current.key === "string" && current.key.trim() ? current.key.trim() : null;
      const key = typed ?? kept;
      if (!key) throw new Error("Enter the API key");
      if (!typed && previousBase !== baseUrl) throw new Error("Enter the key again to use it with a different base URL");
      if (typed && typed !== kept) {
        if (auth) await backUp("auth", auth);
        const entry = isObject(current) && current.type === "api_key" ? { ...current } : {};
        const mode = (await stat(authPath).catch(() => null))?.mode;
        await writeJsonAtomic(authPath, { ...(auth ?? {}), anthropic: { ...entry, type: "api_key", key } }, mode === undefined ? 0o600 : mode & 0o777);
      }
    });
    if (previousBase !== baseUrl) {
      const modelsPath = await realpath(mainModelsPath()).catch(() => mainModelsPath());
      const models = await readJson(modelsPath);
      if (models !== undefined && !isObject(models)) throw new Error(`${shownPath(mainModelsPath())} isn't a JSON object`);
      if (models) await backUp("models", models);
      const next: Record<string, unknown> = { ...(models ?? {}) };
      const providers: Record<string, unknown> = isObject(next.providers) ? { ...next.providers } : {};
      const anthropic: Record<string, unknown> = isObject(providers.anthropic) ? { ...providers.anthropic } : {};
      if (baseUrl) anthropic.baseUrl = baseUrl;
      else delete anthropic.baseUrl;
      if (Object.keys(anthropic).length > 0) providers.anthropic = anthropic;
      else delete providers.anthropic;
      if (Object.keys(providers).length > 0) next.providers = providers;
      else delete next.providers;
      const mode = (await stat(modelsPath).catch(() => null))?.mode;
      await writeJsonAtomic(modelsPath, next, mode === undefined ? 0o600 : mode & 0o777);
    }
    forgetSyncs();
  });
}

// --------------------------------------------------------------------------- the account's script

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes the account's `zerosub.env`, which its `pi-<account>.sh` script reads: the proxy
 * variables its agents get in Paseo (its own proxy, else the CLI login's), so Pi run from the script
 * goes the same way, whatever the shell exports. Without a proxy it only says so, and the shell's
 * own settings stand, as the daemon's do for its agents. Readable only by you: a proxy can hold a
 * password. Only written when it changes.
 */
async function writeLaunchEnv(home: string, variables: Record<string, string>): Promise<void> {
  const lines = ["# Written by ZeroSub: the proxy this account's Pi agents use in Paseo. Don't edit: it's rewritten when that changes."];
  for (const [key, value] of Object.entries(variables)) lines.push(`export ${key}=${shellQuote(value)}`);
  const content = `${lines.join("\n")}\n`;
  const path = join(home, PI_LAUNCH_ENV);
  if ((await readFile(path, "utf8").catch(() => null)) === content) return;
  const temporary = join(home, `.${PI_LAUNCH_ENV}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

// --------------------------------------------------------------------------- adapter

/**
 * Pi, which Paseo runs as its built-in `pi` provider. The CLI login is Pi's own agent directory
 * (`~/.pi/agent`) with whatever it's signed in to. An added account is an Anthropic API key, with an
 * optional base URL and proxy, in an agent directory of its own (`PI_CODING_AGENT_DIR`) that shares
 * everything else with the CLI login's (see `preparePiHome`). Sessions are kept in the CLI login's
 * sessions folder whichever account opens them, so a conversation moves between accounts and stays
 * where Paseo looks for it after an account is removed.
 */
export class PiAdapter implements FamilyAdapter {
  readonly family = "pi" as const;
  /** Pi reopens a session from its file, whichever account it runs on. */
  readonly portable = true;
  /** Pi reports no usage; this only keeps the "no usage" note from being asked for often. */
  readonly usageSpacingMs = 60 * 60_000;
  /** Pi's own login's Anthropic key and base URL can be changed from its card. */
  readonly mainApi = true;

  async env(home: string | null, session?: { cwd: string }): Promise<EnvPatch> {
    const mainProxy = await readPiMainProxy();
    if (!home) return { PI_CODING_AGENT_DIR: null, ...(mainProxy ? proxyVariables(mainProxy, null) : {}) };
    const account = await readPiAccount(home);
    const patch: EnvPatch = { PI_CODING_AGENT_DIR: home };
    // Pi writes a new session in its agent directory's `sessions`, which is the CLI login's linked in,
    // so the file would be named through the account's home: Paseo resumes it by that name, which
    // goes when the account does. Pi is told the folder it would use for the CLI login instead.
    if (session && !(await sessionDirConfigured())) patch.PI_CODING_AGENT_SESSION_DIR = await piSessionDir(session.cwd);
    // Without a proxy of its own it goes through the CLI login's, as Pi on its folder does through the
    // shared settings; given as variables here, so nothing the agent inherits outranks it.
    const proxy = account.proxy ?? mainProxy;
    if (proxy) Object.assign(patch, proxyVariables(proxy, account.baseUrl));
    return patch;
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("pi");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  async prepareHome(home: string, wanted?: () => Promise<boolean>): Promise<void> {
    await preparePiHome(home, false, wanted);
    if (wanted && !(await wanted())) return;
    await this.writeLaunchEnv(home);
  }

  /** Brings the account's `zerosub.env` in step with the proxy its agents get (see `writeLaunchEnv`). */
  private async writeLaunchEnv(home: string): Promise<void> {
    const patch = await this.env(home);
    const variables: Record<string, string> = {};
    for (const key of [...PROXY_KEYS, ...NO_PROXY_KEYS]) {
      const value = patch[key];
      if (typeof value === "string") variables[key] = value;
    }
    await writeLaunchEnv(home, variables);
  }

  /**
   * Which of `homes` a Pi process runs on right now (started with that `PI_CODING_AGENT_DIR`: by
   * Paseo, or its script in a terminal), so its home isn't moved under it (see `Service.placeHomes`).
   */
  async homesInUse(homes: readonly string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (homes.length === 0) return found;
    await eachProcessEnvironment((line) => {
      for (const home of homesInEnvironment(line, homes, ["PI_CODING_AGENT_DIR"])) found.add(home);
    });
    return found;
  }

  /**
   * The CLI login always counts as signed in: Pi picks a sign-in per model from everything it has.
   * An added account is signed in while it holds a key; a refused key is learned from a failed turn.
   */
  async identity(home: string | null): Promise<Identity> {
    const signedIn = home ? Boolean((await readPiAccount(home)).key) : true;
    return { signedIn, email: null, plan: null, organization: null, identity: null };
  }

  async usage(): Promise<UsageRead> {
    return { fetchedAt: new Date().toISOString(), windows: [], error: "Pi doesn't report usage.", cached: false, resets: null };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Pi has no banked resets.", left: null };
  }

  api(home: string | null): Promise<ApiSummary | null> {
    return home ? readPiAccountApi(home) : readMainPiApi();
  }

  setApi(home: string | null, config: { key: string | null; baseUrl: string | null }, wanted?: () => Promise<boolean>): Promise<void> {
    if (!home) return writeMainPiApi({ key: config.key, baseUrl: config.baseUrl });
    return writePiAccountApi(home, { key: config.key, baseUrl: config.baseUrl }, wanted);
  }

  async proxyState(home: string | null): Promise<ProxyState> {
    if (!home) {
      const inSettings = await settingsProxy();
      return { own: inSettings, file: inSettings ? shownPath(mainSettingsPath()) : null, inherited: await inheritedPiProxy(ANTHROPIC_API, true) };
    }
    const account = await readPiAccount(home);
    return { own: account.proxy, file: null, inherited: await inheritedPiProxy(account.baseUrl ?? ANTHROPIC_API) };
  }

  async setProxy(home: string | null, proxy: string | null, wanted?: () => Promise<boolean>): Promise<void> {
    if (!home) return writePiMainProxy(proxy);
    await writePiAccountProxy(home, proxy, wanted);
    await this.writeLaunchEnv(home);
  }

  /**
   * The address Anthropic sees an account's requests come from, asked of Anthropic's own host the way
   * the account's Pi reaches it. Null for an account with another base URL: whatever is there
   * reaches Anthropic from its own address (for the CLI login, an Anthropic base URL in its `models.json`).
   */
  async egress(home: string | null): Promise<{ ip: string; country: string | null } | null> {
    const baseUrl = home ? (await readPiAccount(home)).baseUrl : await mainAnthropicBaseUrl();
    if (baseUrl && hostOf(baseUrl) !== hostOf(ANTHROPIC_API)) return null;
    const env: Record<string, string | undefined> = { ...process.env, ...providerEnv("pi") };
    for (const [key, value] of Object.entries(await this.env(home))) if (value !== null) env[key] = value;
    const response = await proxiedFetch(await piProxyFor(env, TRACE), TRACE, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const seen = parseTrace(await response.text());
    if (!seen) throw new Error("The answer didn't say");
    return seen;
  }

  async login(_home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    throw new Error("Pi accounts use an Anthropic API key: add one with Add account, or change its key from its card.");
  }

  async logout(_home: string): Promise<void> {
    // The key lives in the home itself, which is deleted next.
  }

  /** Pi's accounts are billed per use or are the CLI login, so there's no account to move to on a limit. */
  detectLimit(_event: TurnEvent): null {
    return null;
  }

  detectSignOut(event: TurnEvent): string | null {
    return detectPiSignOut(event);
  }
}
