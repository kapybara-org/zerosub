import { z } from "zod";

/**
 * The provider families this plugin manages: the subscription CLIs (Claude Code, Codex, Grok Build,
 * Cursor), and Pi, whose added accounts are Anthropic API keys. Custom provider profiles map onto one of them.
 */
export const FamilySchema = z.enum(["claude", "codex", "pi", "grok", "cursor"]);
export type Family = z.infer<typeof FamilySchema>;
export const FAMILIES: readonly Family[] = FamilySchema.options;

export const FAMILY_LABEL: Record<Family, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  pi: "Pi",
  grok: "Grok",
  cursor: "Cursor",
};

/** Paseo's OpenCode harness provider. It runs on the host itself, so a fork to it uses no account. */
export const OPENCODE_PROVIDER = "opencode";
export const OPENCODE_LABEL = "OpenCode";
/**
 * The provider a stopped chat can carry on with when every account of its own is out (Claude ↔
 * ChatGPT); null for Pi, whose added accounts are billed per use and never take work over by themselves,
 * and for Grok and Cursor, whose chats don't fork to another provider.
 */
export const OTHER_FAMILY: Record<Family, Family | null> = { claude: "codex", codex: "claude", pi: null, grok: null, cursor: null };

/**
 * Families not every Paseo user runs: one shows once its CLI login is registered (its CLI is there,
 * and for Grok and Cursor a Paseo provider runs it) or an account of it was added, and its CLI is only
 * missed once an account of it was added.
 */
export const OPTIONAL: Record<Family, boolean> = { claude: false, codex: false, pi: true, grok: true, cursor: true };

/** The families the Accounts screen shows, given the accounts there are (the CLI logins registered included). */
export function shownFamilies(accounts: readonly { family: Family }[]): Family[] {
  return FAMILIES.filter((family) => !OPTIONAL[family] || accounts.some((account) => account.family === family));
}

/**
 * For a provider whose conversations can't change accounts in place: one with history carries on in a
 * new agent on the account picked for it (Codex's). False for Grok's and Cursor's, which stay on their
 * account until moving them is known to work; only new agents follow a pick or the default.
 */
export const HAND_OFF: Record<Family, boolean> = { claude: true, codex: true, pi: true, grok: false, cursor: false };

/** Stands for a proxy's password (or a user name with none) wherever the proxy is shown. */
export const HIDDEN = "•••";

export const UsageWindowSchema = z.object({
  /** Stable key, e.g. `five_hour`, `seven_day`, `seven_day_opus`, `primary`, `secondary`. */
  id: z.string(),
  label: z.string(),
  /** 0–100. */
  usedPercent: z.number(),
  resetsAt: z.string().nullable(),
  /** How long the window is, in minutes. Only Codex readings have it; `null` when Codex doesn't say. */
  minutes: z.number().nullable().optional(),
});
export type UsageWindow = z.infer<typeof UsageWindowSchema>;

/** Banked limit resets the provider has granted this account (Claude "limit reset", Codex reset credits). */
export const ResetOfferSchema = z.object({
  /** Resets left to use. */
  available: z.number(),
  /** The provider will accept a redeem right now. */
  usableNow: z.boolean(),
  /** Why it can't be used yet, in plain words, when it can't. */
  blockedReason: z.string().nullable(),
  /** Use-by date of the next reset, if it expires. */
  expiresAt: z.string().nullable(),
  /** Which limits a reset refills, e.g. "5-hour", "weekly". Empty when the provider doesn't say. */
  refills: z.array(z.string()),
  /** The provider's own name for the reset, if it gives one. */
  label: z.string().nullable(),
});
export type ResetOffer = z.infer<typeof ResetOfferSchema>;

/** Prepaid credits that keep an account going once its windows run out (ChatGPT credits for Codex). */
export const CreditsSchema = z.object({
  /** Credits left; `null` when the provider doesn't say how many. */
  balance: z.number().nullable(),
  unlimited: z.boolean(),
});
export type Credits = z.infer<typeof CreditsSchema>;

/**
 * Pay-as-you-go usage past the plan's limits (Claude "extra usage"), as the usage response reports it.
 * `spend` and `limit` are Claude's `used_credits` and `monthly_limit`, in minor units of `currency`
 * (cents for USD); `null` when the response leaves those amounts out. A read without spend omits
 * `extraUsage`, keeping the last known value; a successful spend read can clear it with `null`.
 */
export const ExtraUsageSchema = z.object({
  enabled: z.boolean(),
  spend: z.number().nullable().default(null),
  limit: z.number().nullable().default(null),
  currency: z.string().nullable().default(null),
});
export type ExtraUsage = z.infer<typeof ExtraUsageSchema>;

export const UsageSchema = z.object({
  fetchedAt: z.string(),
  windows: z.array(UsageWindowSchema),
  /** Why usage could not be read, if it could not. Old windows may still be shown. */
  error: z.string().nullable(),
  /** Read from the CLI's own cache rather than the provider, so possibly out of date. */
  cached: z.boolean().default(false),
  /** Banked resets, when the provider reports any. */
  resets: ResetOfferSchema.nullable().default(null),
  checkResetsInClaude: z.boolean().optional(),
  /** Credits the account can spend past full windows, when the provider reports any. */
  credits: CreditsSchema.nullable().default(null),
  /** Claude extra usage, when the usage response reports it. Shown on the account card. */
  extraUsage: ExtraUsageSchema.nullable().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const AccountKindSchema = z.enum([
  /** The login the CLI uses on its own (`~/.claude`, `~/.codex`). */
  "main",
  /** Created by this plugin: an isolated credential home that shares everything else with main. */
  "managed",
]);
export type AccountKind = z.infer<typeof AccountKindSchema>;

export const AuthKindSchema = z.enum([
  /** Signed in with a Claude or ChatGPT subscription (or, for Pi's own login, whatever Pi is signed in to). */
  "subscription",
  /**
   * An API key or token (a Claude account's, optionally against another base URL; an added Pi
   * account's Anthropic key; an Azure OpenAI or AWS Bedrock account's), billed per use, so never
   * picked automatically. An Azure OpenAI or Bedrock account can be, as a last resort, once
   * `paidApiFallback` is on.
   */
  "api",
]);
export type AuthKind = z.infer<typeof AuthKindSchema>;

/**
 * The paid API behind an `api` account that stands in for a subscription, set when it's added. Never
 * inferred from `auth`: a Claude or Pi API-key account has none, and is only used when chosen.
 */
export const ApiProviderSchema = z.enum([
  /** An Azure OpenAI resource, under ChatGPT (Codex). */
  "azure",
  /** Amazon Bedrock with AWS credentials, under Claude. */
  "bedrock",
]);
export type ApiProvider = z.infer<typeof ApiProviderSchema>;

/** An Azure OpenAI account: a ChatGPT (Codex) account added as one, marked `provider: "azure"`. */
export function isAzureAccount(account: { family: Family; provider?: ApiProvider }): boolean {
  return account.family === "codex" && account.provider === "azure";
}

/**
 * An AWS Bedrock account: a Claude account added as one, marked `provider: "bedrock"`. A Claude
 * account on an API key or token without the marker (#65's) is never one.
 */
export function isBedrockAccount(account: { family: Family; provider?: ApiProvider }): boolean {
  return account.family === "claude" && account.provider === "bedrock";
}

export const ApiKeyKindSchema = z.enum([
  /** `ANTHROPIC_API_KEY`, sent as `x-api-key`. */
  "api_key",
  /** `ANTHROPIC_AUTH_TOKEN`, sent as `Authorization: Bearer`. */
  "auth_token",
]);
export type ApiKeyKind = z.infer<typeof ApiKeyKindSchema>;

/** Claude Code's own switches for a Claude API account; each is off unless the user turns it on. */
export const TrafficSwitchesSchema = z.object({
  /** `DISABLE_TELEMETRY`. */
  disableTelemetry: z.boolean().default(false),
  /** `DISABLE_ERROR_REPORTING`. */
  disableErrorReporting: z.boolean().default(false),
  /** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: everything not needed to talk to the model. */
  disableNonessentialTraffic: z.boolean().default(false),
});
export type TrafficSwitches = z.infer<typeof TrafficSwitchesSchema>;

/** Anthropic's own API, where a Claude API key goes when its base URL is left empty. */
export const ANTHROPIC_API = "https://api.anthropic.com";

/**
 * Whether a Claude API key with this base URL goes to Anthropic's own API: no base URL, or
 * Anthropic's typed out. Only such a key stands in with "Use paid API accounts when every
 * subscription is out" (see `isPaidStandIn`); one on another endpoint is used only when chosen.
 */
export function onAnthropicApi(baseUrl: string | null | undefined): boolean {
  const url = baseUrl?.trim().replace(/\/+$/, "").toLowerCase();
  return !url || url === ANTHROPIC_API;
}

/** An API key's settings as shown in the app; the key itself never leaves the host. */
export const ApiSummarySchema = TrafficSwitchesSchema.extend({
  /** Left out by providers whose accounts only take an API key (Pi's). */
  keyKind: ApiKeyKindSchema.default("api_key"),
  /** The key's last four characters, or empty for a key too short to show any of it. */
  keyHint: z.string(),
  /** Where Anthropic's requests go, or null for Anthropic's own API. */
  baseUrl: z.string().nullable(),
});
/** As an adapter gives it: the kind and switches may be left out, and are filled in for the client. */
export type ApiSummary = z.input<typeof ApiSummarySchema>;

/** USD per million tokens for one model on a paid API account; null where the user left it empty. */
export const ApiPriceSchema = z.object({
  input: z.number().nonnegative().nullable().default(null),
  /** Cached input (OpenAI), or cache reads (Anthropic). */
  cachedInput: z.number().nonnegative().nullable().default(null),
  /** Cache writes (Anthropic); Azure OpenAI has none. */
  cacheWrite: z.number().nonnegative().nullable().default(null),
  output: z.number().nonnegative().nullable().default(null),
});
export type ApiPrice = z.infer<typeof ApiPriceSchema>;

/**
 * Tokens one model used. `input` is every input token, cached ones included (as OpenAI and Codex
 * count them): `cachedInput` of them were read from the cache, and `cacheWrite` written to it.
 */
export const TokenCountSchema = z.object({
  input: z.number().nonnegative().default(0),
  cachedInput: z.number().nonnegative().default(0),
  cacheWrite: z.number().nonnegative().default(0),
  output: z.number().nonnegative().default(0),
});
export type TokenCount = z.infer<typeof TokenCountSchema>;

/** A paid API account's tokens this calendar month (UTC), as its CLI counted them, by model. */
export const ApiMonthSchema = z.object({
  /** `YYYY-MM`, UTC. */
  month: z.string(),
  models: z.record(z.string(), TokenCountSchema).default({}),
  /** Turns that ended on the account whose tokens couldn't be read (no session file found). */
  uncounted: z.number().nonnegative().default(0),
  updatedAt: z.string().nullable().default(null),
});
export type ApiMonth = z.infer<typeof ApiMonthSchema>;

/** Month key (`YYYY-MM`, UTC) API token totals are kept under. */
export function usageMonth(at: number | Date = Date.now()): string {
  return new Date(at).toISOString().slice(0, 7);
}

/**
 * The estimated cost of `month` at `prices` (USD per million tokens, by model). `complete` is false
 * when a model that used tokens has no price, or a price it needs is empty; `usd` then counts only
 * what has a price, and is null when nothing does.
 */
export function estimateApiCost(month: ApiMonth | null, prices: Readonly<Record<string, ApiPrice>>): { usd: number | null; complete: boolean } {
  if (!month) return { usd: null, complete: true };
  let usd = 0;
  let priced = false;
  let complete = true;
  for (const [model, count] of Object.entries(month.models)) {
    const price = prices[model];
    const uncached = Math.max(0, count.input - count.cachedInput - count.cacheWrite);
    const parts: Array<[number, number | null | undefined]> = [
      [uncached, price?.input],
      // Cache reads or writes without a price of their own are counted at the input price.
      [count.cachedInput, price?.cachedInput ?? price?.input],
      [count.cacheWrite, price?.cacheWrite ?? price?.input],
      [count.output, price?.output],
    ];
    for (const [tokens, perMillion] of parts) {
      if (tokens === 0) continue;
      if (perMillion == null) {
        complete = false;
        continue;
      }
      usd += (tokens / 1_000_000) * perMillion;
      priced = true;
    }
  }
  return { usd: priced ? usd : null, complete };
}

/** A month's tokens over every model. */
export function totalTokens(month: ApiMonth | null): TokenCount {
  const total = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
  for (const count of Object.values(month?.models ?? {})) {
    total.input += count.input;
    total.cachedInput += count.cachedInput;
    total.cacheWrite += count.cacheWrite;
    total.output += count.output;
  }
  return total;
}

/** An Azure OpenAI account (a ChatGPT/Codex account on an API key) as the app sees it. The key never leaves the host. */
export const AzureSummarySchema = z.object({
  /** The endpoint's base URL, e.g. `https://<resource>.openai.azure.com/openai/v1`. */
  endpoint: z.string(),
  host: z.string(),
  /** The key's last four characters, or empty for a key too short to show any of it. */
  keyHint: z.string(),
  /** USD per million tokens, by model (deployment name). */
  prices: z.record(z.string(), ApiPriceSchema).default({}),
  /** This month's tokens; null before the first counted turn. */
  usage: ApiMonthSchema.nullable().default(null),
});
export type AzureSummary = z.infer<typeof AzureSummarySchema>;

/** Where an AWS Bedrock account's AWS credentials come from. */
export const BedrockSourceSchema = z.enum([
  /** The host's own: the AWS default chain (environment, ~/.aws, an instance or task role). Nothing is stored. */
  "host",
  /** A named profile in the host's ~/.aws config. Only its name is stored. */
  "profile",
  /** An access key (secret, optional session token) kept in the account's home. */
  "keys",
]);
export type BedrockSource = z.infer<typeof BedrockSourceSchema>;

/** Model overrides for a Bedrock account (model or inference-profile IDs); empty keeps Claude Code's own. */
export const BedrockModelsSchema = z.object({
  /** `ANTHROPIC_MODEL`. */
  model: z.string().default(""),
  /** `ANTHROPIC_DEFAULT_OPUS_MODEL`. */
  opus: z.string().default(""),
  /** `ANTHROPIC_DEFAULT_SONNET_MODEL`. */
  sonnet: z.string().default(""),
  /** `ANTHROPIC_DEFAULT_HAIKU_MODEL`. */
  haiku: z.string().default(""),
});
export type BedrockModels = z.infer<typeof BedrockModelsSchema>;

/** An AWS Bedrock account (a Claude account on AWS) as the app sees it. Secrets never leave the host. */
export const BedrockSummarySchema = z.object({
  region: z.string(),
  source: BedrockSourceSchema,
  /** The profile's name, for `profile`. */
  profile: z.string().nullable(),
  /** The access key ID's last four characters, for `keys`. */
  keyHint: z.string().nullable(),
  /** Whether a session token is kept with the access key. */
  sessionToken: z.boolean().default(false),
  models: BedrockModelsSchema,
  /** USD per million tokens, by model as Claude Code names it. */
  prices: z.record(z.string(), ApiPriceSchema).default({}),
  /** This month's tokens; null before the first counted turn. */
  usage: ApiMonthSchema.nullable().default(null),
});
export type BedrockSummary = z.infer<typeof BedrockSummarySchema>;

/** The address an account's requests come from, as the provider's edge sees it. */
export const EgressSchema = z.object({
  /** From the last check that worked. */
  ip: z.string().nullable(),
  /** The country the edge places it in, like "US". */
  country: z.string().nullable(),
  /** When that check was. */
  checkedAt: z.string().nullable(),
  /** Why the latest check failed, when it did. */
  error: z.string().nullable(),
});
export type Egress = z.infer<typeof EgressSchema>;

/** `disabled`: the user set it aside for a while; it stays signed in but nothing is routed to it. */
export const AccountStatusSchema = z.enum(["ready", "signed_out", "limited", "checking", "disabled"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

/** An account projected to this share of its 5-hour window, or already there, is held back when spreading. */
export const PACE_GATE_PERCENT = 80;
/** Weekly use at which an account counts as nearly used up; pacing holds it back. */
export const WEEK_NEARLY_USED_PERCENT = 90;

/** How pacing reads an account (see `paceScore` in server/routing.ts). Sent only while spreading is on. */
export const PaceViewSchema = z.object({
  /** 5-hour use in the latest reading; 0 once that window has reset; null with no 5-hour reading. */
  fiveHourUsed: z.number().nullable(),
  /** `paceScore(...).fiveHour`: projected an hour ahead, pending agents included. */
  fiveHourProjected: z.number(),
  /** The part of `fiveHourProjected` charged for pending agents. */
  pendingFiveHour: z.number(),
  /** Weekly use in the latest reading; 0 once it has reset; null with no weekly reading. */
  weeklyUsed: z.number().nullable(),
  /** Weekly percent charged for pending agents. */
  pendingWeekly: z.number(),
  /** Percent of the week gone at the reading, 0 to 100; null when the reset time is unknown or passed. */
  weekElapsed: z.number().nullable(),
  /** Agents placed here in the last `PENDING_MS` that the reading may not show. */
  pending: z.number(),
  /** `paceScore(...).gated`: new agents go to accounts under the gate first. */
  gated: z.boolean(),
});
export type PaceView = z.infer<typeof PaceViewSchema>;

export const AccountViewSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  label: z.string(),
  kind: AccountKindSchema,
  email: z.string().nullable(),
  plan: z.string().nullable(),
  organization: z.string().nullable(),
  status: AccountStatusSchema,
  /**
   * Set aside by the user. `status` names only one state, and a signed-out account says
   * `signed_out` even when it's also disabled, so this tells whether it needs enabling.
   * False from older servers, which only said so through `status`.
   */
  disabled: z.boolean().default(false),
  isDefault: z.boolean(),
  /** Set while the next new agent of this family will start on this account (one-time pick). */
  nextAgentUntil: z.string().nullable().optional(),
  limitedUntil: z.string().nullable(),
  usage: UsageSchema.nullable(),
  agentCount: z.number(),
  home: z.string().nullable(),
  auth: AuthKindSchema.default("subscription"),
  /** An added Pi account's key (reduced to a hint) and base URL, and Pi's own login's while it keeps an Anthropic key. */
  api: ApiSummarySchema.nullable().default(null),
  /** Its key and base URL can be changed from its card (API accounts, and Pi's own login). */
  apiEditable: z.boolean().default(false),
  /** The account's own proxy, password hidden (as `HIDDEN`). Null when it uses whatever it inherits. */
  proxy: z.string().nullable().default(null),
  /** A proxy can be set for this account here (Claude and Pi accounts, their CLI logins included). */
  proxyEditable: z.boolean().default(false),
  /** Why a proxy can't be set for it just now (the CLI login's, while main's settings would outrank it); null when one can. */
  proxyBlocked: z.string().nullable().default(null),
  /** The proxy it goes through without one of its own, password hidden, and where that's set. */
  inheritedProxy: z.object({ proxy: z.string(), from: z.string() }).nullable().default(null),
  /**
   * The user's file its own proxy is kept in (Pi's own login: `httpProxy` in `~/.pi/agent/settings.json`;
   * Claude's CLI login: `env` in `~/.claude/settings.json`, when that sets one).
   */
  proxyFile: z.string().nullable().default(null),
  /** Added accounts that go through the same proxy, having none of their own, while it's kept in `proxyFile`. */
  proxyFollowers: z.array(z.string()).default([]),
  /** Command (a script in `StateView.launchers` or `StateView.piLaunchers`) that starts the CLI on this account. */
  launcher: z.string().nullable().default(null),
  /** Where the account's requests come from, as Anthropic sees them; null when unknown or not Anthropic. */
  egress: EgressSchema.nullable().default(null),
  /**
   * The home is outside ZeroSub's own `homes/` folder (where added Pi accounts are kept): removing the
   * account only takes it out of ZeroSub, and its folder, key and script stay.
   */
  externalHome: z.boolean().default(false),
  /** Set for an Azure OpenAI account (a ChatGPT/Codex account on an API key); null for any other. */
  azure: AzureSummarySchema.nullable().default(null),
  /** Set for an AWS Bedrock account (a Claude account on AWS); null for any other. */
  bedrock: BedrockSummarySchema.nullable().default(null),
  /** What the provider said when it last refused an Azure or Bedrock account, while it's signed out for it. */
  apiError: z.string().nullable().default(null),
  /**
   * Whether this added Claude account's sessions folder is the CLI's own, so Claude Code started on
   * any account that shares it sees the others' sessions; null where there's no such choice.
   */
  sessionsShared: z.boolean().nullable().default(null),
  /**
   * The account's home is due to move to `to`, and hasn't yet: what it waits for, or what went wrong.
   * `stays`: why it stays where it is instead, which isn't an error (null from older servers).
   */
  moving: z
    .object({ to: z.string(), waiting: z.string().nullable(), error: z.string().nullable(), stays: z.string().nullable().default(null) })
    .nullable()
    .default(null),
  /** How pacing reads this account; null unless spreading is on and it's one of two or more accounts that can stand in. */
  pace: PaceViewSchema.nullable().default(null),
});
export type AccountView = z.infer<typeof AccountViewSchema>;

export const AgentRouteSchema = z.object({
  agentId: z.string(),
  family: FamilySchema,
  /** Account the agent uses now, or will use when its session next opens. */
  accountId: z.string(),
  /** Chosen for this agent explicitly (by the user or an automatic switch) rather than following the default. */
  pinned: z.boolean(),
  /** The live session still runs on a different account and is waiting to be reopened. */
  pendingAccountId: z.string().nullable(),
  /**
   * While `pendingAccountId` is set, when the session moves: `idle` once the agent is idle (within
   * half a minute), `turn` when its current turn ends, `background` once background work it left
   * running stops, `restart` when its session next starts (it isn't moved unattended, reloading it
   * didn't work, or Paseo's CLI isn't there to do it).
   */
  waiting: z.enum(["idle", "turn", "background", "restart"]).nullable().default(null),
  /**
   * The conversation can move to another account in place. False for Codex agents that already
   * have history: ChatGPT accounts can't read each other's encrypted reasoning, so switching
   * continues the work in a new agent instead.
   */
  movable: z.boolean(),
  /** The agent started on this account because its weekly reset was near, and is still on it. */
  selectionReason: z.literal("weekly_reset").optional(),
  /**
   * Whether the Account control can show in this agent's composer: its metadata holds its ID (see
   * `AGENT_METADATA_KEY`), or is being given it. False for an agent from before the control that
   * hasn't opened a session since, and for one that couldn't be given it: the account button stands in.
   */
  inComposer: z.boolean().optional(),
});
export type AgentRoute = z.infer<typeof AgentRouteSchema>;

export const LoginStepSchema = z.enum([
  "starting",
  /** Waiting for the user to finish on the sign-in page (and paste a code, if using `codeUrl`). */
  "waiting",
  "verifying",
  "done",
  "failed",
  "canceled",
]);
export type LoginStep = z.infer<typeof LoginStepSchema>;

export const LoginMethodSchema = z.enum([
  /** Finishes by itself when the link is opened on the daemon machine. */
  "browser",
  /** Works from any device: paste a code back (Claude) or type a code on the page (ChatGPT). */
  "code",
]);
export type LoginMethod = z.infer<typeof LoginMethodSchema>;

export const LoginViewSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  method: LoginMethodSchema,
  /** Set once the account exists (immediately when signing an existing account back in). */
  accountId: z.string().nullable(),
  step: LoginStepSchema,
  /** Link that completes by itself (browser callback) or the device-code page. */
  url: z.string().nullable(),
  /** Link whose page shows a code to paste back; works from any device. */
  codeUrl: z.string().nullable(),
  /** Device code the user types on the sign-in page (ChatGPT device flow). */
  userCode: z.string().nullable(),
  message: z.string().nullable(),
  startedAt: z.string(),
});
export type LoginView = z.infer<typeof LoginViewSchema>;

/**
 * Agent metadata (Paseo 0.16 and later) naming the account a new agent starts on. The account
 * control in a composer that has no agent yet sets it, and anything else that creates an agent can
 * (`paseo.agents.create({ metadata })`). Routing reads it once, when the agent is created.
 */
export const ACCOUNT_METADATA_KEY = "zerosub.account";

/**
 * Agent metadata holding the agent's own ID. Paseo doesn't tell a composer item which agent's
 * composer it sits in, only that agent's metadata, so the daemon writes the ID there and the
 * Account control reads it back to find the agent's account.
 */
export const AGENT_METADATA_KEY = "zerosub.agent";

export const StateViewSchema = z.object({
  accounts: z.array(AccountViewSchema),
  agents: z.array(AgentRouteSchema),
  logins: z.array(LoginViewSchema),
  /** Paseo provider IDs (including custom profiles) that route through each family. */
  providers: z.record(z.string(), FamilySchema),
  /** Live sessions can be reopened on another account without waiting for the next session start. */
  canReopen: z.boolean(),
  /**
   * A browser on the daemon's machine can finish a sign-in by itself. False on servers, containers
   * and daemons started over SSH, where only the code sign-in works.
   */
  browserSignIn: z.boolean().default(true),
  /** Directory with a `claude-<account>.sh` script per added Claude account, to put on `PATH`. */
  launchers: z.string().nullable().default(null),
  /** Directory with a `pi-<account>.sh` script per added Pi account, to put on `PATH`. */
  piLaunchers: z.string().nullable().default(null),
  /** The folder added Pi accounts' homes are kept in (`~/.pi-config`, say), and whether it's the default. */
  piHomes: z.object({ dir: z.string(), isDefault: z.boolean() }).nullable().default(null),
  /** The folder added Claude accounts' homes are kept in (`~/.claude-config`, say), and whether it's the default. */
  claudeHomes: z.object({ dir: z.string(), isDefault: z.boolean() }).nullable().default(null),
  showComposerPill: z.boolean(),
  /** The account pill shows on a running agent while its Account control isn't on screen. */
  keepComposerPill: z.boolean().default(true),
  /** This host's Paseo lists OpenCode as available, so "Continue on OpenCode" can work. */
  openCodeAvailable: z.boolean().default(false),
  /** Accounts at their limit are skipped, so agents can't be moved onto one by hand either. */
  autoSwitch: z.boolean().default(true),
  /** New agents without an account of their own start on the one with the most room, not on the default. */
  balanceNewAgents: z.boolean().optional(),
  /** While spreading is on: per family, the account a new agent naming none would start on. */
  pacedNext: z.record(z.string(), z.string()).optional(),
  /**
   * This host's Paseo keeps agent metadata (0.16 and later), which carries the Account control's
   * choice for a new agent and tells it which running agent it belongs to. Without it the control
   * isn't shown, and the account button stays: an app from 0.16 would take the choice and then fail
   * to create the agent on an older host.
   */
  agentMetadata: z.boolean().optional(),
  /** Paid API accounts (Azure OpenAI, AWS Bedrock) may take work over by themselves once every subscription is out. */
  paidApiFallback: z.boolean().optional(),
  /** "Keep going after a switch": the follow-up goes out after a switch or a banked reset. */
  autoContinue: z.boolean().default(true),
  warnings: z.array(z.string()),
});
export type StateView = z.infer<typeof StateViewSchema>;
