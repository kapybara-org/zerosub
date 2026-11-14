import { basename } from "node:path";
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
  // Grok's own home, auth file, environment login, API keys, an external auth command, customer SSO,
  // or another chat endpoint: any of them means the entry isn't signed in with `~/.grok`'s login.
  grok: [
    "GROK_HOME",
    "GROK_AUTH",
    "GROK_AUTH_PATH",
    "XAI_API_KEY",
    "GROK_CODE_XAI_API_KEY",
    "GROK_DEPLOYMENT_KEY",
    "GROK_AUTH_PROVIDER_COMMAND",
    "GROK_AUTH_PROVIDER_ACCESS_TOKEN",
    "GROK_OIDC_ISSUER",
    "GROK_OIDC_CLIENT_ID",
    "GROK_OIDC_AUDIENCE",
    "GROK_OIDC_SCOPES",
    "GROK_CLI_CHAT_PROXY_BASE_URL",
  ],
};

/** Families Paseo has a provider of its own for. Grok only runs as a custom ACP provider (see `grokCommand`). */
const BUILT_IN: readonly Family[] = ["claude", "codex", "pi"];

const isFamily = (id: unknown): id is Family => typeof id === "string" && (FAMILIES as readonly string[]).includes(id);

export function bringsOwnAuth(family: Family, env: Record<string, unknown> | undefined): boolean {
  if (!env) return false;
  return OWN_AUTH_KEYS[family].some((key) => typeof env[key] === "string" && env[key] !== "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

/**
 * The Grok binary a provider entry runs, when it's Grok Build's agent over ACP: `extends: "acp"` and a
 * command like Paseo's catalog entry, `["grok", "agent", "stdio"]` (a path to `grok` or `grok-<version>`
 * too, with options between). Not one that joins a shared leader (`--leader`): the leader's sessions
 * run on whichever login started it. Null for anything else.
 */
export function grokCommand(entry: Record<string, unknown> | undefined): string | null {
  if (!entry || entry.extends !== "acp" || entry.enabled === false) return null;
  const command = entry.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string")) return null;
  const [binary, ...args] = command as string[];
  if (!binary || !/^grok(?:-\d[\w.]*)?(?:\.exe)?$/i.test(basename(binary))) return null;
  const agent = args.indexOf("agent");
  if (agent < 0 || args.indexOf("stdio", agent + 1) < 0 || args.includes("--leader")) return null;
  return binary;
}

/**
 * Maps Paseo provider IDs to the family they run on: the built-in `claude`, `codex` and `pi`
 * providers, custom profiles that extend them without their own credentials, and custom ACP providers
 * that run Grok Build (see `grokCommand`) without their own credentials.
 */
export function familiesFromConfig(providers: Record<string, unknown> | undefined): Record<string, Family> {
  const result: Record<string, Family> = {};
  const entries = providers ?? {};
  for (const family of BUILT_IN) {
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
  for (const [id, value] of Object.entries(entries)) {
    if (id in result || (isFamily(id) && id !== "grok")) continue;
    const entry = asRecord(value);
    if (grokCommand(entry) && !bringsOwnAuth("grok", asRecord(entry?.env))) result[id] = "grok";
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
      value = Object.fromEntries(BUILT_IN.map((family) => [family, family]));
    }
    this.cache = { at: Date.now(), value };
    return value;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
