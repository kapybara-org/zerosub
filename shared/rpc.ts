import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { FamilySchema, LoginMethodSchema, LoginViewSchema, OmpLoginViewSchema, StateViewSchema } from "./model";

export const getState = defineRpc({
  name: "zerosub.state",
  input: z.object({ refreshUsage: z.boolean().optional() }),
  output: StateViewSchema,
});

export const startLogin = defineRpc({
  name: "zerosub.login.start",
  input: z.object({
    family: FamilySchema,
    /** Sign an existing account back in instead of adding a new one. */
    accountId: z.string().optional(),
    method: LoginMethodSchema.default("browser"),
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

export const renameAccount = defineRpc({
  name: "zerosub.accounts.rename",
  input: z.object({ accountId: z.string(), label: z.string().trim().min(1).max(40) }),
  output: z.object({ ok: z.literal(true) }),
});

export const removeAccount = defineRpc({
  name: "zerosub.accounts.remove",
  input: z.object({ accountId: z.string() }),
  output: z.object({ ok: z.literal(true), movedAgents: z.number() }),
});

export const ReopenSummarySchema = z.object({
  reopened: z.array(z.string()),
  /** Busy agents move when their current turn ends. */
  deferred: z.array(z.string()),
  failed: z.array(z.object({ agentId: z.string(), error: z.string() })),
  /** A conversation that could not move in place and continues in this account's agent instead. */
  continuedIn: z.object({ agentId: z.string(), title: z.string() }).nullable().default(null),
});
export type ReopenSummary = z.infer<typeof ReopenSummarySchema>;

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

/** OMP provider ids; never a leading `-`, since they end up in `omp` argv. */
const OmpProviderId = z.string().regex(/^[a-z0-9][a-z0-9.-]*$/);
const OmpAccountRef = z.object({ provider: OmpProviderId, credentialId: z.number().int().nonnegative() });

/** Signs a new account in to OMP's own store (`omp` rpc `login`). */
export const startOmpLogin = defineRpc({
  name: "zerosub.omp.login.start",
  input: z.object({ provider: OmpProviderId }),
  output: OmpLoginViewSchema,
});

export const submitOmpLoginCode = defineRpc({
  name: "zerosub.omp.login.code",
  input: z.object({ loginId: z.string(), code: z.string().trim().min(1) }),
  output: OmpLoginViewSchema,
});

export const cancelOmpLogin = defineRpc({
  name: "zerosub.omp.login.cancel",
  input: z.object({ loginId: z.string() }),
  output: OmpLoginViewSchema.nullable(),
});

export const removeOmpAccount = defineRpc({
  name: "zerosub.omp.remove",
  input: OmpAccountRef,
  output: z.object({ ok: z.literal(true) }),
});

/** Spends one banked reset (`omp usage reset <provider>/<credentialId>`). */
export const redeemOmpReset = defineRpc({
  name: "zerosub.omp.redeem",
  input: OmpAccountRef,
  output: z.object({ ok: z.boolean(), message: z.string() }),
});
