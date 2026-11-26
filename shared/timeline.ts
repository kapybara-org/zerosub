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
    /** `from` was disabled for a while. */
    "disabled",
    /** `to` was enabled again, and this agent returns to it. */
    "enabled",
    /** Every account of this provider is at its limit; nothing to switch to. */
    "exhausted",
    /** `from` is a paid API account (AWS Bedrock) it moved onto by itself, and a subscription account has room again. */
    "room",
    /** `from` still works but is projected past the 5-hour pacing gate; a cold idle agent moved off it. */
    "pacing",
    /** `from` is nearly at its limit, and another plugin asked to move the agent before it gets there. */
    "near_limit",
  ]),
  /** When the exhausted account frees up again, if known. */
  resetsAt: z.string().nullable(),
  /** A follow-up was sent so the interrupted turn continues. */
  continued: z.boolean(),
  /** The conversation could not move in place and carries on in this new agent. */
  continuedIn: z.object({ agentId: z.string(), title: z.string() }).nullable().default(null),
  /** Set when `continuedIn` runs on the other provider (a fork from Claude to ChatGPT, or back). */
  toFamily: FamilySchema.nullable().default(null),
  /** Set when the fork went to a provider outside the account families, e.g. OpenCode. It has no account. */
  toProvider: z.string().nullable().default(null),
  /**
   * `switched`: the agent now runs on `to`. `pending`: it moves when its session next starts.
   * `continued`: the work goes on in `continuedIn`. `stayed`: it remains on `from` (see `detail`).
   * `reset`: a banked reset refilled `from`, and the agent stayed on it.
   */
  outcome: z.enum(["switched", "pending", "continued", "stayed", "reset"]).default("switched"),
  /** Delivery state for a fork row. Undefined retains the pre-delivery-status rendering. */
  delivery: z.enum(["sent", "up-to-date", "found", "uncertain"]).optional(),
  /**
   * The agent reloaded on `to` and kept this conversation. Absent on older rows, and on a new-tab
   * handoff, so a client that does not know the field still parses the row.
   */
  sameConversation: z.boolean().optional(),
  /**
   * On a `stayed` row for a `limit`: the agent is pinned to `from` with `allowLimited`, so ZeroSub
   * left it there on purpose. Absent otherwise, and on rows from older servers.
   */
  allowLimited: z.literal(true).optional(),
  detail: z.string().nullable().default(null),
  at: z.string(),
});
export type SwitchRow = z.infer<typeof SwitchRowSchema>;
