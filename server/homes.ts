import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Mutex, readJson } from "./json-file";
import { isOwnHome, mainClaudeDir, mainClaudeGlobalConfig, mainCodexHome, mainPiDir } from "./paths";
import { providerEnv } from "./provider-env";
import { NO_PROXY_KEYS, PROXY_KEYS, REQUIRED_NO_PROXY, bypassesProxy, maskProxy, noProxyFromEnv, proxyFromEnv, withClaudeNoProxy, withoutClaudeDomains } from "./proxy";
import type { ApiKeyKind, ApiSummary, TrafficSwitches } from "../shared/model";

/**
 * A managed account home is a real directory holding that account's own credentials and account
 * caches, with every other entry symlinked to the CLI's main home. Settings, skills, plugins, MCP
 * config and — crucially — conversation history stay shared, so an agent can move between accounts
 * and Paseo still finds its transcript.
 */
interface OverlaySpec {
  main: string;
  /** Directories created in main up front so they are shared rather than created per account. */
  shareDirs: readonly string[];
  /** Shared entries a home may still hold as its own folder from before they were shared; see `retireFolder`. */
  retireFolders?: readonly string[];
  isPrivate(name: string): boolean;
}

const SYNC_TTL_MS = 30_000;
const lastSync = new Map<string, number>();

/** Has the next sync of every home run in full: main's settings, which theirs are made from, changed. */
export function forgetSyncs(): void {
  lastSync.clear();
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function syncOverlay(home: string, spec: OverlaySpec): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(spec.main, { recursive: true, mode: 0o700 });
  for (const directory of spec.shareDirs) await mkdir(join(spec.main, directory), { recursive: true });
  // A home that isn't ZeroSub's own (see `isOwnHome`) is the user's: a link there is only changed or
  // dropped when it points into main, as the ones made here do. One the user made elsewhere stays.
  const own = await isOwnHome(home);
  const mains = [resolve(spec.main), await realpath(spec.main).catch(() => resolve(spec.main))];
  const ours = async (link: string) => {
    if (own) return true;
    const raw = await readlink(link).catch(() => null);
    if (raw === null) return false;
    const pointsAt = resolve(home, raw);
    return mains.some((main) => {
      const inside = relative(main, pointsAt);
      return inside !== "" && !inside.startsWith("..") && !isAbsolute(inside);
    });
  };

  for (const name of await readdir(spec.main)) {
    if (name === ".DS_Store" || spec.isPrivate(name)) continue;
    const link = join(home, name);
    // Point at the real file: Claude Code's atomic writer follows exactly one symlink, so linking to
    // a dotfiles symlink in main would make it replace the user's symlink with a plain file.
    const target = await realpath(join(spec.main, name)).catch(() => null);
    if (!target) continue;
    const current = await lstat(link).catch(() => null);
    if (current?.isSymbolicLink()) {
      if ((await readlink(link)) === target || !(await ours(link))) continue;
      await unlink(link);
    } else if (current) {
      // Created here by the CLI; leave it alone, unless it's one that's shared now.
      if (!current.isDirectory() || !spec.retireFolders?.includes(name) || !(await retireFolder(link, target))) continue;
    }
    const targetStat = await stat(target).catch(() => null);
    if (!targetStat) continue;
    try {
      await symlink(target, link, process.platform === "win32" && targetStat.isDirectory() ? "junction" : undefined);
    } catch (error) {
      console.warn(`[ZeroSub] could not share ${name} with ${home}`, error instanceof Error ? error.message : error);
    }
  }

  // Drop links whose target disappeared from main.
  for (const name of await readdir(home)) {
    const link = join(home, name);
    const current = await lstat(link).catch(() => null);
    if (current?.isSymbolicLink() && !(await exists(link)) && (await ours(link))) await unlink(link).catch(() => undefined);
  }
}

/**
 * Clears a home's own folder out of the way of the link to `target`, its counterpart in main, and
 * says whether it did. An empty one just goes. One with anything in it is copied into `target`,
 * where a file of the same name stays as it is, then renamed to `<folder>.bak-<time>` beside it, so
 * every file is still there. When the copy fails the folder stays as it was for the next sync.
 */
async function retireFolder(folder: string, target: string): Promise<boolean> {
  if ((await realpath(folder).catch(() => null)) === target) return false; // It's main's own.
  if (await rmdir(folder).then(() => true, () => false)) return true;
  try {
    await cp(folder, target, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, force: false, errorOnExist: false });
    await rename(folder, `${folder}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    return true;
  } catch (error) {
    console.warn(`[ZeroSub] could not move ${folder} into ${target}`, error instanceof Error ? error.message : error);
    return false;
  }
}

/**
 * Deletes a managed home. Its top level holds symlinks into the user's real CLI home, so those are
 * unlinked first; nothing outside ZeroSub's own directory is ever followed or removed, and a home
 * that isn't its own (see `isOwnHome`) is left as it is. It holds the home's lock, so a sync never
 * puts entries back while the home is being deleted.
 */
export function removeHome(home: string): Promise<void> {
  return withHome(home, async () => {
    if (!(await isOwnHome(home))) return;
    // Checked again right here: a link put in its place is never followed into the folder it points at.
    const entry = await lstat(home).catch(() => null);
    if (!entry?.isDirectory()) return;
    await removeTree(home);
  });
}

/**
 * Moves a home's folder from `from` to `to`, which mustn't exist yet, then runs `commit` (saving
 * where its account's home is now) while it still holds both homes' locks: a sync of `from` waiting
 * meanwhile then finds its account gone from there and never makes the folder again. When `commit`
 * fails the folder goes back. Onto another disk the folder is copied, links as they are, and `from`
 * only deleted once `commit` worked.
 */
export function moveHome(from: string, to: string, commit: () => Promise<void>): Promise<void> {
  return withHome(from, () =>
    withHome(to, async () => {
      const entry = await lstat(from).catch(() => null);
      if (!entry?.isDirectory()) throw new Error(`${from} isn't a folder`);
      if (await lstat(to).catch(() => null)) throw new Error(`${to} is already there`);
      await mkdir(dirname(to), { recursive: true, mode: 0o700 });
      const copied = await moveFolder(from, to);
      try {
        await commit();
      } catch (error) {
        if (copied) await rm(to, { recursive: true, force: true });
        else await rename(to, from);
        throw error;
      }
      if (copied) await removeTree(from);
      for (const synced of [lastMcpSync, lastMcpKeys] as Map<string, unknown>[]) {
        if (synced.has(from)) synced.set(to, synced.get(from));
        synced.delete(from);
      }
      lastSync.delete(from);
    }),
  );
}

/** Renames `from` to `to`, or copies it there when that's another disk; says whether it copied. */
async function moveFolder(from: string, to: string): Promise<boolean> {
  try {
    await rename(from, to);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
  }
  try {
    await cp(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true, errorOnExist: true, force: false });
  } catch (error) {
    await rm(to, { recursive: true, force: true });
    throw error;
  }
  return true;
}

/** Deletes a folder whose top level may link into main: the links go first, never followed. */
async function removeTree(folder: string): Promise<void> {
  for (const name of await readdir(folder).catch(() => [] as string[])) {
    const path = join(folder, name);
    if ((await lstat(path).catch(() => null))?.isSymbolicLink()) await unlink(path).catch(() => undefined);
  }
  await rm(folder, { recursive: true, force: true });
}

/** Atomic-write leftovers and scratch files: never worth sharing. */
function isTemporary(name: string): boolean {
  return name.startsWith("..") || name.startsWith(".tmp") || /\.tmp(?:$|[-.])/.test(name);
}

// --------------------------------------------------------------------------- Claude

/** The account's own settings, layered over main's `settings.json`. Claude Code never writes it. */
export const ACCOUNT_SETTINGS = "settings.account.json";

/**
 * Per-account entries, from Claude Code's own split between configuration and state: credentials,
 * the global config (it holds `oauthAccount`), account caches, org policy, telemetry and locks.
 * `settings.json` is generated per account from main's plus the account's own overrides.
 */
const CLAUDE_PRIVATE = new Set([
  ".credentials.json",
  "settings.json",
  ACCOUNT_SETTINGS,
  ".config.json",
  ".oauth_refresh.lock",
  ".storage-write",
  ".session_ingress_token",
  ".update.lock",
  ".cc-writes",
  "backups",
  "statsig",
  "telemetry",
  "cache",
  "usage-data",
  "stats-cache.json",
  "logs",
  "debug",
  "traces",
  "startup-perf",
  "hfi-auth.json",
  "mcp-needs-auth-cache.json",
  "mcp-discovery-cache",
  "gh-pr-status-cache.json",
  "jobs",
  "teams",
  "ide",
  "local",
  "ccr",
  "bridge-spawn",
  "active-time.json",
  "server-sessions.json",
  "server.lock",
  "computer-use.lock",
  "api-dumps",
  "dump-prompts",
  "feedback",
  "feedback-bundles",
  "antproto.json",
  "uploads",
  "shares",
  "state",
  "chrome",
  "downloads",
  "storage-v2",
  "systemd",
  "seed-admin",
  "scratch",
  "remote",
  "local-settings",
  "project-settings",
  "file-transfers",
  "mcp-skill-archives",
  "loop.md",
]);

function claudePrivate(name: string): boolean {
  return (
    CLAUDE_PRIVATE.has(name) ||
    isTemporary(name) ||
    name.startsWith(".claude.json") ||
    name.startsWith("remote-settings") ||
    name.startsWith("policy-limits") ||
    name.startsWith("daemon") ||
    name.endsWith(".lock")
  );
}

/** Account identity and account-scoped caches in `.claude.json`; never copied between accounts. */
function isAccountKey(key: string): boolean {
  return (
    key === "oauthAccount" ||
    key === "primaryApiKey" ||
    key === "customApiKeyResponses" ||
    key === "userID" ||
    key === "anonymousId" ||
    /cache/i.test(key) ||
    /subscription/i.test(key)
  );
}

/** Per-project MCP and trust settings kept in step with the main login. */
const SHARED_PROJECT_KEYS = [
  "mcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "enableAllProjectMcpServers",
  "mcpContextUris",
  "allowedTools",
  "hasTrustDialogAccepted",
] as const;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Brings main's value into an account's copy without discarding what the account added itself:
 * objects merge (main wins; entries main removed since the last sync are dropped), lists union,
 * and a `true` from main is adopted.
 */
export function mergeShared(current: unknown, main: unknown, removedKeys: ReadonlySet<string> = new Set()): unknown {
  if (isObject(main)) {
    const merged: Json = isObject(current) ? { ...current } : {};
    for (const key of removedKeys) if (!(key in main)) delete merged[key];
    return Object.assign(merged, main);
  }
  if (Array.isArray(main)) {
    const union = Array.isArray(current) ? [...current] : [];
    for (const entry of main) if (!union.some((existing) => JSON.stringify(existing) === JSON.stringify(entry))) union.push(entry);
    return union;
  }
  if (typeof main === "boolean") return main || current === true;
  return main === undefined ? current : main;
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * One of Pi's own files as Pi reads it, so nothing Pi acts on is hidden from ZeroSub: a byte order
 * mark is dropped, and in `models.json` (`comments`) so are `//` comments and trailing commas
 * (`stripJsonComments` in Pi, the same from 1.4.0 to 1.5.2). Undefined without the file; throws when Pi couldn't parse it either.
 */
export async function readPiOwnJson(path: string, comments = false): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  if (comments) {
    text = text
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
      .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail: string | undefined) => tail ?? (match[0] === '"' ? match : ""));
  }
  return JSON.parse(text) as unknown;
}

/** `readPiOwnJson` for a file that should hold an object: null without one, or when it doesn't parse. */
async function readPiOwnObject(path: string, comments = false): Promise<Record<string, unknown> | null> {
  const value = await readPiOwnJson(path, comments).catch(() => undefined);
  return isObject(value) ? value : null;
}

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.zerosub.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/**
 * Claude Code guards `.claude.json` writes with a `<file>.lock` directory; take it too. False while
 * someone else holds it, else what `action` returns.
 */
async function withClaudeConfigLock(file: string, action: () => Promise<boolean>): Promise<boolean> {
  const lock = `${file}.lock`;
  try {
    await mkdir(lock);
  } catch {
    const held = await stat(lock).catch(() => null);
    if (held && Date.now() - held.mtimeMs < 10_000) return false;
    await rmdir(lock).catch(() => undefined);
    try {
      await mkdir(lock);
    } catch {
      return false;
    }
  }
  try {
    return await action();
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

const lastMcpSync = new Map<string, number>();
/** MCP server names each home last received from main, so removals in main propagate. */
const lastMcpKeys = new Map<string, Set<string>>();
/** Homes whose `.claude.json` didn't read at their last sync, so that's logged once. */
const unreadableConfigs = new Set<string>();

async function syncClaudeGlobalConfig(home: string): Promise<void> {
  const source = mainClaudeGlobalConfig();
  const target = join(home, ".claude.json");
  const sourceStat = await stat(source).catch(() => null);
  const main = sourceStat ? await readJsonObject(source) : null;
  const targetExists = await exists(target);

  if (!targetExists) {
    // Seed a new account with the user's preferences, MCP servers and project trust — not identity.
    const seed: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(main ?? {})) if (!isAccountKey(key)) seed[key] = value;
    seed.hasCompletedOnboarding = true;
    await writeJsonAtomically(target, seed);
    lastMcpSync.set(home, sourceStat?.mtimeMs ?? 0);
    lastMcpKeys.set(home, new Set(isObject(main?.mcpServers) ? Object.keys(main.mcpServers) : []));
    return;
  }
  if (!main || !sourceStat || lastMcpSync.get(home) === sourceStat.mtimeMs) return;

  const mainServers = isObject(main.mcpServers) ? main.mcpServers : {};
  const synced = await withClaudeConfigLock(target, async () => {
    const current = await readJsonObject(target);
    if (!current) {
      // The account's identity lives in this file, so one that doesn't read (half written, damaged,
      // unreadable) is never replaced by just what's shared. The next sync tries again.
      if (!unreadableConfigs.has(home)) console.warn(`[ZeroSub] left ${target} alone: it doesn't read as a JSON object`);
      unreadableConfigs.add(home);
      return false;
    }
    unreadableConfigs.delete(home);
    const next: Json = { ...current };
    next.mcpServers = mergeShared(current.mcpServers, mainServers, lastMcpKeys.get(home));
    const projects: Json = isObject(current.projects) ? { ...current.projects } : {};
    for (const [path, settings] of Object.entries(isObject(main.projects) ? main.projects : {})) {
      if (!isObject(settings)) continue;
      const merged: Json = isObject(projects[path]) ? { ...(projects[path] as Json) } : {};
      for (const key of SHARED_PROJECT_KEYS) if (key in settings) merged[key] = mergeShared(merged[key], settings[key]);
      projects[path] = merged;
    }
    next.projects = projects;
    await writeJsonAtomically(target, next);
    return true;
  });
  if (synced) {
    lastMcpSync.set(home, sourceStat.mtimeMs);
    lastMcpKeys.set(home, new Set(Object.keys(mainServers)));
  }
}

/** Settings whose lists Claude Code joins across settings files rather than letting one replace another. */
const JOINED_LISTS = new Set(["permissions", "hooks"]);

/**
 * Account overrides win; object values (`env`, `permissions`, …) merge one level deep. Lists in
 * `permissions` (`allow`, `deny`, …) and each `hooks` event's list are joined, main's entries first
 * and each entry once, the way Claude Code merges them across its own settings files.
 */
export function mergeSettings(main: Json, account: Json): Json {
  const merged: Json = { ...main };
  for (const [key, value] of Object.entries(account)) {
    const base = main[key];
    if (!isObject(value) || !isObject(base)) {
      merged[key] = value;
      continue;
    }
    const next: Json = { ...base, ...value };
    if (JOINED_LISTS.has(key)) {
      for (const [name, entries] of Object.entries(value)) {
        const inherited = base[name];
        if (Array.isArray(entries) && Array.isArray(inherited)) next[name] = joinLists(inherited, entries);
      }
    }
    merged[key] = next;
  }
  return merged;
}

function joinLists(first: readonly unknown[], second: readonly unknown[]): unknown[] {
  const joined: unknown[] = [];
  for (const entry of [...first, ...second]) {
    if (!joined.some((existing) => JSON.stringify(existing) === JSON.stringify(entry))) joined.push(entry);
  }
  return joined;
}

async function readSettings(path: string): Promise<Json | null> {
  const value = await readJson(path);
  if (value === undefined) return null;
  if (!isObject(value)) throw new Error(`${path} is not a JSON object`);
  return value;
}

/**
 * Writes the account's `settings.json` as main's settings with the account's overrides on top, so
 * each account can carry its own `env` (a proxy, say) while everything else stays shared. An API
 * account's endpoint and credentials are pinned on the way (see `accountSettings`), so each sync
 * also corrects a file generated before they were.
 *
 * `settings.account.json` marks a file as ZeroSub's, so a home gets one (empty) at its first sync,
 * whether or not main has settings, before Claude Code can write a `settings.json` of its own there
 * (for `/model`, say). A plain `settings.json` without one was made by hand and is left alone, except
 * in a home of ZeroSub's own (see `isOwnHome`): there it's what Claude Code wrote into a home made
 * before the marker was, so it becomes the account's overrides, and main's settings apply under it
 * again. A link the user made (see `userSettingsLink`) is left alone too. A file that doesn't parse
 * stops the sync and keeps the previous one: dropping the account's overrides would quietly send it
 * out without them.
 */
async function syncClaudeSettings(home: string): Promise<void> {
  const target = join(home, "settings.json");
  const overrides = join(home, ACCOUNT_SETTINGS);
  const current = await lstat(target).catch(() => null);
  if (current?.isSymbolicLink() && (await userSettingsLink(home))) return;
  let account = await readSettings(overrides);
  if (!account && current && !current.isSymbolicLink()) {
    if (!current.isFile() || !(await isOwnHome(home))) return;
    account = (await readSettings(target)) ?? {};
    await writeJsonAtomically(overrides, account);
    console.log(`[ZeroSub] kept ${target}, which had no ${ACCOUNT_SETTINGS}, as that account's own settings; main's settings apply under it again`);
  }
  if (!account) {
    account = {};
    await writeJsonAtomically(overrides, account);
  }

  const main = await readSettings(join(mainClaudeDir(), "settings.json"));
  // Homes from earlier versions link to main's file; replace the link, never write through it.
  if (current?.isSymbolicLink()) await unlink(target);
  const inherited = { ...process.env, ...providerEnv("claude") };
  const next = `${JSON.stringify(accountSettings(main ?? {}, account, inherited), null, 2)}\n`;
  if (current?.isFile() && (await readFile(target, "utf8").catch(() => null)) === next) return;
  await writeJsonAtomically(target, JSON.parse(next));
}

/** The proxy set in the account's own settings, or null when it uses whatever it inherits. */
export async function readAccountProxy(home: string): Promise<string | null> {
  const account = await readSettings(join(home, ACCOUNT_SETTINGS)).catch(() => null);
  const env = isObject(account?.env) ? account.env : {};
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") strings[key] = value;
  return proxyFromEnv(strings);
}

/** One sync or edit of a home's settings at a time, so a sync never writes back what an edit just replaced. */
const homeLocks = new Map<string, Mutex>();

function withHome<T>(home: string, section: () => Promise<T>): Promise<T> {
  const key = resolve(home);
  let lock = homeLocks.get(key);
  if (!lock) homeLocks.set(key, (lock = new Mutex()));
  return lock.run(section);
}

/**
 * Where `home`'s `settings.json` links to when the link is the user's: in a home that isn't
 * ZeroSub's own (see `isOwnHome`), a link to anything but main's settings, which homes of earlier
 * versions link to. Such a link is left as it is.
 */
async function userSettingsLink(home: string): Promise<string | null> {
  const target = join(home, "settings.json");
  const to = await readlink(target).catch(() => null);
  if (to === null || (await isOwnHome(home))) return null;
  const main = join(mainClaudeDir(), "settings.json");
  if (resolve(home, to) === resolve(main)) return null;
  const [real, mainReal] = await Promise.all([realpath(target).catch(() => null), realpath(main).catch(() => null)]);
  return real !== null && real === mainReal ? null : to;
}

/** The account's overrides; a hand-made `settings.json` becomes them, so taking the home over loses nothing. */
async function readOverrides(home: string): Promise<Json> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const link = await userSettingsLink(home);
  // Overrides written here would never reach Claude Code, which reads the linked file.
  if (link) throw new Error(`${join(home, "settings.json")} links to ${link}, which ZeroSub leaves as it is: set this there instead`);
  const account = await readSettings(join(home, ACCOUNT_SETTINGS));
  if (account) return account;
  const target = join(home, "settings.json");
  const current = await lstat(target).catch(() => null);
  return current?.isFile() ? ((await readSettings(target)) ?? {}) : {};
}

/**
 * Asked with the home's lock held, before anything is written: an account removed meanwhile gets no
 * home back (`readOverrides` would create it again).
 */
async function stillWanted(wanted: (() => Promise<boolean>) | undefined): Promise<void> {
  if (wanted && !(await wanted())) throw new Error("That account no longer exists.");
}

/** Writes the account's overrides with `edit` applied to their `env`, then regenerates `settings.json`. */
async function editOverridesEnv(home: string, edit: (env: Json) => void): Promise<void> {
  const account = await readOverrides(home);
  const env: Json = isObject(account.env) ? { ...account.env } : {};
  edit(env);
  const next: Json = { ...account, env };
  if (Object.keys(env).length === 0) delete next.env;
  await writeJsonAtomically(join(home, ACCOUNT_SETTINGS), next);
  await syncClaudeSettings(home);
}

/**
 * Sets (or clears, with `null`) the account's proxy and regenerates its `settings.json` at once.
 * All four proxy variables get the same value, so nothing Claude Code inherits (a lower-case
 * `https_proxy` in the shell, say) can outrank it, and the generated file pins the no-proxy list
 * too (see `accountSettings`). `wanted` as for `stillWanted`.
 */
export function writeAccountProxy(home: string, proxy: string | null, wanted?: () => Promise<boolean>): Promise<void> {
  return withHome(home, async () => {
    await stillWanted(wanted);
    await editOverridesEnv(home, (env) => {
      for (const key of PROXY_KEYS) {
        if (proxy) env[key] = proxy;
        else delete env[key];
      }
    });
  });
}

// --------------------------------------------------------------------------- API accounts

const KEY_VARIABLE: Record<ApiKeyKind, string> = { api_key: "ANTHROPIC_API_KEY", auth_token: "ANTHROPIC_AUTH_TOKEN" };
const TRAFFIC_VARIABLE: Record<keyof TrafficSwitches, string> = {
  disableTelemetry: "DISABLE_TELEMETRY",
  disableErrorReporting: "DISABLE_ERROR_REPORTING",
  disableNonessentialTraffic: "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC",
};

export interface ApiConfig extends TrafficSwitches {
  keyKind: ApiKeyKind;
  /** `null` keeps the current key. */
  key: string | null;
  /** `null` for Anthropic's own API. */
  baseUrl: string | null;
}

/** Anthropic's own API, where an API account without a base URL sends its key. */
const ANTHROPIC_API = "https://api.anthropic.com";

/**
 * What an API account's generated `env` holds under its own values: a base URL (Anthropic's unless
 * the account has one) and blanks for every other way Claude Code would pick up a key or token,
 * extra request headers, or another provider (Bedrock, Vertex and the like) instead of the base
 * URL. Claude Code applies `settings.json` `env` over the environment it was started with, so these
 * also beat what the daemon or the shell exports.
 */
const API_ACCOUNT_ENV: Readonly<Record<string, string>> = {
  ANTHROPIC_BASE_URL: ANTHROPIC_API,
  ANTHROPIC_API_KEY: "",
  ANTHROPIC_AUTH_TOKEN: "",
  CLAUDE_CODE_OAUTH_TOKEN: "",
  ANTHROPIC_CUSTOM_HEADERS: "",
  CLAUDE_CODE_USE_BEDROCK: "",
  CLAUDE_CODE_USE_VERTEX: "",
  CLAUDE_CODE_USE_FOUNDRY: "",
  CLAUDE_CODE_USE_ANTHROPIC_AWS: "",
  CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD: "",
  CLAUDE_CODE_USE_MANTLE: "",
};

/**
 * An account's generated settings: main's with the account's overrides on top. An API account
 * (overrides holding a key) uses exactly what was entered for it: `API_ACCOUNT_ENV` goes under its
 * own `env`, and main's `apiKeyHelper` is left out, since Claude Code would send the helper's
 * answer along with the key or in its place.
 *
 * An account with a proxy of its own also gets `no_proxy` and `NO_PROXY`, both set to the no-proxy
 * list it would otherwise have (from `inherited`, the environment Paseo starts it with, then the
 * merged `env`) without the entries that would send Anthropic or Claude traffic past the proxy,
 * plus localhost, 127.0.0.1 and `downloads.claude.ai`. Claude Code applies them over what it
 * inherits, so a `NO_PROXY` in main's settings, the daemon or a shell can't send the account out
 * directly while ZeroSub's own calls for it go through the proxy. Any other account gets the
 * plain merge.
 */
export function accountSettings(main: Json, account: Json, inherited: Readonly<Record<string, string | undefined>> = {}): Json {
  const merged = mergeSettings(main, account);
  if (keyKindOf(stringEnv(account))) {
    const env: Json = { ...(isObject(main.env) ? main.env : {}), ...API_ACCOUNT_ENV, ...(isObject(account.env) ? account.env : {}) };
    if (typeof env.ANTHROPIC_BASE_URL !== "string" || !env.ANTHROPIC_BASE_URL.trim()) env.ANTHROPIC_BASE_URL = ANTHROPIC_API;
    merged.env = env;
    if (!("apiKeyHelper" in account)) delete merged.apiKeyHelper;
  }
  if (proxyFromEnv(stringEnv(account))) {
    const env: Json = isObject(merged.env) ? { ...merged.env } : {};
    const noProxy = withClaudeNoProxy(withoutClaudeDomains(noProxyFromEnv({ ...inherited, ...stringEnv({ env }) })));
    for (const key of NO_PROXY_KEYS) env[key] = noProxy;
    merged.env = env;
  }
  return merged;
}

function stringEnv(account: Json | null): Record<string, string> {
  const env = isObject(account?.env) ? account.env : {};
  const strings: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (typeof value === "string") strings[key] = value;
  return strings;
}

/** Which key the account's own `env` holds, if any: what makes it an API account. */
function keyKindOf(env: Record<string, string>): ApiKeyKind | null {
  return env.ANTHROPIC_AUTH_TOKEN ? "auth_token" : env.ANTHROPIC_API_KEY ? "api_key" : null;
}

/**
 * The account's API settings with the key reduced to a hint (its last four characters, or empty for
 * a short key), or null when it has no key of its own.
 */
export async function readAccountApi(home: string): Promise<ApiSummary | null> {
  const env = stringEnv(await readSettings(join(home, ACCOUNT_SETTINGS)).catch(() => null));
  const keyKind = keyKindOf(env);
  if (!keyKind) return null;
  const on = (name: string) => Boolean(env[name]) && env[name] !== "0" && env[name]?.toLowerCase() !== "false";
  const key = (env[KEY_VARIABLE[keyKind]] ?? "").trim();
  return {
    keyKind,
    keyHint: key.length >= KEY_HINT_MIN_LENGTH ? key.slice(-4) : "",
    baseUrl: env.ANTHROPIC_BASE_URL || null,
    disableTelemetry: on(TRAFFIC_VARIABLE.disableTelemetry),
    disableErrorReporting: on(TRAFFIC_VARIABLE.disableErrorReporting),
    disableNonessentialTraffic: on(TRAFFIC_VARIABLE.disableNonessentialTraffic),
  };
}

/**
 * Stores an API account's key, base URL and traffic switches in its overrides. No base URL is
 * stored for Anthropic's own API; the generated settings write it out (see `accountSettings`). A
 * switch that's off is left out rather than set to 0, so it's whatever main's settings say. An
 * `x-api-key` key is also approved in the account's `.claude.json`, the way answering Claude
 * Code's "use this API key?" question would, so a terminal session doesn't stop to ask about a key
 * added here. `wanted` as for `stillWanted`.
 */
export function writeAccountApi(home: string, config: ApiConfig, wanted?: () => Promise<boolean>): Promise<void> {
  return withHome(home, async () => {
    await stillWanted(wanted);
    await storeAccountApi(home, config);
  });
}

async function storeAccountApi(home: string, config: ApiConfig): Promise<void> {
  const previous = stringEnv(await readOverrides(home));
  const replaced = previous.ANTHROPIC_AUTH_TOKEN || previous.ANTHROPIC_API_KEY || null;
  const key = config.key?.trim() || replaced;
  if (!key) throw new Error("Enter the API key or token");
  const baseUrl = config.baseUrl?.trim() ? normalizeBaseUrl(config.baseUrl) : null;
  // A kept key only goes where it went before: sending it somewhere new takes typing it again.
  if (!config.key?.trim() && (previous.ANTHROPIC_BASE_URL || null) !== baseUrl) {
    throw new Error("Enter the key again to use it with a different base URL");
  }
  if (config.keyKind === "api_key") await approveApiKey(home, key, replaced);
  await editOverridesEnv(home, (env) => {
    for (const name of Object.values(KEY_VARIABLE)) delete env[name];
    env[KEY_VARIABLE[config.keyKind]] = key;
    if (baseUrl) env.ANTHROPIC_BASE_URL = baseUrl;
    else delete env.ANTHROPIC_BASE_URL;
    for (const [field, name] of Object.entries(TRAFFIC_VARIABLE) as [keyof TrafficSwitches, string][]) {
      if (config[field]) env[name] = "1";
      else delete env[name];
    }
  });
}

/** Claude Code remembers an approved key by its last 20 characters. */
function keyFingerprint(key: string): string {
  return key.trim().slice(-20);
}

async function approveApiKey(home: string, key: string, replaced: string | null): Promise<void> {
  const file = join(home, ".claude.json");
  // Seed a new home first, so the account still gets the user's preferences and MCP servers.
  if (!(await exists(file))) await syncClaudeGlobalConfig(home);
  const approve = keyFingerprint(key);
  const retire = replaced ? keyFingerprint(replaced) : null;
  const done = await withClaudeConfigLock(file, async () => {
    const value = await readJson(file);
    const config: Json = isObject(value) ? value : {};
    const responses: Json = isObject(config.customApiKeyResponses) ? config.customApiKeyResponses : {};
    const list = (entry: unknown) => (Array.isArray(entry) ? entry.filter((item): item is string => typeof item === "string") : []);
    const approved = list(responses.approved).filter((item) => item !== retire && item !== approve);
    const rejected = list(responses.rejected).filter((item) => item !== approve);
    await writeJsonAtomically(file, { ...config, customApiKeyResponses: { ...responses, approved: [...approved, approve], rejected } });
    return true;
  });
  if (!done) throw new Error("Claude Code is writing this account's settings right now. Try again in a moment.");
}

/**
 * Brings a Claude home in step with main: shared entries, `.claude.json` and generated settings.
 * `wanted`, if given, is asked once the home's lock is held: a home whose account has gone since the
 * caller looked is left as it is, so it's never written to (or made again) after its account is.
 */
export function prepareClaudeHome(home: string, force = false, wanted?: () => Promise<boolean>): Promise<void> {
  return withHome(home, async () => {
    if (wanted && !(await wanted())) return;
    const last = lastSync.get(home);
    if (!force && last && Date.now() - last < SYNC_TTL_MS) return;
    await syncOverlay(home, {
      main: mainClaudeDir(),
      shareDirs: ["projects", "file-history", "todos", "plans", "tasks", "session-env", "shell-snapshots", "sessions"],
      // Private until ZeroSub shared it, so a home from before then still has its own.
      retireFolders: ["sessions"],
      isPrivate: claudePrivate,
    });
    await syncClaudeGlobalConfig(home);
    await syncClaudeSettings(home);
    lastSync.set(home, Date.now());
  });
}

// --------------------------------------------------------------------------- Codex

/** Per-account entries in a Codex home: credentials and caches keyed to the ChatGPT account. */
const CODEX_PRIVATE = new Set([
  "auth.json",
  "secrets",
  "models_cache.json",
  "cloud-config-bundle-cache.json",
  "cache",
  "plugins",
  ".tmp",
  "tmp",
  "log",
  "thread-writer-locks",
  "mcp-oauth-locks",
  "sqlite",
  "ipc",
  ".codex-global-state.json",
  "computer-use",
  "browser",
]);

function codexPrivate(name: string): boolean {
  return (
    CODEX_PRIVATE.has(name) ||
    isTemporary(name) ||
    name.includes("codex-global-state") ||
    /\.sqlite(?:-wal|-shm|-journal)?$/.test(name) ||
    name.endsWith(".lock")
  );
}

/** Brings a Codex home's shared entries in step with main; `wanted` as for `prepareClaudeHome`. */
export function prepareCodexHome(home: string, force = false, wanted?: () => Promise<boolean>): Promise<void> {
  return withHome(home, async () => {
    if (wanted && !(await wanted())) return;
    const last = lastSync.get(home);
    if (!force && last && Date.now() - last < SYNC_TTL_MS) return;
    await syncOverlay(home, {
      main: mainCodexHome(),
      shareDirs: ["sessions", "archived_sessions"],
      isPrivate: codexPrivate,
    });
    lastSync.set(home, Date.now());
  });
}

/** Where the main Codex home keeps its SQLite state; managed homes point there so thread metadata is shared. */
export async function codexSqliteHome(): Promise<string | null> {
  if (process.env.CODEX_SQLITE_HOME) return process.env.CODEX_SQLITE_HOME;
  const config = await readFile(join(mainCodexHome(), "config.toml"), "utf8").catch(() => "");
  // A `sqlite_home` in the (shared) config.toml already applies to every account.
  if (/^\s*sqlite_home\s*=/m.test(config)) return null;
  return mainCodexHome();
}

// --------------------------------------------------------------------------- Pi

/** Checks a base URL typed by the user: http(s), no query or fragment, no trailing slash. */
export function normalizeBaseUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("Enter the base URL as a URL, like https://api.example.com");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("The base URL must start with http:// or https://");
  if (url.username || url.password) throw new Error("Put credentials in the key field, not in the base URL");
  if (url.search || url.hash) throw new Error("The base URL can't have a query or fragment");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** Keys shorter than this get no hint: their last four characters would give away too much of them. */
const KEY_HINT_MIN_LENGTH = 12;

/**
 * An added Pi account's own settings, kept by ZeroSub in its home (mode 600): the Anthropic API key
 * and base URL it uses, and its proxy. Pi never reads it; `auth.json` and `models.json` are made
 * from it (see `preparePiHome`), and the proxy goes to the account's sessions as environment
 * variables (see `PiAdapter.env`).
 */
export const PI_ACCOUNT_FILE = "zerosub.json";

export interface PiAccount {
  key: string | null;
  baseUrl: string | null;
  proxy: string | null;
}

/**
 * Entries of Pi's agent directory an added account keeps to itself: its sign-ins (`auth.json`) and
 * where its Anthropic requests go (`models.json`), both made here, Pi's model catalog cache, which
 * it fills from the providers it can reach with its own key, ZeroSub's own file, and locks and
 * scratch files. Settings, sessions, extensions, skills, prompts and the rest are shared.
 */
function piPrivate(name: string): boolean {
  return (
    name === PI_ACCOUNT_FILE ||
    name === "zerosub.env" ||
    name.startsWith("auth.json") ||
    name.startsWith("models.json") ||
    name.startsWith("models-store.json") ||
    name.endsWith(".lock") ||
    isTemporary(name)
  );
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The account's own settings; empty ones for a home without the file (or one that doesn't parse). */
export async function readPiAccount(home: string): Promise<PiAccount> {
  return piAccountFrom(await readJsonObject(join(home, PI_ACCOUNT_FILE)));
}

/**
 * The account's settings to start an agent with. Unlike `readPiAccount`, a folder without a readable
 * `zerosub.json` throws instead of reading as empty: the folder is being moved (renamed away while
 * Pi's processes are checked) or is gone, and an agent started from empty settings would run without
 * the account's proxy, and keep running that way.
 */
export async function readPiAccountForAgents(home: string): Promise<PiAccount> {
  const value = await readJsonObject(join(home, PI_ACCOUNT_FILE));
  if (!value) throw new Error(`${home} has no readable ${PI_ACCOUNT_FILE} (it may be moving)`);
  return piAccountFrom(value);
}

function piAccountFrom(value: Record<string, unknown> | null): PiAccount {
  return { key: stringOrNull(value?.key), baseUrl: stringOrNull(value?.baseUrl), proxy: stringOrNull(value?.proxy) };
}

async function writePiAccount(home: string, account: PiAccount): Promise<void> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const value: Json = {};
  if (account.key) value.key = account.key;
  if (account.baseUrl) value.baseUrl = account.baseUrl;
  if (account.proxy) value.proxy = account.proxy;
  await writeJsonAtomically(join(home, PI_ACCOUNT_FILE), value);
}

/**
 * The account's `auth.json`: the API keys the CLI login keeps for other providers (OpenRouter's,
 * say), which are safe to copy, and the account's own Anthropic key in place of any the CLI login
 * has. Subscription sign-ins (OAuth) aren't copied: each copy would refresh its token on its own,
 * and the first refresh would leave the other with a spent one. Pi uses a stored key before any in
 * the environment, so the daemon's `ANTHROPIC_API_KEY` can't take this one's place; the key is
 * stored escaped (see `piLiteral`) so Pi reads it as it was typed.
 */
export function piAuth(main: unknown, key: string | null): Json {
  const auth: Json = {};
  if (isObject(main)) {
    for (const [provider, entry] of Object.entries(main)) {
      if (provider !== "anthropic" && isObject(entry) && entry.type === "api_key") auth[provider] = entry;
    }
  }
  if (key) auth.anthropic = { type: "api_key", key: piLiteral(key) };
  return auth;
}

/**
 * `value` written so Pi reads it back unchanged. Pi resolves a stored key as config: one starting
 * with `!` is run as a shell command, and `$NAME` or `${NAME}` is filled in from the environment, so
 * a key containing either would be run or changed (and one that came out empty would fall back to
 * the environment's key). In Pi's syntax `$$` stands for `$`, and `$!` for `!`.
 */
export function piLiteral(value: string): string {
  const escaped = value.split("$").join("$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

/**
 * What else in a `models.json` provider entry would send another key or token along, or in its
 * place, or send the requests elsewhere (`oauth` takes each model's own base URL).
 */
const PI_OVERRIDING_AUTH = ["apiKey", "headers", "authHeader", "oauth"];

/** A model entry (`models[]`) or override (`modelOverrides`) with `keys` taken out. */
function without(entry: unknown, keys: readonly string[]): unknown {
  if (!isObject(entry)) return entry;
  const copy: Json = { ...entry };
  for (const key of keys) delete copy[key];
  return copy;
}

/**
 * The account's `models.json`: the CLI login's, with Anthropic's requests sent to the account's base
 * URL (Pi's built-in one, `https://api.anthropic.com`, when it has none) and nothing in Anthropic's
 * entry that would send another key or extra headers, or send a model's requests elsewhere. In Pi a
 * model's own `baseUrl` and `headers` (`models[]`) outrank the provider's, and an override's
 * `headers` (`modelOverrides`) are added to its requests, so those are taken out of Anthropic's
 * models too: otherwise that model would carry the account's key to wherever the CLI login sends
 * it. Everything else (other providers, the rest of each model) stays as it is.
 */
export function piModels(main: unknown, baseUrl: string | null): Json {
  const models: Json = isObject(main) ? { ...main } : {};
  const providers: Json = isObject(models.providers) ? { ...models.providers } : {};
  const anthropic: Json = isObject(providers.anthropic) ? { ...providers.anthropic } : {};
  for (const key of [...PI_OVERRIDING_AUTH, "baseUrl"]) delete anthropic[key];
  if (Array.isArray(anthropic.models)) anthropic.models = anthropic.models.map((model) => without(model, ["baseUrl", "headers"]));
  if (isObject(anthropic.modelOverrides)) {
    anthropic.modelOverrides = Object.fromEntries(Object.entries(anthropic.modelOverrides).map(([id, entry]) => [id, without(entry, ["headers"])]));
  }
  if (baseUrl) anthropic.baseUrl = baseUrl;
  if (Object.keys(anthropic).length > 0) providers.anthropic = anthropic;
  else delete providers.anthropic;
  if (Object.keys(providers).length > 0) models.providers = providers;
  else delete models.providers;
  return models;
}

/** Main's `models.json` files that didn't parse, so each is only logged once. */
const unreadablePiModels = new Set<string>();

/** Writes `value` to `path` unless it already holds exactly that. */
async function writeIfChanged(path: string, value: unknown): Promise<void> {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  const current = await lstat(path).catch(() => null);
  if (current?.isFile() && (await readFile(path, "utf8").catch(() => null)) === next) return;
  await writeJsonAtomically(path, value);
}

async function syncPiFiles(home: string): Promise<void> {
  const account = await readPiAccount(home);
  const mainDir = mainPiDir();
  const mainAuth = await readPiOwnObject(join(mainDir, "auth.json"));
  await writeIfChanged(join(home, "auth.json"), piAuth(mainAuth, account.key));
  const modelsPath = join(mainDir, "models.json");
  let mainModels: unknown = {};
  try {
    mainModels = (await readPiOwnJson(modelsPath, true)) ?? {};
    unreadablePiModels.delete(modelsPath);
  } catch {
    // Still written, so the account's key never goes to a base URL it wasn't set up with.
    if (!unreadablePiModels.has(modelsPath)) console.warn(`[ZeroSub] ${modelsPath} doesn't parse; added Pi accounts don't get its models until it's fixed`);
    unreadablePiModels.add(modelsPath);
  }
  await writeIfChanged(join(home, "models.json"), piModels(mainModels, account.baseUrl));
}

/** Main's `settings.json` files that didn't parse, so each is only logged once. */
const unreadablePiSettings = new Set<string>();

/**
 * The account's `settings.json`. Without a proxy of its own it's a link to the CLI login's, like
 * the other shared entries. With one it's the CLI login's settings with `httpProxy` set to the
 * proxy, so Pi started on the account's folder anywhere else (`PI_CODING_AGENT_DIR=<folder> pi` in
 * a terminal, say) goes through it too, as long as its environment names no proxy (Pi only fills
 * the proxy variables in from `httpProxy` when they're unset). It's remade from the CLI login's at
 * every sync, so what Pi writes to it there doesn't last. A home ZeroSub made is the only kind a
 * Pi account has, so the generated file is replaced by the link again once the proxy goes; while
 * the CLI login has no settings to link to, it stays with `httpProxy` taken out.
 */
async function syncPiSettings(home: string, proxy: string | null): Promise<void> {
  const target = join(home, "settings.json");
  const current = await lstat(target).catch(() => null);
  const mainSettings = join(mainPiDir(), "settings.json");
  if (proxy) {
    let main: unknown;
    try {
      main = await readPiOwnJson(mainSettings);
      unreadablePiSettings.delete(mainSettings);
    } catch {
      if (!unreadablePiSettings.has(mainSettings)) console.warn(`[ZeroSub] ${mainSettings} isn't valid JSON; added Pi accounts with a proxy keep the rest of their settings as they were until it's fixed`);
      unreadablePiSettings.add(mainSettings);
      // The rest stays as it was, but never the proxy: the account's may have changed since.
      if (current?.isFile()) main = await readJsonObject(target);
    }
    // Written over the link, never through it: the CLI login's settings stay as they are.
    await writeIfChanged(target, { ...(isObject(main) ? main : {}), httpProxy: proxy });
    return;
  }
  if (!current?.isFile()) return;
  const real = await realpath(mainSettings).catch(() => null);
  if (!real) {
    // The CLI login has none to share, so the file stays, without the proxy that was the account's:
    // Pi started on this folder would otherwise still go through it.
    const own = await readJsonObject(target);
    if (own && "httpProxy" in own) {
      const { httpProxy: _gone, ...rest } = own;
      await writeIfChanged(target, rest);
    }
    return;
  }
  await unlink(target);
  await symlink(real, target);
}

/**
 * Brings an added Pi account's home in step with the CLI login's agent directory: shared entries
 * linked, `auth.json` and `models.json` made from it and the account's own settings. `wanted`, if
 * given, is asked once the home's lock is held: a home whose account has gone since the caller
 * looked is left as it is.
 */
export function preparePiHome(home: string, force = false, wanted?: () => Promise<boolean>): Promise<void> {
  return withHome(home, async () => {
    if (wanted && !(await wanted())) return;
    const last = lastSync.get(home);
    if (!force && last && Date.now() - last < SYNC_TTL_MS) return;
    const { proxy } = await readPiAccount(home);
    await syncPiSettings(home, proxy);
    const isPrivate = (name: string) => piPrivate(name) || (proxy !== null && name === "settings.json");
    await syncOverlay(home, { main: mainPiDir(), shareDirs: ["sessions"], isPrivate });
    await syncPiFiles(home);
    lastSync.set(home, Date.now());
  });
}

/** The account's API settings with the key reduced to a hint (its last four characters, or empty for a short key); null without a key. */
export async function readPiAccountApi(home: string): Promise<ApiSummary | null> {
  const { key, baseUrl } = await readPiAccount(home);
  if (!key) return null;
  return { keyHint: key.length >= KEY_HINT_MIN_LENGTH ? key.slice(-4) : "", baseUrl };
}

/**
 * Stores a Pi account's Anthropic key (`null` keeps the current one) and base URL, then remakes its
 * `auth.json` and `models.json`. A kept key only goes where it went before: sending it somewhere new
 * takes typing it again, so nobody can point it at a new address without knowing it. `wanted` as for `stillWanted`.
 */
export function writePiAccountApi(home: string, config: { key: string | null; baseUrl: string | null }, wanted?: () => Promise<boolean>): Promise<void> {
  return withHome(home, async () => {
    await stillWanted(wanted);
    const previous = await readPiAccount(home);
    const key = config.key?.trim() || previous.key;
    if (!key) throw new Error("Enter the API key");
    const baseUrl = config.baseUrl?.trim() ? normalizeBaseUrl(config.baseUrl) : null;
    if (!config.key?.trim() && previous.baseUrl !== baseUrl) throw new Error("Enter the key again to use it with a different base URL");
    await writePiAccount(home, { ...previous, key, baseUrl });
    await syncPiFiles(home);
  });
}

/**
 * Sets (or clears, with `null`) a Pi account's proxy, for its sessions started afterwards (see
 * `PiAdapter.env`). `wanted` as for `stillWanted`. `inherited` says which proxy the account would go
 * through without one of its own, for a key that clearing it would send there in the clear.
 */
export function writePiAccountProxy(
  home: string,
  proxy: string | null,
  wanted?: () => Promise<boolean>,
  inherited?: (baseUrl: string | null) => Promise<{ proxy: string; from: string } | null>,
): Promise<void> {
  return withHome(home, async () => {
    await stillWanted(wanted);
    const previous = await readPiAccount(home);
    // Without its own, the account goes through the proxy it inherits: a plain-http:// key would then
    // cross that one in the clear, as through a new one of its own, to this machine too (`inherited`
    // is null where the no-proxy list keeps the base URL direct; see `crossesInheritedProxy`).
    if (!proxy && previous.proxy && previous.key && plainHttp(previous.baseUrl)) {
      const next = await inherited?.(previous.baseUrl);
      if (next) {
        throw new Error(
          `This account sends its key over plain http://, and without its own proxy it would go through ${maskProxy(next.proxy)} (${next.from}), which could read it. Switch to an https:// base URL first, or keep this proxy.`,
        );
      }
    }
    // As with a new base URL, a key is never sent somewhere new: over plain http:// a proxy reads it.
    if (proxy && proxy !== previous.proxy) {
      if (previous.key && sentInTheClear(previous.baseUrl)) {
        throw new Error(
          "This account sends its key over plain http://, which a proxy can read. To use a new proxy, remove the account and add it again with its key and the proxy, or switch to an https:// base URL.",
        );
      }
      const exposed = await clearTextProviders(false);
      if (exposed.length > 0) {
        throw new Error(
          `Pi's own models.json sends the API key for ${exposed.join(", ")} over plain http://, and every Pi account gets that key, so a proxy could read it. Use https:// there, or a gateway on this machine, before setting a proxy.`,
        );
      }
    }
    await writePiAccount(home, { ...previous, proxy });
    await syncPiSettings(home, proxy);
  });
}

/**
 * The variables Pi takes each of its own providers' key from when it has none stored
 * (`getApiKeyEnvVars` in pi-ai): every name any version from 1.4.0 on reads, as a name an older or
 * newer Pi doesn't read only refuses a proxy it could have allowed. 1.5.1 added
 * `qwen-token-plan-individual-cn`; the per-plan Qwen variables come after 1.5.2 (on Pi's main
 * branch, not released yet). Anthropic's are in `PI_ANTHROPIC_CREDENTIAL_ENV`.
 */
const PI_KEY_ENV: Readonly<Record<string, string | readonly string[]>> = {
  "github-copilot": "COPILOT_GITHUB_TOKEN",
  "ant-ling": "ANT_LING_API_KEY",
  "qwen-token-plan": ["QWEN_TOKEN_PLAN_TEAM_API_KEY", "QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_TEAM_CN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY"],
  "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_INDIVIDUAL_API_KEY", "QWEN_TOKEN_PLAN_API_KEY"],
  "qwen-token-plan-individual-cn": ["QWEN_TOKEN_PLAN_INDIVIDUAL_CN_API_KEY", "QWEN_TOKEN_PLAN_CN_API_KEY"],
  openai: "OPENAI_API_KEY",
  azure: "AZURE_OPENAI_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_CLOUD_API_KEY",
  groq: "GROQ_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  xai: "XAI_API_KEY",
  typesafe: "TYPESAFE_API_KEY",
  radius: "RADIUS_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
  zai: "ZAI_API_KEY",
  "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
  mistral: "MISTRAL_API_KEY",
  minimax: "MINIMAX_API_KEY",
  "minimax-cn": "MINIMAX_CN_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  "moonshotai-cn": "MOONSHOT_API_KEY",
  huggingface: "HF_TOKEN",
  fireworks: "FIREWORKS_API_KEY",
  together: "TOGETHER_API_KEY",
  baseten: "BASETEN_API_KEY",
  opencode: "OPENCODE_API_KEY",
  "opencode-go": "OPENCODE_API_KEY",
  "kimi-coding": "KIMI_API_KEY",
  meta: "META_API_KEY",
  "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
  "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
  xiaomi: "XIAOMI_API_KEY",
  "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
};

/**
 * The variables that give Pi's own login something of Anthropic's to send: a key or token, headers
 * the SDK adds to every request, or the federation rule Pi gets a token for when it has no key.
 */
const PI_ANTHROPIC_CREDENTIAL_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_CUSTOM_HEADERS", "ANTHROPIC_FEDERATION_RULE_ID"];

/**
 * Providers that Pi's own `models.json` sends over plain http:// through the proxy (to another
 * machine for an added account's, see `sentInTheClear`; for the login's, anywhere the no-proxy list
 * doesn't keep direct, see `crossesInheritedProxy`), for the provider or any of its models, along
 * with a credential a proxy could then read: an entry in the CLI login's `auth.json`, an `apiKey`,
 * `headers` or `authHeader` in its `models.json` (for the provider, a model or an override), or a key
 * in the environment Pi starts with (the daemon's, under the Pi provider's `env` in Paseo's config).
 *
 * For an added account's proxy these are the credentials every account gets from the CLI login: its
 * `auth.json` API keys (see `piAuth`; its sign-ins aren't copied) and everything but Anthropic's, which
 * the account has its own of (see `piModels`). For the proxy of Pi's own login (`login`) it's whatever
 * that login sends: Anthropic's too, and its sign-ins. There a `models.json` that doesn't parse is
 * refused, as nothing can be told from it; an added account gets none of it (see `syncPiFiles`).
 */
export async function clearTextProviders(login: boolean): Promise<string[]> {
  const auth = (await readPiOwnObject(join(mainPiDir(), "auth.json"))) ?? {};
  const modelsPath = join(mainPiDir(), "models.json");
  let models: unknown;
  try {
    models = await readPiOwnJson(modelsPath, true);
  } catch {
    if (login) throw new Error(`${modelsPath} doesn't parse, so ZeroSub can't tell whether a key there would cross the proxy over plain http://. Fix it before setting a proxy.`);
  }
  const providers = isObject(models) && isObject(models.providers) ? models.providers : {};
  const env: Record<string, string | undefined> = { ...process.env, ...providerEnv("pi") };
  const inEnv = (name: string) => (name === "anthropic" ? PI_ANTHROPIC_CREDENTIAL_ENV : [PI_KEY_ENV[name] ?? []].flat()).some((key) => env[key]?.trim());
  const clear = (value: unknown) => typeof value === "string" && (login ? crossesInheritedProxy(value, env) : sentInTheClear(value));
  // Set to something: an empty key or header list, or `authHeader: false`, sends nothing.
  const set = (value: unknown) => (isObject(value) ? Object.keys(value).length > 0 : value !== undefined && value !== null && value !== false && value !== "");
  const carries = (entry: unknown) => isObject(entry) && ["apiKey", "headers", "authHeader"].some((key) => set(entry[key]));
  return Object.entries(providers)
    .filter(([name, config]) => {
      if ((name === "anthropic" && !login) || !isObject(config)) return false;
      const list = Array.isArray(config.models) ? config.models.filter(isObject) : [];
      const overrides = isObject(config.modelOverrides) ? Object.values(config.modelOverrides) : [];
      const entry = auth[name];
      const stored = isObject(entry) && (login || entry.type === "api_key");
      const shared = stored || inEnv(name) || carries(config) || overrides.some(carries);
      // A model sends what the provider carries, plus its own headers, to its own base URL or the provider's.
      return list.some((model) => clear(model.baseUrl ?? config.baseUrl) && (shared || carries(model))) || (clear(config.baseUrl) && shared);
    })
    .map(([name]) => name);
}

/**
 * Whether requests to `baseUrl` would cross a proxy ZeroSub gives an added account unencrypted:
 * plain http:// to anywhere but the hosts that always stay direct (`REQUIRED_NO_PROXY`, which
 * ZeroSub puts in that account's no-proxy list; see `proxyVariables`). For a proxy Pi takes itself,
 * see `crossesInheritedProxy`.
 */
export function sentInTheClear(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return url.protocol === "http:" && !(REQUIRED_NO_PROXY as readonly string[]).includes(host);
  } catch {
    return false;
  }
}

/** Whether `baseUrl` is plain http://, which any proxy it goes through can read. */
export function plainHttp(baseUrl: string | null): boolean {
  if (!baseUrl) return false;
  try {
    return new URL(baseUrl).protocol === "http:";
  } catch {
    return false;
  }
}

/**
 * Whether requests to `baseUrl` would cross a proxy Pi takes from `httpProxy` or the environment
 * (`env`, the one Pi starts with) unencrypted: plain http:// that the no-proxy list doesn't keep
 * direct. Pi adds nothing to that list, and undici, which Pi sends its requests with, keeps no host
 * direct without it, this machine included. The list is read as undici reads it: `no_proxy` wherever
 * it's set, even empty, else `NO_PROXY`.
 */
export function crossesInheritedProxy(baseUrl: string | null, env: Record<string, string | undefined> = { ...process.env, ...providerEnv("pi") }): boolean {
  return baseUrl !== null && plainHttp(baseUrl) && !bypassesProxy(env.no_proxy ?? env.NO_PROXY ?? null, baseUrl);
}
