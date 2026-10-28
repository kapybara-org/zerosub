import { z } from "zod";

/** The two subscription families this plugin manages. Custom provider profiles map onto one of them. */
export const FamilySchema = z.enum(["claude", "codex"]);
export type Family = z.infer<typeof FamilySchema>;

export const FAMILY_LABEL: Record<Family, string> = {
  claude: "Claude",
  codex: "ChatGPT",
};

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

/** `disabled`: the user set it aside for a while; it stays signed in but nothing is routed to it. */
export const AccountStatusSchema = z.enum(["ready", "signed_out", "limited", "checking", "disabled"]);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const AccountViewSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  label: z.string(),
  kind: AccountKindSchema,
  email: z.string().nullable(),
  plan: z.string().nullable(),
  organization: z.string().nullable(),
  status: AccountStatusSchema,
  isDefault: z.boolean(),
  limitedUntil: z.string().nullable(),
  usage: UsageSchema.nullable(),
  agentCount: z.number(),
  home: z.string().nullable(),
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

/** One OAuth account in OMP's own credential store. OMP picks between them itself; ZeroSub only shows them. */
export const OmpAccountViewSchema = z.object({
  /** OMP provider id, e.g. `anthropic`, `openai-codex`. */
  provider: z.string(),
  credentialId: z.number().int(),
  label: z.string(),
  windows: z.array(UsageWindowSchema),
  /** When OMP read the usage shown; older than the snapshot when the latest read had none. */
  usageAt: z.string().nullable(),
  resets: ResetOfferSchema.nullable(),
  /** OMP identifies the account well enough for ZeroSub to set a preference or reserve for it. */
  controllable: z.boolean(),
  /** New OMP agents prefer this account while it has room. */
  preferred: z.boolean(),
  /** Quota OMP keeps unused on this account; null uses OMP's own reserve. */
  reservePct: z.number().nullable(),
});
export type OmpAccountView = z.infer<typeof OmpAccountViewSchema>;

export const OmpLoginViewSchema = z.object({
  id: z.string(),
  provider: z.string(),
  step: LoginStepSchema,
  url: z.string().nullable(),
  /** OMP's own hint, e.g. the device code to enter on the page. */
  instructions: z.string().nullable(),
  /** OMP is waiting for the authorization code or the final redirect URL to be pasted back. */
  codePrompt: z.string().nullable(),
  message: z.string().nullable(),
});
export type OmpLoginView = z.infer<typeof OmpLoginViewSchema>;

/**
 * OMP settings ZeroSub sets for the OMP agents Paseo starts, keyed by OMP's own setting path.
 * An absent key leaves OMP's own setting in charge.
 */
export const OmpSettingsSchema = z.object({
  "retry.usageReservePolicy": z.enum(["confirm", "auto", "fail-closed"]).optional(),
  "retry.waitForUsageReset": z.boolean().optional(),
  "codexResets.autoRedeem": z.enum(["yes", "no"]).optional(),
  "codexResets.keepCredits": z.number().int().min(0).optional(),
  "claudeResets.autoRedeem": z.enum(["yes", "no"]).optional(),
  "claudeResets.keepCredits": z.number().int().min(0).optional(),
});
export type OmpSettings = z.infer<typeof OmpSettingsSchema>;

export const OmpViewSchema = z.object({
  /** Providers with accounts, plus the ones offered for sign-in. */
  providers: z.array(z.object({ id: z.string(), name: z.string() })),
  accounts: z.array(OmpAccountViewSchema),
  logins: z.array(OmpLoginViewSchema),
  fetchedAt: z.string().nullable(),
  error: z.string().nullable(),
  settings: OmpSettingsSchema,
  /** OMP's own values for those settings (and `retry.usageReservePct`), shown as the default. */
  defaults: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  /** The user's OMP config has its own `auth.accountPolicies`, so ZeroSub leaves preferences alone. */
  policiesLocked: z.boolean(),
  /** Where new OMP sessions would go right now (`omp dry-balance`), per provider with several accounts. */
  preview: z.array(
    z.object({ provider: z.string(), model: z.string(), accounts: z.array(z.object({ label: z.string(), percent: z.number() })) }),
  ),
});
export type OmpView = z.infer<typeof OmpViewSchema>;

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
  showComposerPill: z.boolean(),
  warnings: z.array(z.string()),
  /** OMP's accounts; absent when the `omp` CLI isn't installed on this host. */
  omp: OmpViewSchema.optional(),
});
export type StateView = z.infer<typeof StateViewSchema>;
