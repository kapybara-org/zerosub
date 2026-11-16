import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

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

/** Grok Build's home: `GROK_HOME` in the daemon's environment, else `~/.grok`. */
export function mainGrokHome(): string {
  const configured = process.env.GROK_HOME?.trim();
  return configured ? resolve(configured) : join(homedir(), ".grok");
}

/**
 * Where `cursor-agent` keeps its settings (`cli-config.json` and more), as it works it out:
 * `CURSOR_CONFIG_DIR`, else `$XDG_CONFIG_HOME/cursor`, else `~/.cursor`.
 */
export function mainCursorConfigDir(): string {
  const configured = process.env.CURSOR_CONFIG_DIR?.trim();
  if (configured) return resolve(configured);
  const xdg = process.env.XDG_CONFIG_HOME?.trim();
  return xdg ? join(resolve(xdg), "cursor") : join(homedir(), ".cursor");
}

/**
 * The daemon's XDG config folder, which an added Cursor account's mirrors (see `prepareCursorHome`):
 * `$XDG_CONFIG_HOME`, else `~/.config`. `cursor-agent` keeps its Linux login in `cursor/auth.json` there.
 */
export function mainConfigHome(): string {
  return resolve(process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"));
}

/** Pi's agent directory: `PI_CODING_AGENT_DIR` (a leading `~` is the home folder, as Pi reads it), else `~/.pi/agent`. */
export function mainPiDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  const expanded = configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
  return resolve(expanded);
}

/**
 * Where each added Claude account's script goes (`claude-<account>.sh`, see server/launchers.ts):
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
 * Whether ZeroSub may delete `home`: a folder of its own directly in `homesDir()`, not a link to one
 * elsewhere and never a CLI's own home. Every other home (where added Pi accounts are kept, say)
 * belongs to the user: removing its account only unregisters it.
 */
export async function isOwnHome(home: string): Promise<boolean> {
  const path = resolve(home);
  if (!inHomesDir(path) || path === mainClaudeDir() || path === mainCodexHome() || path === mainPiDir() || path === mainGrokHome()) return false;
  // What a Cursor account's home mirrors could be pointed inside one: never delete a home holding it.
  for (const main of [mainCursorConfigDir(), mainConfigHome()]) {
    const inside = relative(path, main);
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) return false;
  }
  const entry = await lstat(path).catch(() => null);
  return !entry?.isSymbolicLink();
}
