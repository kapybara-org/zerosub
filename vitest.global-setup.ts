import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Gives the whole run its own PASEO_HOME and account-script folders, which the test workers inherit.
 * Tests point them at their own folder while they run; anything that writes after its test has ended (a Service nobody stopped,
 * say) lands here, never in the real ~/.paseo.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const home = await mkdtemp(join(tmpdir(), "zerosub-test-home-"));
  process.env.PASEO_HOME = home;
  // Account scripts too: a test that doesn't point them at its own folder never writes the real ones.
  process.env.ZEROSUB_LAUNCHER_DIR = join(home, "claude-config");
  process.env.ZEROSUB_PI_DIR = join(home, "pi-config");
  return () => rm(home, { recursive: true, force: true, maxRetries: 5 });
}
