import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { FAMILIES, type Family } from "../shared/model";
import { rememberProviderEnvs } from "./provider-env";

type PaseoApi = PluginHandlerContext["paseo"];

/**
 * Environment keys that mean a provider entry brings its own credentials or endpoint. Such entries
 * (API keys, Bedrock/Vertex, a proxy, a hand-made config dir) are left exactly as configured.
 */
const OWN_AUTH_KEYS: Record<Family, readonly string[]> = {
  claude: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_HOME", "OPENAI_BASE_URL"],
  // Pi keeps every sign-in in its agent directory, and a key stored there outranks one in the
  // environment, so only a directory of the entry's own means it isn't Pi's usual login.
  pi: ["PI_CODING_AGENT_DIR"],
};

const isFamily = (id: unknown): id is Family => typeof id === "string" && (FAMILIES as readonly string[]).includes(id);

export function bringsOwnAuth(family: Family, env: Record<string, unknown> | undefined): boolean {
  if (!env) return false;
  return OWN_AUTH_KEYS[family].some((key) => typeof env[key] === "string" && env[key] !== "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * Maps Paseo provider IDs to the family they run on: the built-in `claude`, `codex` and `pi`
 * providers, plus custom profiles that extend them without their own credentials.
 */
export function familiesFromConfig(providers: Record<string, unknown> | undefined): Record<string, Family> {
  const result: Record<string, Family> = {};
  const entries = providers ?? {};
  for (const family of FAMILIES) {
    const entry = asRecord(entries[family]);
    if (!entry || !bringsOwnAuth(family, asRecord(entry.env))) result[family] = family;
  }
  for (const [id, value] of Object.entries(entries)) {
    if (isFamily(id)) continue;
    const entry = asRecord(value);
    const base = entry?.extends;
    if (!isFamily(base)) continue;
    if (bringsOwnAuth(base, asRecord(entry?.env))) continue;
    result[id] = base;
  }
  return result;
}

const CACHE_MS = 30_000;

/** Reads provider profiles from the daemon config, cached briefly because session opens are hot. */
export class FamilyResolver {
  private cache: { at: number; value: Record<string, Family> } | null = null;

  async resolve(paseo: PaseoApi): Promise<Record<string, Family>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.value;
    let value: Record<string, Family>;
    try {
      const { config } = await paseo.config.get();
      const providers = asRecord(config.providers);
      value = familiesFromConfig(providers);
      // Pi's provider `env` (a proxy there, say) is what its agents inherit; see server/pi.ts.
      rememberProviderEnvs(value, providers);
    } catch (error) {
      console.warn("[ZeroSub] could not read provider config; using built-in providers only", describe(error));
      value = Object.fromEntries(FAMILIES.map((family) => [family, family]));
    }
    this.cache = { at: Date.now(), value };
    return value;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
