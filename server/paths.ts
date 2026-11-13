import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

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

/** Pi's agent directory: `PI_CODING_AGENT_DIR` (a leading `~` is the home folder, as Pi reads it), else `~/.pi/agent`. */
export function mainPiDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  const expanded = configured === "~" ? homedir() : configured.startsWith("~/") ? join(homedir(), configured.slice(2)) : configured;
  return resolve(expanded);
}

/** A path the way it's shown to the user: under `~` when it's in the home folder. */
export function shownPath(path: string): string {
  const home = homedir();
  return path === home ? "~" : path.startsWith(`${home}${sep}`) ? `~${path.slice(home.length)}` : path;
}
