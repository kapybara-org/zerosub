import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Gives the whole run its own PASEO_HOME, which the test workers inherit. Tests point it at their own
 * folder while they run; anything that writes after its test has ended (a Service nobody stopped,
 * say) lands here, never in the real ~/.paseo.
 */
export default async function setup(): Promise<() => Promise<void>> {
  const home = await mkdtemp(join(tmpdir(), "zerosub-test-home-"));
  process.env.PASEO_HOME = home;
  return () => rm(home, { recursive: true, force: true, maxRetries: 5 });
}
