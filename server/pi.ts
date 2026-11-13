import { mkdir, readdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import type { ApiSummary, LoginMethod } from "../shared/model";
import type { EnvPatch, FamilyAdapter, Identity, LoginHandle, ProxyState, RedeemReply, TurnEvent, UsageRead } from "./adapter";
import { providerCommand } from "./binaries";
import { clearTextProviders, forgetSyncs, normalizeBaseUrl, piLiteral, preparePiHome, readPiAccount, readPiOwnJson, readPiAccountApi, readPiAccountForAgents, writePiAccountApi, writePiAccountProxy } from "./homes";
import { PI_LAUNCH_ENV } from "./launchers";
import { Mutex, readJson, writeJsonAtomic } from "./json-file";
import { eachProcessEnvironment, homesInEnvironment, parseTrace } from "./processes";
import { detectPiSignOut } from "./limits";
import { dataDir, mainPiDir, shownPath } from "./paths";
import { run } from "./process";
import { providerEnv } from "./provider-env";
import { NO_PROXY_KEYS, PROXY_KEYS, bypassesProxy, noProxyFromEnv, proxiedFetch, proxyFromEnv, withRequiredNoProxy, withoutDomains } from "./proxy";

const ANTHROPIC_API = "https://api.anthropic.com";
/** Anthropic's edge answers this with the address it sees the request come from (see `PiAdapter.egress`). */
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

function mainSettingsPath(): string {
  return join(mainPiDir(), "settings.json");
}

/**
 * `httpProxy` in Pi's own `settings.json`, which Pi applies when the environment names no proxy. Only
 * written when the user sets the CLI login's proxy from its card (see `writePiMainProxy`).
 */
async function settingsProxy(): Promise<string | null> {
  const settings = await readPiOwnJson(mainSettingsPath()).catch(() => undefined);
  return isObject(settings) && typeof settings.httpProxy === "string" && settings.httpProxy.trim() ? settings.httpProxy.trim() : null;
}

/**
 * The folder Pi keeps the CLI login's sessions for `cwd` in: `sessions/--<cwd with / as ->--` in its
 * agent directory, as Pi names it (`getDefaultSessionDirPath`, 1.4.0 to 1.5.2). Pi names it after its
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
  const settings = await readPiOwnJson(mainSettingsPath()).catch(() => undefined);
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
 * The proxy an added account's Pi goes through without one of its own, and where that's set: the Pi
 * provider's `env` in Paseo's config over the daemon's environment, else `httpProxy` in Pi's own
 * settings, which the account shares. Null when it goes direct, or the no-proxy list sends `target`
 * past it.
 */
export async function inheritedPiProxy(target = ANTHROPIC_API): Promise<{ proxy: string; from: string } | null> {
  const provider = providerEnv("pi");
  const env: Record<string, string | undefined> = { ...process.env, ...provider };
  if (bypassesProxy(env.no_proxy ?? env.NO_PROXY ?? null, target)) return null;
  const key = PROXY_KEYS.find((name) => env[name]?.trim());
  if (key) return { proxy: env[key]!.trim(), from: key in provider ? "the Pi provider's env in Paseo's config" : "the daemon's environment" };
  const own = await settingsProxy();
  return own ? { proxy: own, from: `httpProxy in ${shownPath(mainSettingsPath())}` } : null;
}

/**
 * The proxy a Pi process reaches `target` through, from the environment it starts with, else Pi's
 * `httpProxy` setting, then the no-proxy list; null when it goes direct.
 */
async function piProxyFor(env: Record<string, string | undefined>, target: string): Promise<string | null> {
  const proxy = proxyFromEnv(env) ?? (await settingsProxy());
  return proxy && !bypassesProxy(env.no_proxy ?? env.NO_PROXY ?? null, target) ? proxy : null;
}

// --------------------------------------------------------------------------- the CLI login's files
//
// Only ever written when the user changes the CLI login's key, base URL or proxy from its card:
// nothing else in ZeroSub writes Pi's own files.

function mainAuthPath(): string {
  return join(mainPiDir(), "auth.json");
}

function mainModelsPath(): string {
  return join(mainPiDir(), "models.json");
}

/** The base URL the CLI login's `models.json` sends Anthropic's requests to, if it sets one. */
async function mainAnthropicBaseUrl(): Promise<string | null> {
  const models = await readPiOwnJson(mainModelsPath(), true).catch(() => undefined);
  const providers = isObject(models) && isObject(models.providers) ? models.providers : {};
  const anthropic = isObject(providers.anthropic) ? providers.anthropic : {};
  return typeof anthropic.baseUrl === "string" && anthropic.baseUrl.trim() ? anthropic.baseUrl.trim() : null;
}

/** Keys shorter than this get no hint, as for Claude API accounts. */
const KEY_HINT_MIN_LENGTH = 12;

/** The Anthropic API key Pi's own login keeps in its `auth.json`; null when it has none (or signs in to Anthropic with OAuth). */
async function mainAnthropicKey(): Promise<string | null> {
  const auth = await readPiOwnJson(mainAuthPath()).catch(() => undefined);
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
 * other way round. For a file that's a link, Pi takes the lock beside the link (`auth.json` to
 * 1.5.0, `settings.json` still in 1.5.2) or beside the file it points to (`auth.json` from 1.5.1),
 * so both are held: whichever Pi runs is kept out.
 */
async function withPiLock<T>(file: string, action: () => Promise<T>): Promise<T> {
  // Both named through the real folder, so a folder reached through a link isn't taken for two.
  const beside = join(await realpath(dirname(file)).catch(() => dirname(file)), basename(file));
  const real = await realpath(file).catch(() => beside);
  const locks = [...new Set([`${beside}.lock`, `${real}.lock`])];
  const held: string[] = [];
  try {
    for (const lock of locks) {
      try {
        await mkdir(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const age = Date.now() - ((await stat(lock).catch(() => null))?.mtimeMs ?? 0);
        if (age < PI_LOCK_STALE_MS) throw new Error(`Pi is writing ${shownPath(file)} right now. Try again in a moment.`);
        await rmdir(lock).catch(() => undefined);
        await mkdir(lock);
      }
      held.push(lock);
    }
    return await action();
  } finally {
    for (const lock of held.reverse()) await rmdir(lock).catch(() => undefined);
  }
}

/**
 * Writes one of Pi's own files where it really is (a link to it, from a dotfiles repository say, is
 * followed rather than replaced). It keeps its permissions, except that a file holding a secret (a
 * key, or a proxy with a password) is never left readable by others: it's written 0600 or stricter.
 */
async function writePiFile(path: string, value: unknown, secret: boolean): Promise<void> {
  const real = await realpath(path).catch(() => path);
  const mode = (await stat(real).catch(() => null))?.mode;
  const kept = mode === undefined ? 0o600 : mode & 0o777;
  await writeJsonAtomic(real, value, { mode: secret ? kept & 0o600 : kept });
}

/** Whether a proxy URL holds a password (or a user name, which may be one). */
function hasCredentials(proxy: string): boolean {
  try {
    const url = new URL(proxy);
    return url.username !== "" || url.password !== "";
  } catch {
    return true;
  }
}

const mainWrites = new Mutex();

/**
 * Sets (or clears, with `null`) Pi's own login's proxy as `httpProxy` in its `settings.json`, which
 * Pi applies wherever it runs on that login while its environment names no proxy, and which added
 * accounts without a proxy of their own share. ZeroSub gives Pi agents nothing for it: Pi reads it
 * itself. Like an added account's, a new proxy is refused while a key or sign-in it would carry goes
 * over plain http://, wherever Pi takes it from (see `clearTextProviders`): to this machine too,
 * unless the no-proxy list keeps it direct, since Pi adds nothing to that list. The file is backed
 * up first and written under Pi's own lock.
 */
async function writePiMainProxy(proxy: string | null): Promise<void> {
  await mainWrites.run(async () => {
    if (proxy && proxy !== (await settingsProxy())) {
      const exposed = await clearTextProviders(true);
      if (exposed.includes("anthropic")) {
        throw new Error(
          "Pi's own login sends its Anthropic key or sign-in over plain http://, which a proxy can read (Pi sends even this machine's addresses through it unless NO_PROXY lists them). Use an https:// base URL for Anthropic and its models (in Pi's models.json), or list that host in NO_PROXY, before setting a proxy.",
        );
      }
      if (exposed.length > 0) {
        throw new Error(
          `Pi's own models.json sends the key or sign-in for ${exposed.join(", ")} over plain http://, so a proxy could read it (Pi sends even this machine's addresses through it unless NO_PROXY lists them). Use https:// there, or list those hosts in NO_PROXY, before setting a proxy.`,
        );
      }
    }
    await withPiLock(mainSettingsPath(), async () => {
      const settings = await readPiOwnJson(await realpath(mainSettingsPath()).catch(() => mainSettingsPath()));
      if (settings !== undefined && !isObject(settings)) throw new Error(`${shownPath(mainSettingsPath())} isn't a JSON object`);
      if (settings === undefined && !proxy) return;
      const next: Record<string, unknown> = { ...(settings ?? {}) };
      if (proxy) next.httpProxy = proxy;
      else delete next.httpProxy;
      if (settings) await backUp("settings", settings);
      await writePiFile(mainSettingsPath(), next, proxy !== null && hasCredentials(proxy));
    });
    // Added accounts with a proxy of their own have settings made from these.
    forgetSyncs();
  });
}

/**
 * Sets the Anthropic API key (`null` keeps the current one) and base URL of Pi's own login, in Pi's
 * own files, which `pi` in a terminal reads too: `anthropic` in `auth.json` (an OAuth sign-in to
 * Anthropic there is replaced by the key) and `providers.anthropic.baseUrl` in `models.json` (taken
 * out for Anthropic's own API). Each is backed up first; `auth.json` is written under Pi's lock and
 * never left readable by others. As for an added account, a kept key only goes where it went before.
 */
async function writeMainPiApi(config: { key: string | null; baseUrl: string | null }): Promise<void> {
  await mainWrites.run(async () => {
    const baseUrl = config.baseUrl?.trim() ? normalizeBaseUrl(config.baseUrl) : null;
    const typed = config.key?.trim() || null;
    const previousBase = await mainAnthropicBaseUrl();
    // Read before the key is written, so a models.json that can't take the new base URL leaves the
    // key as it was too: a new key must never go to the old address. Read strictly: it's written
    // back as plain JSON, and the comments Pi allows there would be lost.
    const models =
      previousBase === baseUrl
        ? undefined
        : await readJson(await realpath(mainModelsPath()).catch(() => mainModelsPath())).catch(() => {
            throw new Error(`${shownPath(mainModelsPath())} isn't plain JSON (it may have comments), so ZeroSub leaves it as it is. Change the Anthropic base URL there by hand.`);
          });
    if (models !== undefined && !isObject(models)) throw new Error(`${shownPath(mainModelsPath())} isn't a JSON object`);
    await withPiLock(mainAuthPath(), async () => {
      const auth = await readPiOwnJson(await realpath(mainAuthPath()).catch(() => mainAuthPath()));
      if (auth !== undefined && !isObject(auth)) throw new Error(`${shownPath(mainAuthPath())} isn't a JSON object`);
      const current = auth?.anthropic;
      const kept = isObject(current) && current.type === "api_key" && typeof current.key === "string" && current.key.trim() ? current.key.trim() : null;
      const key = typed ?? kept;
      if (!key) throw new Error("Enter the API key");
      if (!typed && previousBase !== baseUrl) throw new Error("Enter the key again to use it with a different base URL");
      // Stored escaped, as an added account's is (see `piLiteral`), so Pi reads it as typed.
      if (typed && piLiteral(typed) !== kept) {
        if (auth) await backUp("auth", auth);
        const entry = isObject(current) && current.type === "api_key" ? { ...current } : {};
        await writePiFile(mainAuthPath(), { ...(auth ?? {}), anthropic: { ...entry, type: "api_key", key: piLiteral(typed) } }, true);
      }
    });
    if (previousBase !== baseUrl) {
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
      await writePiFile(mainModelsPath(), next, false);
    }
    forgetSyncs();
  });
}

// --------------------------------------------------------------------------- the account's script

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Writes the account's `zerosub.env`, which its `pi-<account>.sh` script reads: the proxy variables
 * its agents get in Paseo (its own proxy), so Pi run from the script goes the same way, whatever the
 * shell exports. Without a proxy it only says so, and the shell's own settings stand, as the
 * daemon's do for its agents. Readable only by you: a proxy can hold a password. Only written when
 * it changes.
 */
async function writeLaunchEnv(home: string, variables: Record<string, string>): Promise<void> {
  const lines = ["# Written by ZeroSub: the proxy and environment this account's Pi agents get in Paseo. Don't edit: it's rewritten when that changes."];
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
 * (`~/.pi/agent`) with whatever it's signed in to, and ZeroSub leaves it as it is. An added account
 * is an Anthropic API key, with an optional base URL and proxy, in an agent directory of its own
 * (`PI_CODING_AGENT_DIR`, in ZeroSub's `homes/`) that shares everything else with the CLI login's
 * (see `preparePiHome`). Sessions are kept in the CLI login's sessions folder whichever account
 * opens them, so a conversation moves between accounts and stays where Paseo looks for it after an
 * account is removed.
 */
/**
 * The variables that would have an added account's agents send something other than its own key:
 * - the ones Pi reads Anthropic's key or token from (`getApiKeyEnvVars` in pi-ai);
 * - `ANTHROPIC_CUSTOM_HEADERS`, which the Anthropic SDK adds to every request after the key, so an
 *   `x-api-key` or `authorization` line there replaces it;
 * - the workload identity federation ones, which Pi uses for Anthropic when no key comes out
 *   (`getAnthropicFederation` in pi-ai) and would send the token it gets for them.
 * Blank is unset to both Pi and the SDK.
 */
const PI_ANTHROPIC_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_CUSTOM_HEADERS",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_WORKSPACE_ID",
];

export class PiAdapter implements FamilyAdapter {
  readonly family = "pi" as const;
  /** Pi reopens a session from its file, whichever account it runs on. */
  readonly portable = true;
  /** Pi reports no usage; this only keeps the "no usage" note from being asked for often. */
  readonly usageSpacingMs = 60 * 60_000;
  /** Pi's own login's Anthropic key and base URL can be changed from its card. */
  readonly mainApi = true;

  async env(home: string | null, session?: { cwd: string }): Promise<EnvPatch> {
    // The CLI login runs as Paseo would run it without ZeroSub.
    if (!home) return {};
    // Throws while the folder is being moved: routing then opens the agent on the CLI login rather
    // than on the account without its proxy (see `readPiAccountForAgents`).
    const account = await readPiAccountForAgents(home);
    const patch: EnvPatch = { PI_CODING_AGENT_DIR: home };
    // Pi would send what these give to the account's base URL, in place of or on top of the account's
    // key: an added account's agents only ever use its own key. Always blanked,
    // since they can come from the Pi provider's `env` in Paseo's config as well as the daemon's.
    for (const key of PI_ANTHROPIC_ENV) patch[key] = "";
    // Pi writes a new session in its agent directory's `sessions`, which is the CLI login's linked in,
    // so the file would be named through the account's home: Paseo resumes it by that name, which
    // goes when the account does. Pi is told the folder it would use for the CLI login instead.
    if (session && !(await sessionDirConfigured())) patch.PI_CODING_AGENT_SESSION_DIR = await piSessionDir(session.cwd);
    // Given as variables, so nothing the agent inherits outranks the account's own proxy. Without one,
    // it inherits whatever the daemon and Pi's own settings give it, as Pi does without ZeroSub.
    if (account.proxy) Object.assign(patch, proxyVariables(account.proxy, account.baseUrl));
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

  /**
   * Brings the account's `zerosub.env` in step with the proxy its agents get, and the Anthropic
   * variables they get blanked (`PI_ANTHROPIC_ENV`), so nothing in a shell's environment stands in for
   * the account's key or goes along with it (see `writeLaunchEnv`).
   */
  private async writeLaunchEnv(home: string): Promise<void> {
    const patch = await this.env(home);
    const variables: Record<string, string> = {};
    for (const key of [...PI_ANTHROPIC_ENV, ...PROXY_KEYS, ...NO_PROXY_KEYS]) {
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
      const own = await settingsProxy();
      return { own, file: own ? shownPath(mainSettingsPath()) : null, inherited: own ? null : await inheritedPiProxy(ANTHROPIC_API) };
    }
    const account = await readPiAccount(home);
    return { own: account.proxy, file: null, inherited: account.proxy ? null : await inheritedPiProxy(account.baseUrl ?? ANTHROPIC_API) };
  }

  async setProxy(home: string | null, proxy: string | null, wanted?: () => Promise<boolean>): Promise<void> {
    if (!home) return writePiMainProxy(proxy);
    await writePiAccountProxy(home, proxy, wanted, (baseUrl) => inheritedPiProxy(baseUrl ?? ANTHROPIC_API));
    await this.writeLaunchEnv(home);
  }

  /**
   * The address Anthropic sees an added account's requests come from, asked of Anthropic's own host
   * the way the account's Pi reaches it. Null for an account with another base URL (whatever is there
   * reaches Anthropic from its own address), and for the CLI login, which ZeroSub never checks.
   */
  async egress(home: string | null): Promise<{ ip: string; country: string | null } | null> {
    if (!home) return null;
    const { baseUrl } = await readPiAccount(home);
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
