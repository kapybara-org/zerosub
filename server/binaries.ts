import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FAMILIES, type Family } from "../shared/model";
import { familiesFromConfig, grokCommand } from "./families";
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
export async function providerCommand(provider: Family): Promise<Command> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const value: Record<string, Command> = {};
    try {
      const config = (await readJson(join(paseoHome(), "config.json"))) as
        | { agents?: { providers?: Record<string, { command?: unknown }> } }
        | undefined;
      for (const id of FAMILIES) {
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
  // Paseo's Pi provider also takes its binary from PI_COMMAND (or the older PI_ACP_PI_COMMAND).
  const fallback = provider === "pi" ? process.env.PI_COMMAND?.trim() || process.env.PI_ACP_PI_COMMAND?.trim() || "pi" : provider;
  return cache.value[provider] ?? { command: fallback, prefix: [] };
}

/**
 * The binary of the Paseo provider that runs Grok Build (see `grokCommand`), preferring one with the
 * id `grok`, as Paseo's catalog names it; null when no provider runs Grok, or the config can't be read.
 */
export async function grokBinary(): Promise<string | null> {
  try {
    const config = (await readJson(join(paseoHome(), "config.json"))) as { agents?: { providers?: Record<string, unknown> } } | undefined;
    const providers = config?.agents?.providers;
    const ids = Object.entries(familiesFromConfig(providers))
      .filter(([, family]) => family === "grok")
      .map(([id]) => id)
      .sort((a, b) => (a === "grok" ? -1 : b === "grok" ? 1 : 0));
    for (const id of ids) {
      const entry = providers?.[id];
      const binary = grokCommand(entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined);
      if (binary) return binary;
    }
  } catch {
    // Unreadable config: no Grok provider to go by.
  }
  return null;
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
