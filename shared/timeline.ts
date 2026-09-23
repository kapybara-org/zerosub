import { z } from "zod";
import { FamilySchema } from "./model";

export const SWITCH_ROW_KIND = "zerosub-switch";
export const SWITCH_ROW_VERSION = 1;

export const SwitchRowSchema = z.object({
  family: FamilySchema,
  from: z.string().nullable(),
  to: z.string(),
  reason: z.enum([
    /** `from` hit its usage limit. */
    "limit",
    /** `from` is no longer signed in. */
    "signed_out",
    /** The user picked another account for this agent. */
    "manual",
    /** The default account changed and this agent follows it. */
    "default",
    /** `from` was removed. */
    "removed",
    /** Every account of this provider is at its limit; nothing to switch to. */
    "exhausted",
  ]),
  /** When the exhausted account frees up again, if known. */
  resetsAt: z.string().nullable(),
  /** A follow-up was sent so the interrupted turn continues. */
  continued: z.boolean(),
  /** The conversation could not move in place and carries on in this new agent. */
  continuedIn: z.object({ agentId: z.string(), title: z.string() }).nullable().default(null),
  /** Set when `continuedIn` runs on the other provider (a fork from Claude to ChatGPT, or back). */
  toFamily: FamilySchema.nullable().default(null),
  /**
   * `switched`: the agent now runs on `to`. `pending`: it moves when its session next starts.
   * `continued`: the work goes on in `continuedIn`. `stayed`: it remains on `from` (see `detail`).
   * `reset`: a banked reset refilled `from`, and the agent stayed on it.
   */
  outcome: z.enum(["switched", "pending", "continued", "stayed", "reset"]).default("switched"),
  detail: z.string().nullable().default(null),
  at: z.string(),
});
export type SwitchRow = z.infer<typeof SwitchRowSchema>;
