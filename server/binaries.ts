import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readJson } from "./json-file";
import { dataDir, paseoHome } from "./paths";

export interface Command {
  command: string;
  /** Arguments that precede ours when the provider is configured with a wrapper command. */
  prefix: string[];
}

const CACHE_MS = 60_000;
let cache: { at: number; value: Record<string, Command> } | null = null;

/** The CLI Paseo launches for a provider: `agents.providers.<id>.command` when set, else the name on PATH. */
export async function providerCommand(provider: "claude" | "codex"): Promise<Command> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const value: Record<string, Command> = {};
    try {
      const config = (await readJson(join(paseoHome(), "config.json"))) as
        | { agents?: { providers?: Record<string, { command?: unknown }> } }
        | undefined;
      for (const id of ["claude", "codex"]) {
        const command = config?.agents?.providers?.[id]?.command;
        if (Array.isArray(command) && typeof command[0] === "string" && command.every((part) => typeof part === "string")) {
          value[id] = { command: command[0], prefix: command.slice(1) as string[] };
        }
      }
    } catch {
      // Unreadable config: fall back to PATH lookups.
    }
    cache = { at: Date.now(), value };
  }
  return cache.value[provider] ?? { command: provider, prefix: [] };
}

let browserShim: Promise<string | null> | null = null;

/**
 * A `$BROWSER` stand-in that records the URL instead of opening a window on the daemon machine,
 * so the sign-in link can be opened on whatever device the user is holding.
 */
export function browserCaptureScript(): Promise<string | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  browserShim ??= (async () => {
    const directory = join(dataDir(), "bin");
    const path = join(directory, "capture-url");
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(
        path,
        '#!/bin/sh\n[ -n "$ZEROSUB_BROWSER_OUT" ] && printf \'%s\\n\' "$1" > "$ZEROSUB_BROWSER_OUT"\nexit 0\n',
        { mode: 0o700 },
      );
      await chmod(path, 0o700);
      return path;
    } catch (error) {
      console.warn("[ZeroSub] could not create the browser shim", error instanceof Error ? error.message : error);
      return null;
    }
  })();
  return browserShim;
}
