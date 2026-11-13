import { z } from "zod";

/**
 * The provider families this plugin manages: the two subscription CLIs, and Pi, whose added accounts
 * are Anthropic API keys. Custom provider profiles map onto one of them.
 */
export const FamilySchema = z.enum(["claude", "codex", "pi"]);
export type Family = z.infer<typeof FamilySchema>;
export const FAMILIES: readonly Family[] = FamilySchema.options;

export const FAMILY_LABEL: Record<Family, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  pi: "Pi",
};

/**
 * The provider a stopped chat can carry on with when every account of its own is out (Claude ↔
 * ChatGPT); null for Pi, whose added accounts are billed per use and never take work over by themselves.
 */
export const OTHER_FAMILY: Record<Family, Family | null> = { claude: "codex", codex: "claude", pi: null };

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

export const UsageSchema = z.object({
  fetchedAt: z.string(),
  windows: z.array(UsageWindowSchema),
  /** Why usage could not be read, if it could not. Old windows may still be shown. */
  error: z.string().nullable(),
  /** Read from the CLI's own cache rather than the provider, so possibly out of date. */
  cached: z.boolean().default(false),
  /** Banked resets, when the provider reports any. */
  resets: ResetOfferSchema.nullable().default(null),
  /** Credits the account can spend past full windows, when the provider reports any. */
  credits: CreditsSchema.nullable().default(null),
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
  /** Signed in with a Claude or ChatGPT subscription. */
  "subscription",
  /** An API key or token, optionally against another base URL. Billed per use, so never picked automatically. */
  "api",
]);
export type AuthKind = z.infer<typeof AuthKindSchema>;

export const ApiKeyKindSchema = z.enum([
  /** `ANTHROPIC_API_KEY`, sent as `x-api-key`. */
  "api_key",
  /** `ANTHROPIC_AUTH_TOKEN`, sent as `Authorization: Bearer`. */
  "auth_token",
]);
export type ApiKeyKind = z.infer<typeof ApiKeyKindSchema>;

/** Claude Code's own switches; each is off unless the user turns it on. */
export const TrafficSwitchesSchema = z.object({
  /** `DISABLE_TELEMETRY`. */
  disableTelemetry: z.boolean().default(false),
  /** `DISABLE_ERROR_REPORTING`. */
  disableErrorReporting: z.boolean().default(false),
  /** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`: everything not needed to talk to the model. */
  disableNonessentialTraffic: z.boolean().default(false),
});
export type TrafficSwitches = z.infer<typeof TrafficSwitchesSchema>;

/** An API account's settings as shown in the app; the key itself never leaves the host. */
export const ApiSummarySchema = TrafficSwitchesSchema.extend({
  /** Left out by providers whose accounts only take an API key (Pi's). */
  keyKind: ApiKeyKindSchema.default("api_key"),
  /** The key's last four characters, or empty for a key too short to show any of it. */
  keyHint: z.string(),
  /** `ANTHROPIC_BASE_URL`, or null for Anthropic's own API. */
  baseUrl: z.string().nullable(),
});
/** As an adapter gives it: the kind and switches may be left out, and are filled in for the client. */
export type ApiSummary = z.input<typeof ApiSummarySchema>;

/** `disabled`: the user set it aside for a while; it stays signed in but nothing is routed to it. */
export const AccountStatusSchema = z.enum(["ready", "signed_out", "limited", "checking", "disabled"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountViewSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  label: z.string(),
  kind: AccountKindSchema,
  auth: AuthKindSchema.default("subscription"),
  /** Set for `api` accounts, and for Pi's CLI login while it keeps an Anthropic API key. */
  api: ApiSummarySchema.nullable().default(null),
  /**
   * Its Anthropic key and base URL can be changed from its card: `api` accounts, and Pi's CLI login
   * (in Pi's own `auth.json` and `models.json`). False from older servers.
   */
  apiEditable: z.boolean().default(false),
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
  /**
   * The home is outside ZeroSub's own `homes/` folder: where added Claude accounts are kept
   * (`StateView.claudeHomes`), or somewhere the user moved it. Removing the account then only takes
   * it out of ZeroSub: its sign-in, files and launcher stay. False from older servers.
   */
  externalHome: z.boolean().default(false),
  /** The account's own proxy, password hidden (as `HIDDEN`). Null when it uses whatever the CLI inherits. */
  proxy: z.string().nullable().default(null),
  /** ZeroSub can set a proxy for this account (Claude accounts, the CLI login included). */
  proxyEditable: z.boolean().default(false),
  /**
   * The proxy the account goes through when it has none of its own, password hidden, and where
   * that's set (`~/.claude/settings.json`, say). Null when that's direct, and from older servers.
   */
  inheritedProxy: z.object({ proxy: z.string(), from: z.string() }).nullable().default(null),
  /** Why a proxy can't be set here for this account just now; null when it can. */
  proxyBlocked: z.string().nullable().default(null),
  /**
   * The user's file the account's own proxy is kept in, where setting one changes it: the CLI
   * login's, while `~/.claude/settings.json` sets one. Null when ZeroSub keeps it.
   */
  proxyFile: z.string().nullable().default(null),
  /** Added accounts that go through the same proxy, having none of their own, while it's kept in `proxyFile`. */
  proxyFollowers: z.array(z.string()).default([]),
  /** Command (a script in `StateView.launchers`) that starts the CLI on this account. */
  launcher: z.string().nullable().default(null),
  /**
   * Where the account's requests come from, as Anthropic sees them. Null before the first check,
   * for providers that don't say, and when the account's requests go to another base URL first.
   */
  egress: EgressSchema.nullable().default(null),
  /**
   * The account's home is due to move to `to`, where added Claude accounts are kept, and hasn't yet:
   * what it waits for (Claude Code running on it, say), or what went wrong. Null when it stays.
   */
  moving: z.object({ to: z.string(), waiting: z.string().nullable(), error: z.string().nullable() }).nullable().default(null),
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
  /** Directory with a `claude-<account>` script per added Claude account, to put on `PATH`. */
  launchers: z.string().nullable().default(null),
  /**
   * The folder added Claude accounts' homes are kept in (`~/.claude-config`, say), and whether it's
   * the default. Null from older servers, which keep them in ZeroSub's own folder.
   */
  claudeHomes: z.object({ dir: z.string(), isDefault: z.boolean() }).nullable().default(null),
  /** Directory with a `pi-<account>` script per added Pi account, to put on `PATH`. */
  piLaunchers: z.string().nullable().default(null),
  /** The folder added Pi accounts' homes are kept in (`~/.pi-config`, say), and whether it's the default. */
  piHomes: z.object({ dir: z.string(), isDefault: z.boolean() }).nullable().default(null),
  showComposerPill: z.boolean(),
  /** Accounts at their limit are skipped, so agents can't be moved onto one by hand either. */
  autoSwitch: z.boolean().default(false),
  /** "Keep going after a switch": the follow-up goes out after a switch or a banked reset. */
  autoContinue: z.boolean().default(true),
  warnings: z.array(z.string()),
});
export type StateView = z.infer<typeof StateViewSchema>;
