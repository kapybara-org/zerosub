import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { ApiKeyKindSchema, FamilySchema, LoginMethodSchema, LoginViewSchema, StateViewSchema, TrafficSwitchesSchema } from "./model";

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
    /** A new Claude account's proxy, in place before the sign-in starts. Ignored when signing back in. */
    proxy: z.string().trim().max(2048).optional(),
  }),
  output: LoginViewSchema,
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
 * (an Anthropic API key Pi agents on it use).
 */
export const addApiAccount = defineRpc({
  name: "zerosub.accounts.api.add",
  input: ApiFieldsSchema.extend({
    /** Left out, it's a Claude one when `keyKind` is given and a Pi one otherwise. */
    family: z.enum(["claude", "pi"]).optional(),
    label: z.string().trim().min(1).max(40),
    key: z.string().trim().min(1).max(4096),
    proxy: z.string().trim().max(2048).optional(),
  }),
  output: z.object({ accountId: z.string() }),
});

/**
 * Adds a Claude account from a folder Claude Code is signed in with already (its `CLAUDE_CONFIG_DIR`),
 * as it is and where it is.
 */
export const importAccount = defineRpc({
  name: "zerosub.accounts.import",
  input: z.object({ path: z.string().trim().min(1).max(1024) }),
  output: z.object({ accountId: z.string() }),
});

/** Changes an API account's key, base URL or traffic switches. */
export const updateApiAccount = defineRpc({
  name: "zerosub.accounts.api.update",
  input: ApiFieldsSchema.extend({ accountId: z.string() }),
  output: z.object({ ok: z.literal(true) }),
});

/** Sets a Claude or Pi account's proxy (the CLI login's included); an empty value clears it. */
export const setAccountProxy = defineRpc({
  name: "zerosub.accounts.proxy",
  input: z.object({ accountId: z.string(), proxy: z.string().trim().max(2048) }),
  output: z.object({ ok: z.literal(true), proxy: z.string().nullable() }),
});

/**
 * Changes the folder added Claude accounts' homes are kept in (empty: the default); the accounts kept
 * before move there. `moving`: how many are due to move.
 */
export const setClaudeHomesDir = defineRpc({
  name: "zerosub.accounts.homes",
  input: z.object({ dir: z.string().trim().max(1024) }),
  output: z.object({ ok: z.literal(true), dir: z.string(), moving: z.number() }),
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

export const renameAccount = defineRpc({
  name: "zerosub.accounts.rename",
  input: z.object({ accountId: z.string(), label: z.string().trim().min(1).max(40) }),
  output: z.object({ ok: z.literal(true) }),
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
  input: z.object({ accountId: z.string() }),
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

/** Carries an agent's work on in a new agent on the other provider (Claude ↔ ChatGPT). */
export const forkAgent = defineRpc({
  name: "zerosub.agents.fork",
  input: z.object({ agentId: z.string() }),
  output: z.object({ agentId: z.string(), title: z.string() }),
});

export const setAgentAccount = defineRpc({
  name: "zerosub.agents.account",
  input: z.object({
    agentId: z.string(),
    /** `null` makes the agent follow the default account again. */
    accountId: z.string().nullable(),
  }),
  output: ReopenSummarySchema,
});
