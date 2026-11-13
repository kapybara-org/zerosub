import { realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ApiSummary, LoginMethod } from "../shared/model";
import type { EnvPatch, FamilyAdapter, Identity, LoginHandle, ProxyState, RedeemReply, TurnEvent, UsageRead } from "./adapter";
import { providerCommand } from "./binaries";
import { preparePiHome, readPiAccount, readPiAccountApi, writePiAccountApi, writePiAccountProxy } from "./homes";
import { readJson } from "./json-file";
import { detectPiSignOut } from "./limits";
import { mainPiDir, shownPath } from "./paths";
import { run } from "./process";
import { providerEnv } from "./provider-env";
import { NO_PROXY_KEYS, PROXY_KEYS, bypassesProxy, noProxyFromEnv, withRequiredNoProxy, withoutDomains } from "./proxy";

const ANTHROPIC_API = "https://api.anthropic.com";
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

/** `httpProxy` in Pi's own `settings.json`, which Pi applies when the environment names no proxy. Only read, never written. */
async function settingsProxy(): Promise<string | null> {
  const settings = await readJson(mainSettingsPath()).catch(() => undefined);
  return isObject(settings) && typeof settings.httpProxy === "string" && settings.httpProxy.trim() ? settings.httpProxy.trim() : null;
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
  const settings = await readJson(mainSettingsPath()).catch(() => undefined);
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
  if (bypassesProxy(noProxyFromEnv(env), target)) return null;
  const key = PROXY_KEYS.find((name) => env[name]?.trim());
  if (key) return { proxy: env[key]!.trim(), from: key in provider ? "the Pi provider's env in Paseo's config" : "the daemon's environment" };
  const own = await settingsProxy();
  return own ? { proxy: own, from: `httpProxy in ${shownPath(mainSettingsPath())}` } : null;
}

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

  async env(home: string | null, session?: { cwd: string }): Promise<EnvPatch> {
    // The CLI login runs as Paseo would run it without ZeroSub.
    if (!home) return {};
    const account = await readPiAccount(home);
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

  prepareHome(home: string, wanted?: () => Promise<boolean>): Promise<void> {
    return preparePiHome(home, false, wanted);
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

  api(home: string): Promise<ApiSummary | null> {
    return readPiAccountApi(home);
  }

  setApi(home: string, config: { key: string | null; baseUrl: string | null }, wanted?: () => Promise<boolean>): Promise<void> {
    return writePiAccountApi(home, { key: config.key, baseUrl: config.baseUrl }, wanted);
  }

  async proxyState(home: string): Promise<ProxyState> {
    const account = await readPiAccount(home);
    return { own: account.proxy, inherited: account.proxy ? null : await inheritedPiProxy(account.baseUrl ?? ANTHROPIC_API) };
  }

  setProxy(home: string, proxy: string | null, wanted?: () => Promise<boolean>): Promise<void> {
    return writePiAccountProxy(home, proxy, wanted);
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
