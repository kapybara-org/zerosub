import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

export function paseoHome(): string {
  const configured = process.env.PASEO_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".paseo");
}

/** Everything ZeroSub writes lives here: its registry and the per-account credential homes. */
export function dataDir(): string {
  return join(paseoHome(), "zerosub");
}

export function statePath(): string {
  return join(dataDir(), "state.json");
}

export function homesDir(): string {
  return join(dataDir(), "homes");
}

/**
 * Where each added Claude account's script goes (see server/launchers.ts), and where added Claude
 * accounts' homes are kept unless the user picks another folder (see `claudeHomesDir`):
 * `~/.claude-config`, or `ZEROSUB_LAUNCHER_DIR`.
 */
export function launcherDir(): string {
  const configured = process.env.ZEROSUB_LAUNCHER_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".claude-config");
}

/**
 * Where each added Pi account's script goes (`pi-<account>.sh`), and where added Pi accounts' homes
 * are kept unless the user picks another folder: `~/.pi-config`, or `ZEROSUB_PI_DIR`.
 */
export function piLauncherDir(): string {
  const configured = process.env.ZEROSUB_PI_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".pi-config");
}

/** A path the way it's shown to the user: under `~` when it's in the home folder. */
export function shownPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}

/** Whether `home` is a folder directly in `homesDir()`, where ZeroSub makes homes. */
export function inHomesDir(home: string): boolean {
  return dirname(resolve(home)) === homesDir();
}

/**
 * Whether ZeroSub may sign `home` out and delete it: a folder of its own directly in `homesDir()`,
 * not a link to one elsewhere and never a CLI's own home. Every other home (one moved out by hand,
 * say) belongs to the user, whatever the registry says: removing its account only unregisters it.
 */
export async function isOwnHome(home: string): Promise<boolean> {
  const path = resolve(home);
  if (!inHomesDir(path) || path === mainClaudeDir() || path === mainCodexHome() || path === mainPiDir()) return false;
  const entry = await lstat(path).catch(() => null);
  return !entry?.isSymbolicLink();
}

/** The config directory the Claude CLI uses when `CLAUDE_CONFIG_DIR` is not set. */
export function mainClaudeDir(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? resolve(configured) : join(homedir(), ".claude");
}

/** Claude keeps its global config beside the config directory unless `CLAUDE_CONFIG_DIR` is set. */
export function mainClaudeGlobalConfig(): string {
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  return configured ? join(resolve(configured), ".claude.json") : join(homedir(), ".claude.json");
}

export function mainCodexHome(): string {
  const configured = process.env.CODEX_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".codex");
}

/** Pi's agent directory when `PI_CODING_AGENT_DIR` is not set: its settings, sign-ins and sessions. */
export function mainPiDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  // Pi expands a leading `~` itself.
  const expanded = configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
  return resolve(expanded);
}
