import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where each tool keeps its config, sign-ins or added accounts, unless told otherwise. */
const CONFIG_DIRS = [
  "PASEO_HOME",
  "CLAUDE_CONFIG_DIR",
  "ZEROSUB_LAUNCHER_DIR",
  "ZEROSUB_PI_DIR",
  "PI_CODING_AGENT_DIR",
  "CODEX_HOME",
  "GROK_HOME",
  "CURSOR_CONFIG_DIR",
  "XDG_CONFIG_HOME",
];

/**
 * Gives the whole run its own folders, which the test workers inherit. Tests point them at their own
 * folders while they run; anything that writes after its test has ended (a Service nobody stopped,
 * say), or a test that doesn't set one, lands here, never in the real ~/.paseo, ~/.claude, or the
 * folders ZeroSub keeps added accounts in (~/.claude-config, ~/.pi-config) — however vitest is started.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const home = await mkdtemp(join(tmpdir(), "zerosub-test-home-"));
  for (const name of CONFIG_DIRS) process.env[name] = join(home, name.toLowerCase());
  // Set by a Claude Code session the tests may be run from: it points at that session's real sign-in.
  delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  return () => rm(home, { recursive: true, force: true, maxRetries: 5 });
}
