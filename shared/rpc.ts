import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ApiKeyKindSchema, ApiPriceSchema, BedrockSourceSchema, FamilySchema, LoginMethodSchema, LoginViewSchema, StateViewSchema, TrafficSwitchesSchema } from "./model";

export const getState = defineRpc({
  name: "zerosub.state",
  input: z.object({
    refreshUsage: z.boolean().optional(),
    /** With `refreshUsage`, only this account's usage is read. */
    accountId: z.string().optional(),
  }),
  output: StateViewSchema,
});

export const startLogin = defineRpc({
  name: "zerosub.login.start",
  input: z.object({
    family: FamilySchema,
    /** Sign an existing account back in instead of adding a new one. */
    accountId: z.string().optional(),
    method: LoginMethodSchema.default("browser"),
    /** A new account's proxy, set before the CLI signs in so the sign-in goes through it too. */
    proxy: z.string().trim().max(2048).optional(),
    /** A new Claude account starts on the default sessions folder, `~/.claude/sessions` (see `setAccountSessionsShared`). */
    shareSessions: z.boolean().optional(),
  }),
  output: LoginViewSchema,
});

export const submitLoginCode = defineRpc({
  name: "zerosub.login.code",
  input: z.object({ loginId: z.string(), code: z.string().trim().min(1) }),
  output: LoginViewSchema,
});

export const cancelLogin = defineRpc({
  name: "zerosub.login.cancel",
  input: z.object({ loginId: z.string() }),
  output: LoginViewSchema.nullable(),
});

export const setQuotaCeiling = defineRpc({
  name: "zerosub.accounts.quota-ceiling",
  input: z.object({ accountId: z.string(), windowId: z.string().min(1).max(128), percent: z.number().int().min(1).max(100) }),
  output: z.object({ ok: z.literal(true) }),
});

export const renameAccount = defineRpc({
  name: "zerosub.accounts.rename",
  input: z.object({ accountId: z.string(), label: z.string().trim().min(1).max(40) }),
  output: z.object({ ok: z.literal(true) }),
});

const ApiFieldsSchema = TrafficSwitchesSchema.extend({
  /** Left out for a Pi account, which only takes an API key. */
  keyKind: ApiKeyKindSchema.optional(),
  /** Empty or omitted when editing: keep the current key. */
  key: z.string().trim().max(4096).optional(),
  /** Empty for Anthropic's own API. */
  baseUrl: z.string().trim().max(2048).optional(),
});

/**
 * Adds an account that uses an API key or token instead of a subscription: a Claude one, or a Pi one
 * (an Anthropic API key Pi agents on it use), with an optional base URL and proxy.
 */
export const addApiAccount = defineRpc({
  name: "zerosub.accounts.api.add",
  input: ApiFieldsSchema.extend({
    /** Left out, it's a Claude one when `keyKind` is given and a Pi one otherwise. */
    family: z.enum(["claude", "pi"]).optional(),
    label: z.string().trim().min(1).max(40),
    key: z.string().trim().min(1).max(4096),
    proxy: z.string().trim().max(2048).optional(),
    /** A new Claude account starts on the default sessions folder, `~/.claude/sessions` (see `setAccountSessionsShared`). */
    shareSessions: z.boolean().optional(),
  }),
  output: z.object({ accountId: z.string() }),
});

/** Changes an API account's key (empty or omitted keeps it), base URL or traffic switches; Pi's own login's too. */
export const updateApiAccount = defineRpc({
  name: "zerosub.accounts.api.update",
  input: ApiFieldsSchema.extend({ accountId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

/**
 * Adds an Azure OpenAI account under ChatGPT (Codex): an endpoint and an API key. The key is checked
 * against the endpoint first; a refused one isn't saved, and `warning` says when it couldn't be checked.
 */
export const addAzureAccount = defineRpc({
  name: "zerosub.accounts.azure.add",
  input: z.object({
    label: z.string().trim().min(1).max(40),
    /** `https://<resource>.openai.azure.com/openai/v1`; a bare resource URL gets `/openai/v1`. */
    endpoint: z.string().trim().min(1).max(2048),
    key: z.string().trim().min(1).max(4096),
  }),
  output: z.object({ accountId: z.string(), warning: z.string().nullable() }),
});

/** Changes an Azure OpenAI account's endpoint, key (empty or omitted keeps it) or price table (USD per million tokens, by model). */
export const updateAzureAccount = defineRpc({
  name: "zerosub.accounts.azure.update",
  input: z.object({
    accountId: z.string(),
    endpoint: z.string().trim().max(2048).optional(),
    key: z.string().trim().max(4096).optional(),
    prices: z.record(z.string().trim().max(200), ApiPriceSchema).optional(),
  }),
  output: z.object({ ok: z.literal(true), warning: z.string().nullable() }),
});

const BedrockFields = {
  /** An AWS region code, like `eu-central-1`. */
  region: z.string().trim().min(1).max(40),
  source: BedrockSourceSchema,
  /** For `profile`: a profile in the host's ~/.aws config. Only its name is stored. */
  profile: z.string().trim().max(128).optional(),
  /** For `keys`. The secret and session token are written to the account's home and never sent back. */
  accessKeyId: z.string().trim().max(128).optional(),
  secretAccessKey: z.string().trim().max(1024).optional(),
  sessionToken: z.string().trim().max(4096).optional(),
  /** Model or inference-profile IDs for ANTHROPIC_MODEL and the Opus, Sonnet and Haiku defaults; empty keeps Claude Code's. */
  models: z
    .object({
      model: z.string().trim().max(200).optional(),
      opus: z.string().trim().max(200).optional(),
      sonnet: z.string().trim().max(200).optional(),
      haiku: z.string().trim().max(200).optional(),
    })
    .optional(),
};

/**
 * Adds an AWS Bedrock account under Claude. Its credentials are checked with the host's `aws` CLI
 * first, when it has one; refused ones aren't saved, and `warning` says when they couldn't be checked.
 */
export const addBedrockAccount = defineRpc({
  name: "zerosub.accounts.bedrock.add",
  input: z.object({
    label: z.string().trim().min(1).max(40),
    ...BedrockFields,
    /** A new Claude account starts on the default sessions folder, `~/.claude/sessions` (see `setAccountSessionsShared`). */
    shareSessions: z.boolean().optional(),
  }),
  output: z.object({ accountId: z.string(), warning: z.string().nullable() }),
});

/** Changes an AWS Bedrock account's region, credentials (an empty secret keeps it), models or price table. */
export const updateBedrockAccount = defineRpc({
  name: "zerosub.accounts.bedrock.update",
  input: z.object({
    accountId: z.string(),
    ...BedrockFields,
    region: BedrockFields.region.optional(),
    source: BedrockFields.source.optional(),
    prices: z.record(z.string().trim().max(200), ApiPriceSchema).optional(),
  }),
  output: z.object({ ok: z.literal(true), warning: z.string().nullable() }),
});

/**
 * The AWS region the host's own setup names (its environment, ~/.aws/config, or the EC2 instance it
 * runs on), to fill in the Bedrock form. Asked for only when that form opens, and answered within a
 * couple of seconds, with null when the host names none.
 */
export const detectBedrockRegion = defineRpc({
  name: "zerosub.accounts.bedrock.region",
  input: z.object({}),
  output: z.object({ region: z.string().nullable(), source: z.enum(["environment", "config", "instance"]).nullable() }),
});

/** Sets a Claude or Pi account's proxy (their CLI logins' included); an empty value clears it. */
export const setAccountProxy = defineRpc({
  name: "zerosub.accounts.proxy",
  input: z.object({ accountId: z.string(), proxy: z.string().trim().max(2048) }),
  output: z.object({ ok: z.literal(true), proxy: z.string().nullable() }),
});

/** Shares an added Claude account's sessions folder with the CLI's own, or gives it its own again. */
export const setAccountSessionsShared = defineRpc({
  name: "zerosub.accounts.sessions",
  input: z.object({ accountId: z.string(), shared: z.boolean() }),
  output: z.object({ ok: z.literal(true), shared: z.boolean() }),
});

/**
 * Changes the folder added Claude accounts' homes are kept in (empty: the default, `~/.claude-config`);
 * the accounts kept before move there. `moving`: how many are due to move.
 */
export const setClaudeHomesDir = defineRpc({
  name: "zerosub.accounts.homes",
  input: z.object({ dir: z.string().trim().max(1024) }),
  output: z.object({ ok: z.literal(true), dir: z.string(), moving: z.number() }),
});

/** Adds a folder Claude Code is signed in with already as a Claude account, where it is. */
export const importAccount = defineRpc({
  name: "zerosub.accounts.import",
  input: z.object({ path: z.string().trim().min(1).max(1024) }),
  output: z.object({ accountId: z.string() }),
});

/**
 * Changes the folder added Pi accounts' homes are kept in (empty: the default, `~/.pi-config`); the
 * accounts kept before move there. `moving`: how many are due to move.
 */
export const setPiHomesDir = defineRpc({
  name: "zerosub.accounts.pi.homes",
  input: z.object({ dir: z.string().trim().max(1024) }),
  output: z.object({ ok: z.literal(true), dir: z.string(), moving: z.number() }),
});

/** Adds back a Pi account from the folder ZeroSub kept when it was removed. */
export const importPiAccount = defineRpc({
  name: "zerosub.accounts.pi.import",
  input: z.object({ path: z.string().trim().min(1).max(1024) }),
  output: z.object({ accountId: z.string() }),
});

export const ReopenSummarySchema = z.object({
  reopened: z.array(z.string()),
  /** Busy agents move when their current turn ends. */
  deferred: z.array(z.string()),
  failed: z.array(z.object({ agentId: z.string(), error: z.string() })),
  /** Still being moved when the answer was sent; the move goes on, and each agent's timeline says how it went. */
  pending: z.array(z.string()).default([]),
  /** A conversation that could not move in place and continues in this account's agent instead. */
  continuedIn: z.object({ agentId: z.string(), title: z.string() }).nullable().default(null),
});
export type ReopenSummary = z.infer<typeof ReopenSummarySchema>;

/** `movedAgents`: how many agents ran on the account. `moves`: how moving them went (older servers don't say). */
export const removeAccount = defineRpc({
  name: "zerosub.accounts.remove",
  /** `signOut`: also sign out an account whose folder stays (one kept outside ZeroSub's own); an older server ignores it. */
  input: z.object({ accountId: z.string(), signOut: z.boolean().optional() }),
  output: z.object({ ok: z.literal(true), movedAgents: z.number(), moves: ReopenSummarySchema.optional() }),
});

export const clearAccountLimit = defineRpc({
  name: "zerosub.accounts.available",
  input: z.object({ accountId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

export const RedeemOutcomeSchema = z.enum([
  /** Limits were refilled. */
  "reset",
  /** The provider kept the reset because the account isn't at a limit. */
  "not_limited",
  /** No banked reset to use. */
  "none",
  "already_used",
  /** Resets are cooling down; try later. */
  "cooldown",
  /** The provider won't let this account use a reset right now. */
  "unavailable",
  /** The request failed or its result is unknown. */
  "error",
  /** Still going when the answer was sent (or one already was); the account's usage shows the result. */
  "pending",
]);
export type RedeemOutcome = z.infer<typeof RedeemOutcomeSchema>;

export const RedeemResultSchema = z.object({
  outcome: RedeemOutcomeSchema,
  message: z.string(),
  /** Resets left afterwards, when the provider says. */
  left: z.number().nullable(),
  /** The agent the reset was used for, if any, was told to carry on. */
  continued: z.boolean(),
});
export type RedeemResult = z.infer<typeof RedeemResultSchema>;

export const redeemReset = defineRpc({
  name: "zerosub.accounts.redeem",
  input: z.object({
    accountId: z.string(),
    /** An agent stopped by this account's limit; it carries on after a successful reset. */
    agentId: z.string().optional(),
  }),
  output: RedeemResultSchema,
});

export const setNextAgentAccount = defineRpc({
  name: "zerosub.accounts.next_agent",
  input: z.object({ accountId: z.string(), enabled: z.boolean() }),
  output: z.object({ until: z.string().nullable() }),
});

export const setDefaultAccount = defineRpc({
  name: "zerosub.accounts.default",
  input: z.object({ accountId: z.string() }),
  output: ReopenSummarySchema,
});

/** Sets an account aside for a while (nothing is routed to it) or brings it back. */
export const setAccountEnabled = defineRpc({
  name: "zerosub.accounts.enabled",
  input: z.object({ accountId: z.string(), enabled: z.boolean() }),
  output: ReopenSummarySchema.extend({
    /** ChatGPT conversations that stay on the disabled account because they can't change accounts. */
    stayed: z.number(),
  }),
});

/** Carries an agent's work on in a new agent on the other provider (Claude ↔ ChatGPT), or on this host's OpenCode. */
export const forkAgent = defineRpc({
  name: "zerosub.agents.fork",
  input: z.object({ agentId: z.string(), destination: z.enum(["other", "opencode"]).default("other") }),
  output: z.object({
    agentId: z.string(),
    title: z.string(),
    /**
     * Whether the conversation was delivered: `sent` and confirmed, `up-to-date` (nothing new to
     * send), `found` (an existing continuation without a provable checkpoint; nothing was sent),
     * or `uncertain` (a previous handoff has no trustworthy receipt; nothing more was sent).
     */
    delivery: z.enum(["sent", "up-to-date", "found", "uncertain"]).default("sent"),
  }),
});

/** One piece of background work an agent left running after its turn, as Paseo describes it. */
export const BackgroundJobSchema = z.object({
  /** Paseo's kind: `shell`, `monitor` (a watcher), or `other`. */
  kind: z.string(),
  description: z.string().nullable(),
  command: z.string().nullable(),
});
export type BackgroundJob = z.infer<typeof BackgroundJobSchema>;

/**
 * Why `zerosub.agents.move_before_limit` didn't move the agent, for a caller to act on (`detail` is
 * display text). Callers treat an unknown value as `refused` with nothing to retry.
 */
export const MoveBeforeLimitReasonSchema = z.enum([
  /** `waiting`: a turn is running. Ask again once it ends. */
  "busy_turn",
  /** `waiting`: background work is running (see `backgroundWork`). Ask again once it ends, or with `stopBackgroundWork`. */
  "background_work",
  /** Automatic switching is off in ZeroSub's settings. */
  "auto_switch_off",
  /** The agent is closed, archived or gone. */
  "not_open",
  /** The agent's conversation can't change accounts in place (Codex, Grok, Cursor, Antigravity). */
  "unsupported_provider",
  /** The account is missing, of another provider, an API key or paid stand-in, or can't take the agent now. */
  "ineligible_target",
  /** The agent is pinned to an account by the user or `zerosub.agents.account`. */
  "user_pinned",
  /** It changed accounts too often in the last 10 minutes. Ask again later. */
  "switch_guard",
  /** Another move of this agent is under way. Ask again shortly. */
  "in_progress",
  /** The reload failed; the agent stays where it was. Ask again later. */
  "reload_failed",
  /** The reload worked, but the agent opened on another account (`accountId`): the target couldn't take it by then. */
  "landed_elsewhere",
]);
export type MoveBeforeLimitReason = z.infer<typeof MoveBeforeLimitReasonSchema>;

export const MoveBeforeLimitResultSchema = z.object({
  /**
   * `moved`: it runs on the account now. `already`: it ran there already. `waiting`: nothing changed;
   * a turn or background work is running (`waitingFor`), so ask again later. `pending`: the reload
   * outlasted the answer and goes on; `zerosub.state` and the timeline say where it lands.
   * `refused`: not moved (`reason`). Releases before `reason` was added answered `waiting` for a
   * move they left queued instead.
   */
  outcome: z.enum(["moved", "waiting", "already", "refused", "pending"]),
  /** Machine-readable cause for `waiting` and `refused`; null otherwise. */
  reason: MoveBeforeLimitReasonSchema.nullable().default(null),
  /** Asking again as is can succeed later (see `reason`). */
  retryable: z.boolean().default(false),
  /** The account the agent's live session runs on when ZeroSub answered, or null when it has none. */
  accountId: z.string().nullable().default(null),
  /** Display text; not for matching. */
  detail: z.string().nullable(),
  /** For `waiting`: a running `turn` or `background` work. Null otherwise. */
  waitingFor: z.enum(["turn", "background"]).nullable().default(null),
  /** For `waiting` on background work: the jobs still running. */
  backgroundWork: z.array(BackgroundJobSchema).default([]),
  /**
   * Background work this call ended. On `moved` and `pending`: what it stopped, and what the reload
   * ended. Otherwise only the stops Paseo confirmed, which stay stopped though the agent didn't move.
   */
  stopped: z.array(BackgroundJobSchema).default([]),
});
export type MoveBeforeLimitResult = z.infer<typeof MoveBeforeLimitResultSchema>;

/**
 * Moves one agent, between turns, to the named account before its own account is at its limit. For a
 * plugin that stops a session at its own threshold below 100% (where ZeroSub sees no limit yet), so
 * it can move the session to an account with room instead of holding it. The move is ZeroSub's own,
 * as after a limit: the agent isn't pinned to the account, and every guard of an automatic move
 * applies. See README, Plugin contracts.
 */
export const moveBeforeLimit = defineRpc({
  name: "zerosub.agents.move_before_limit",
  input: z.object({
    agentId: z.string(),
    accountId: z.string(),
    /**
     * Move now even though the agent has background work: stop the work Paseo can stop, then reopen
     * it (which ends the rest). Off by default: the answer is `waiting` while background work runs.
     * Work the daemon owns (heartbeats, its own jobs) outlives a reopen and never holds one back.
     */
    stopBackgroundWork: z.boolean().optional(),
  }),
  output: MoveBeforeLimitResultSchema,
});

export const setAgentAccount = defineRpc({
  name: "zerosub.agents.account",
  input: z.object({
    agentId: z.string(),
    /** `null` makes the agent follow the default account again. */
    accountId: z.string().nullable(),
    /**
     * Keep the agent on `accountId` even while that account is at its limit, for an account that
     * keeps working past it (extra usage). Needs an account; signed-out and disabled ones still swap.
     */
    allowLimited: z.boolean().optional(),
  }),
  output: ReopenSummarySchema,
});
