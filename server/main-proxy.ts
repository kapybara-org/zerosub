import { readdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { forgetSyncs } from "./homes";
import { Mutex, readJson, writeJsonAtomic } from "./json-file";
import { dataDir, mainClaudeDir, shownPath } from "./paths";
import { providerEnv } from "./provider-env";
import { NO_PROXY_KEYS, PROXY_KEYS, bypassesProxy, noProxyFromEnv, proxyFromEnv, withClaudeNoProxy, withoutClaudeDomains } from "./proxy";

/**
 * Where the proxy set in ZeroSub for the CLI's own login is kept while `~/.claude/settings.json`
 * sets none. That file is the CLI login's settings, and every account's settings are made from it,
 * so a proxy isn't added to it: the CLI login's sessions, and the CLI processes ZeroSub starts for
 * it, get it as environment variables instead (see `mainProxyEnv`). When the file does set a proxy,
 * Claude Code applies it over those variables, so the CLI login's proxy is changed there instead
 * (see `writeMainProxy`).
 */
export function mainProxyPath(): string {
  return join(dataDir(), "cli-login.json");
}

async function readSavedProxy(): Promise<string | null> {
  const saved = await readJson(mainProxyPath());
  const proxy = saved && typeof saved === "object" && "proxy" in saved && typeof saved.proxy === "string" ? saved.proxy.trim() : "";
  return proxy || null;
}

function mainSettingsPath(): string {
  return join(mainClaudeDir(), "settings.json");
}

/** Main's settings file the way it's shown: under `~` when it's in the home folder. */
function mainSettingsName(): string {
  return shownPath(mainSettingsPath());
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** The `env` of `~/.claude/settings.json`, which Claude Code applies over the environment it starts with. */
export async function mainSettingsEnv(): Promise<Record<string, string>> {
  const settings = await readJson(mainSettingsPath());
  if (settings === undefined) return {};
  if (!isObject(settings)) throw new Error(`${mainSettingsName()} is not a JSON object`);
  const strings: Record<string, string> = {};
  if (isObject(settings.env)) for (const [key, value] of Object.entries(settings.env)) if (typeof value === "string") strings[key] = value;
  return strings;
}

/** The no-proxy variables in `settingsEnv` that send Anthropic or Claude traffic past any proxy. */
function bypassingClaude(settingsEnv: Readonly<Record<string, string>>): string[] {
  return NO_PROXY_KEYS.filter((key) => {
    const list = settingsEnv[key];
    return list !== undefined && withoutClaudeDomains(list) !== list.split(/[,\s]+/).filter(Boolean).join(",");
  });
}

/**
 * Why no proxy can be set for the CLI login: main's settings put Anthropic or Claude on a no-proxy
 * list, which Claude Code applies over the one ZeroSub starts it with. Null when one can.
 */
export async function mainProxyBlock(): Promise<string | null> {
  const keys = bypassingClaude(await mainSettingsEnv());
  if (keys.length === 0) return null;
  return `${mainSettingsName()} sets ${keys.join(" and ")} in its env with Anthropic or Claude on it, so Claude Code goes around any proxy for them. Take those entries out there first.`;
}

/**
 * The CLI login's own proxy: the one main's settings set, which Claude Code applies over anything
 * else, with `file` naming them; else the one set in ZeroSub. Null when it uses whatever it inherits.
 */
export async function readMainProxy(): Promise<{ proxy: string | null; file: string | null }> {
  const inSettings = proxyFromEnv(await mainSettingsEnv());
  if (inSettings) return { proxy: inSettings, file: mainSettingsName() };
  return { proxy: await readSavedProxy(), file: null };
}

/** How many copies of main's settings from before ZeroSub changed them are kept. */
const SETTINGS_BACKUPS = 5;
const SETTINGS_BACKUP = /^claude-settings-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

/**
 * Sets the proxy variables in main's settings (all four to `proxy`, or none with `null`), leaving
 * the rest as it is. It's written where it really is, so a settings file linked in from elsewhere
 * (dotfiles, say) stays linked, with its permissions; the file as it was is kept in ZeroSub's
 * `backups/` first.
 */
async function writeProxyToMainSettings(proxy: string | null): Promise<void> {
  const path = await realpath(mainSettingsPath());
  const text = await readFile(path, "utf8");
  let settings: unknown;
  try {
    settings = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${mainSettingsName()} isn't valid JSON`);
  }
  if (!isObject(settings)) throw new Error(`${mainSettingsName()} is not a JSON object`);
  const env: Record<string, unknown> = isObject(settings.env) ? { ...settings.env } : {};
  for (const key of PROXY_KEYS) {
    if (proxy) env[key] = proxy;
    else delete env[key];
  }
  if (proxy) {
    const stringEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
    const noProxy = withClaudeNoProxy(withoutClaudeDomains(noProxyFromEnv(stringEnv)));
    for (const key of NO_PROXY_KEYS) env[key] = noProxy;
  }

  const backups = join(dataDir(), "backups");
  await writeJsonAtomic(join(backups, `claude-settings-${new Date().toISOString().replace(/[:.]/g, "-")}.json`), settings, { durable: false });
  const kept = (await readdir(backups)).filter((name) => SETTINGS_BACKUP.test(name)).sort();
  for (const name of kept.slice(0, -SETTINGS_BACKUPS)) await rm(join(backups, name), { force: true });

  await writeJsonAtomic(path, { ...settings, env }, { mode: (await stat(path)).mode & 0o777 });
  // Every added home's settings are made from main's: have the next sync remake them.
  forgetSyncs();
}

const writes = new Mutex();

/**
 * Sets (or clears, with `null`) the CLI login's proxy: in main's settings when they set one, which
 * every account without a proxy of its own (and `claude` in a terminal) then uses too, else in
 * ZeroSub's own file. Refused while main's settings send Anthropic past any proxy (see
 * `mainProxyBlock`).
 */
export function writeMainProxy(proxy: string | null): Promise<void> {
  return writes.run(async () => {
    const block = proxy ? await mainProxyBlock() : null;
    if (block) throw new Error(block);
    if (proxyFromEnv(await mainSettingsEnv())) {
      await writeProxyToMainSettings(proxy);
      await rm(mainProxyPath(), { force: true });
      return;
    }
    if (proxy) await writeJsonAtomic(mainProxyPath(), { proxy });
    else await rm(mainProxyPath(), { force: true });
  });
}

/**
 * What the CLI login is started with for the proxy set in ZeroSub, nothing without one or while
 * main's settings set a proxy (Claude Code would go by theirs): all four proxy variables, so nothing
 * it inherits outranks the proxy, and the no-proxy list it would otherwise have (from the daemon's
 * environment, the Claude provider's `env` in Paseo's config and main's settings) without the
 * entries that would send Anthropic or Claude traffic past it, plus localhost, 127.0.0.1 and
 * `downloads.claude.ai`, as for an account's own proxy (see `accountSettings` in server/homes.ts).
 */
export async function mainProxyEnv(): Promise<Record<string, string>> {
  const settings = await mainSettingsEnv();
  const proxy = proxyFromEnv(settings) ? null : await readSavedProxy();
  if (!proxy) return {};
  const noProxy = withClaudeNoProxy(withoutClaudeDomains(noProxyFromEnv({ ...process.env, ...providerEnv("claude"), ...settings })));
  const env: Record<string, string> = {};
  for (const key of PROXY_KEYS) env[key] = proxy;
  for (const key of NO_PROXY_KEYS) env[key] = noProxy;
  return env;
}

/**
 * The proxy an account's Claude Code reaches Anthropic through when it has none of its own, and
 * where that's set: main's settings, which every added account's are made from, over the Claude
 * provider's `env` in Paseo's config, over the daemon's environment. For the CLI login (`main`),
 * a proxy in main's settings is its own, so only the other two count. Null when it goes direct.
 */
export async function inheritedClaudeProxy(main = false): Promise<{ proxy: string; from: string } | null> {
  const provider = providerEnv("claude");
  const settings = { ...(await mainSettingsEnv()) };
  // As it would be once the CLI login's own is taken out of main's settings.
  if (main && proxyFromEnv(settings)) for (const key of PROXY_KEYS) delete settings[key];
  const env: Record<string, string | undefined> = { ...process.env, ...provider, ...settings };
  // Claude Code's order: the first proxy variable set wins.
  const key = PROXY_KEYS.find((name) => env[name]?.trim());
  if (!key || bypassesProxy(noProxyFromEnv(env), "https://api.anthropic.com")) return null;
  const from = key in settings ? mainSettingsName() : key in provider ? "the Claude provider's env in Paseo's config" : "the daemon's environment";
  return { proxy: env[key]!.trim(), from };
}
