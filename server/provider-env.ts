import { FAMILIES, type Family } from "../shared/model";

/**
 * The `env` Paseo's config gives each family's built-in provider (`agents.providers.claude.env`,
 * say), which Paseo layers over the daemon's environment for every session on it. ZeroSub's own
 * calls with an account's token and the CLI processes it starts for an account use it too, so they
 * go out the way that account's agents do (through a proxy set there, for one). Empty until the
 * config is first read, and for a provider ZeroSub doesn't route because it brings its own
 * credentials; a config that can't be read keeps what was read last.
 */
const envs = new Map<Family, Record<string, string>>();

export function providerEnv(family: Family): Record<string, string> {
  return envs.get(family) ?? {};
}

/** Remembers the built-in providers' `env` from the config's `providers`, given the families ZeroSub routes. */
export function rememberProviderEnvs(routed: Readonly<Record<string, Family>>, providers: Record<string, unknown> | undefined): void {
  for (const family of FAMILIES) {
    const entry = providers?.[family];
    const env = entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as { env?: unknown }).env : undefined;
    const strings: Record<string, string> = {};
    if (routed[family] === family && env && typeof env === "object" && !Array.isArray(env)) {
      for (const [key, value] of Object.entries(env)) if (typeof value === "string") strings[key] = value;
    }
    envs.set(family, strings);
  }
}
