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
  // An API key or session token (cursor-agent saves either as its login), another endpoint, or a
  // login or settings folder of the entry's own: any of them means it isn't the usual Cursor login.
  cursor: [
    "CURSOR_API_KEY",
    "CURSOR_AUTH_TOKEN",
    "CURSOR_API_ENDPOINT",
    "XDG_CONFIG_HOME",
    "CURSOR_CONFIG_DIR",
  ],
};

/**
 * Families Paseo has a provider of its own for. Grok and Cursor only run as custom ACP providers (see
 * `ACP_COMMANDS`).
 */
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
 * Agents Paseo runs only as custom ACP providers, by the binary a provider entry runs (its base name)
 * and the arguments that make it the agent:
 * - Grok Build: `grok` or `grok-<version>`, with `agent` then `stdio` (options between), as in Paseo's
 *   catalog entry `["grok", "agent", "stdio"]`. Not one that joins a shared leader (`--leader`): the
 *   leader's sessions run on whichever login started it.
 * - Cursor: `cursor-agent` (never the generic `agent` alias; Linux only, so no `.exe` or `.cmd`), with
 *   `acp`, as in Paseo's catalog entry `["cursor-agent", "acp"]`. Not one given its own API key or
 *   endpoint (`--api-key`, `-e`/`--endpoint`).
 */
const ACP_COMMANDS: Partial<Record<Family, { binary: RegExp; args(args: readonly string[]): boolean }>> = {
  grok: {
    binary: /^grok(?:-\d[\w.]*)?(?:\.exe)?$/i,
    args: (args) => {
      const agent = args.indexOf("agent");
      return agent >= 0 && args.indexOf("stdio", agent + 1) >= 0 && !args.includes("--leader");
    },
  },
  cursor: {
    binary: /^cursor-agent$/,
    args: (args) => args.includes("acp") && !args.some((arg) => /^(?:--api-key|-e|--endpoint)(?:=|$)/.test(arg)),
  },
};

/** The families matched by command (see `ACP_COMMANDS`), in the order they're tried. */
const ACP_FAMILIES = Object.keys(ACP_COMMANDS) as Family[];

/**
 * The binary a provider entry runs, when it's `family`'s agent over ACP (see `ACP_COMMANDS`):
 * `extends: "acp"`, not disabled, and a command whose binary and arguments are that agent's. Null for
 * anything else.
 */
export function acpCommand(family: Family, entry: Record<string, unknown> | undefined): string | null {
  const spec = ACP_COMMANDS[family];
  if (!spec || !entry || entry.extends !== "acp" || entry.enabled === false) return null;
  const command = entry.command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string")) return null;
  const [binary, ...args] = command as string[];
  if (!binary || !spec.binary.test(basename(binary)) || !spec.args(args)) return null;
  return binary;
}

/** The Grok binary a provider entry runs (see `ACP_COMMANDS`), or null. */
export function grokCommand(entry: Record<string, unknown> | undefined): string | null {
  return acpCommand("grok", entry);
}

/**
 * Maps Paseo provider IDs to the family they run on: the built-in `claude`, `codex` and `pi`
 * providers, custom profiles that extend them without their own credentials, and custom ACP providers
 * that run Grok Build or Cursor's agent (see `ACP_COMMANDS`) without their own credentials.
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
  for (const family of ACP_FAMILIES) {
    for (const [id, value] of Object.entries(entries)) {
      if (id in result || (isFamily(id) && id !== family)) continue;
      const entry = asRecord(value);
      if (acpCommand(family, entry) && !bringsOwnAuth(family, asRecord(entry?.env))) result[id] = family;
    }
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
