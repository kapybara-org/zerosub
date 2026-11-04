import { cp, lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { ApiSummary } from "../shared/model";
import { Mutex, readJson } from "./json-file";
import { isOwnHome, mainClaudeDir, mainClaudeGlobalConfig, mainCodexHome, mainPiDir } from "./paths";

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
  isPrivate(name: string): boolean;
}

const SYNC_TTL_MS = 30_000;
const lastSync = new Map<string, number>();

/** Has the next sync of every home run in full: the CLI login's files, which theirs are made from, changed. */
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

/** One sync or edit of a home at a time, so a sync never writes back what an edit just replaced, and a move waits for both. */
const homeLocks = new Map<string, Mutex>();

function withHome<T>(home: string, section: () => Promise<T>): Promise<T> {
  const key = resolve(home);
  let lock = homeLocks.get(key);
  if (!lock) homeLocks.set(key, (lock = new Mutex()));
  return lock.run(section);
}

/**
 * Asked with the home's lock held, before anything is written: an account removed meanwhile gets no
 * home back.
 */
async function stillWanted(wanted: (() => Promise<boolean>) | undefined): Promise<void> {
  if (wanted && !(await wanted())) throw new Error("That account no longer exists.");
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
    if (current) {
      if (!current.isSymbolicLink()) continue; // Created here by the CLI; leave it alone.
      if ((await readlink(link)) === target || !(await ours(link))) continue;
      await unlink(link);
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

/**
 * Per-account entries, from Claude Code's own split between configuration and state: credentials,
 * the global config (it holds `oauthAccount`), account caches, org policy, telemetry and locks.
 */
const CLAUDE_PRIVATE = new Set([
  ".credentials.json",
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
  "sessions",
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

async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.zerosub.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** Claude Code guards `.claude.json` writes with a `<file>.lock` directory; take it too. */
async function withClaudeConfigLock(file: string, action: () => Promise<void>): Promise<boolean> {
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
    await action();
    return true;
  } finally {
    await rmdir(lock).catch(() => undefined);
  }
}

const lastMcpSync = new Map<string, number>();
/** MCP server names each home last received from main, so removals in main propagate. */
const lastMcpKeys = new Map<string, Set<string>>();

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
    const current = (await readJsonObject(target)) ?? {};
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
  });
  if (synced) {
    lastMcpSync.set(home, sourceStat.mtimeMs);
    lastMcpKeys.set(home, new Set(Object.keys(mainServers)));
  }
}

export async function prepareClaudeHome(home: string, force = false): Promise<void> {
  const last = lastSync.get(home);
  if (!force && last && Date.now() - last < SYNC_TTL_MS) return;
  await syncOverlay(home, {
    main: mainClaudeDir(),
    shareDirs: ["projects", "file-history", "todos", "plans", "tasks", "session-env", "shell-snapshots"],
    isPrivate: claudePrivate,
  });
  await syncClaudeGlobalConfig(home);
  lastSync.set(home, Date.now());
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

export async function prepareCodexHome(home: string, force = false): Promise<void> {
  const last = lastSync.get(home);
  if (!force && last && Date.now() - last < SYNC_TTL_MS) return;
  await syncOverlay(home, {
    main: mainCodexHome(),
    shareDirs: ["sessions", "archived_sessions"],
    isPrivate: codexPrivate,
  });
  lastSync.set(home, Date.now());
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
  const value = await readJsonObject(join(home, PI_ACCOUNT_FILE));
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
 * the environment, so the daemon's `ANTHROPIC_API_KEY` can't take this one's place.
 */
export function piAuth(main: unknown, key: string | null): Json {
  const auth: Json = {};
  if (isObject(main)) {
    for (const [provider, entry] of Object.entries(main)) {
      if (provider !== "anthropic" && isObject(entry) && entry.type === "api_key") auth[provider] = entry;
    }
  }
  if (key) auth.anthropic = { type: "api_key", key };
  return auth;
}

/** What else in a `models.json` provider entry would send another key or token along, or in its place. */
const PI_OVERRIDING_AUTH = ["apiKey", "headers", "authHeader"];

/**
 * The account's `models.json`: the CLI login's, with Anthropic's requests sent to the account's base
 * URL (Pi's built-in one, `https://api.anthropic.com`, when it has none) and nothing in Anthropic's
 * entry that would send another key or extra headers. Everything else (custom providers and models,
 * model overrides) stays as it is.
 */
export function piModels(main: unknown, baseUrl: string | null): Json {
  const models: Json = isObject(main) ? { ...main } : {};
  const providers: Json = isObject(models.providers) ? { ...models.providers } : {};
  const anthropic: Json = isObject(providers.anthropic) ? { ...providers.anthropic } : {};
  for (const key of [...PI_OVERRIDING_AUTH, "baseUrl"]) delete anthropic[key];
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
  const mainAuth = await readJsonObject(join(mainDir, "auth.json"));
  await writeIfChanged(join(home, "auth.json"), piAuth(mainAuth, account.key));
  const modelsPath = join(mainDir, "models.json");
  let mainModels: unknown = {};
  try {
    mainModels = (await readJson(modelsPath)) ?? {};
    unreadablePiModels.delete(modelsPath);
  } catch {
    // Still written, so the account's key never goes to a base URL it wasn't set up with.
    if (!unreadablePiModels.has(modelsPath)) console.warn(`[ZeroSub] ${modelsPath} isn't valid JSON; added Pi accounts don't get its models until it's fixed`);
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
 * Pi account has, so the generated file is replaced by the link again once the proxy goes.
 */
async function syncPiSettings(home: string, proxy: string | null): Promise<void> {
  const target = join(home, "settings.json");
  const current = await lstat(target).catch(() => null);
  const mainSettings = join(mainPiDir(), "settings.json");
  if (proxy) {
    let main: unknown;
    try {
      main = await readJson(mainSettings);
      unreadablePiSettings.delete(mainSettings);
    } catch {
      if (!unreadablePiSettings.has(mainSettings)) console.warn(`[ZeroSub] ${mainSettings} isn't valid JSON; added Pi accounts with a proxy keep their settings as they were until it's fixed`);
      unreadablePiSettings.add(mainSettings);
      if (current?.isFile()) return;
    }
    // Written over the link, never through it: the CLI login's settings stay as they are.
    await writeIfChanged(target, { ...(isObject(main) ? main : {}), httpProxy: proxy });
    return;
  }
  if (!current?.isFile()) return;
  const real = await realpath(mainSettings).catch(() => null);
  if (!real) return; // Pi's own, while the CLI login has none to share.
  await unlink(target);
  await symlink(real, target);
}

/**
 * Brings an added Pi account's home in step with the CLI login's agent directory: shared entries
 * linked, `auth.json`, `models.json` and (with a proxy of its own) `settings.json` made from it and
 * the account's own settings. `wanted`, if given, is asked once the home's lock is held: a home whose
 * account has gone since the caller looked is left as it is.
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
 * Sets (or clears, with `null`) a Pi account's proxy, for its sessions started afterwards, and as
 * `httpProxy` in its `settings.json` (see `syncPiSettings`). `wanted` as for `stillWanted`.
 */
export function writePiAccountProxy(home: string, proxy: string | null, wanted?: () => Promise<boolean>): Promise<void> {
  return withHome(home, async () => {
    await stillWanted(wanted);
    await writePiAccount(home, { ...(await readPiAccount(home)), proxy });
    await syncPiSettings(home, proxy);
  });
}
