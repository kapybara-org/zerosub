import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { paseoHome } from "./paths";

/** The part of the plugin's Paseo connection a reopen needs. */
export interface ReopenHost {
  agents: { ref(agentId: string): unknown };
}

/**
 * The host's own reopen, when it has one: Paseo 0.16's `agents.ref(id).reload()` closes and reopens
 * the provider session in the daemon with the current configuration, rerunning session-open hooks.
 * `null` on older hosts.
 */
export function hostReload(paseo: ReopenHost | null | undefined, agentId: string): (() => Promise<unknown>) | null {
  let ref: { reload?: unknown } | undefined;
  try {
    ref = paseo?.agents.ref(agentId) as { reload?: unknown } | undefined;
  } catch {
    return null;
  }
  const reload = ref?.reload;
  return typeof reload === "function" ? () => (reload as () => Promise<unknown>).call(ref) : null;
}

/** Whether the host can reopen sessions itself. A ref is a local handle: building one sends nothing. */
export function hostCanReload(paseo: ReopenHost | null | undefined): boolean {
  return hostReload(paseo, "zerosub-capability-check") !== null;
}

/**
 * Reopens an agent's provider session so it picks up a new account.
 *
 * Through the host's own reopen when it has one (Paseo 0.16+). Otherwise through the bundled CLI's
 * `paseo agent reload`, which the daemon implements as close + reopen with the current
 * configuration. The CLI has to find the agent in its agent list first, which leaves out background
 * agents, so on older hosts a background agent only changes accounts when its session next opens.
 * The CLI connects on its own; when it can't, the switch also applies the next time the session opens.
 */
export class Reopener {
  private cli: { at: number; path: Promise<string | null> } | null = null;

  /** Path to the CLI, or null when none can be found (looked for again every few minutes). */
  async locate(): Promise<string | null> {
    if (this.cli && (Date.now() - this.cli.at < 5 * 60_000 || (await this.cli.path) !== null)) return this.cli.path;
    this.cli = { at: Date.now(), path: findCli() };
    return this.cli.path;
  }

  /** `timedOut`: the reopen was stopped, or gave up, before the daemon answered, so it may still finish. */
  async reopen(agentId: string, paseo?: ReopenHost | null): Promise<{ ok: true } | { ok: false; error: string; timedOut: boolean }> {
    const reload = hostReload(paseo, agentId);
    if (reload) {
      try {
        await reload();
        return { ok: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, error: message || "Reload failed.", timedOut: STOPPED_WAITING.test(message) };
      }
    }
    const cli = await this.locate();
    if (!cli) return { ok: false, error: "The paseo command-line tool was not found on the daemon machine.", timedOut: false };
    const args = ["agent", "reload", agentId, "--json", "--home", paseoHome()];
    // Node refuses to execFile a .cmd/.bat without a shell (spawn EINVAL), so run it through cmd.exe.
    const viaCmd = process.platform === "win32" && /\.(cmd|bat)$/i.test(cli);
    const file = viaCmd ? (process.env.ComSpec ?? "cmd.exe") : cli;
    const argv = viaCmd ? ["/d", "/s", "/c", `"${[cli, ...args].map((part) => `"${part}"`).join(" ")}"`] : args;
    return new Promise((resolve) => {
      execFile(
        file,
        argv,
        { timeout: 90_000, maxBuffer: 1024 * 1024, env: process.env, windowsVerbatimArguments: viaCmd },
        (error, _stdout, stderr) => {
          if (!error) return resolve({ ok: true });
          const detail = `${stderr || error.message}`.trim().split("\n").slice(-3).join(" ");
          // The CLI gives up on the daemon's answer by itself after a minute, which says as little.
          const timedOut = error.killed === true || STOPPED_WAITING.test(`${stderr}\n${error.message}`);
          resolve({ ok: false, error: explainFailure(detail), timedOut });
        },
      );
    });
  }
}

/** The Paseo CLI's own "no answer in time" (`DAEMON_REQUEST_TIMEOUT`), e.g. "Timeout waiting for message (60000ms)". */
const STOPPED_WAITING = /Timeout waiting for message|DAEMON_REQUEST_TIMEOUT/;

function explainFailure(detail: string): string {
  if (/transport closed|cannot connect|cannot reach|password|unauthori[sz]ed|DAEMON_NOT_RUNNING/i.test(detail)) {
    return "Paseo's CLI could not connect to this daemon (it may require a password)";
  }
  return detail || "Reload failed.";
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function findCli(exec: string = process.execPath): Promise<string | null> {
  const candidates: string[] = [];
  const executable = process.platform === "win32" ? "paseo.cmd" : "paseo";

  // The daemon (and this subprocess) usually run inside the desktop app bundle, which ships the CLI.
  const appContents = exec.match(/^(.*?\.app\/Contents)\//)?.[1];
  if (appContents) candidates.push(join(appContents, "Resources", "bin", "paseo"));
  const resources = findAncestor(exec, "resources");
  if (resources) candidates.push(join(resources, "bin", executable));
  // The Windows desktop app keeps `resources/` beside Paseo.exe, not above it.
  candidates.push(join(dirname(exec), "resources", "bin", executable));

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory) candidates.push(join(directory, executable));
  }

  if (process.platform === "darwin") {
    candidates.push("/Applications/Paseo.app/Contents/Resources/bin/paseo");
    candidates.push(join(homedir(), "Applications", "Paseo.app", "Contents", "Resources", "bin", "paseo"));
  }
  candidates.push(join(homedir(), ".local", "bin", executable));

  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return null;
}

function findAncestor(path: string, name: string): string | null {
  let current = dirname(path);
  for (let depth = 0; depth < 6; depth += 1) {
    if (current.toLowerCase().endsWith(`/${name}`) || current.toLowerCase().endsWith(`\\${name}`)) return current;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
