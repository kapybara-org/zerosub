import { lstat, mkdir, readFile, readdir, readlink, realpath, rename, rm, rmdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, sep } from "node:path";
import { homesDir, mainClaudeDir, mainClaudeGlobalConfig, mainCodexHome } from "./paths";

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
      if ((await readlink(link)) === target) continue;
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
    if (current?.isSymbolicLink() && !(await exists(link))) await unlink(link).catch(() => undefined);
  }
}

/**
 * Deletes a managed home. Its top level holds symlinks into the user's real CLI home, so those are
 * unlinked first; nothing outside ZeroSub's own directory is ever followed or removed.
 */
export async function removeHome(home: string): Promise<void> {
  if (!home.startsWith(homesDir() + sep)) return;
  for (const name of await readdir(home).catch(() => [] as string[])) {
    const path = join(home, name);
    const entry = await lstat(path).catch(() => null);
    if (entry?.isSymbolicLink()) await unlink(path).catch(() => undefined);
  }
  await rm(home, { recursive: true, force: true });
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
