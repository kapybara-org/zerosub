import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Sent after a switch or a reset, so it must read right for both. */
export const DEFAULT_CONTINUE_PROMPT =
  "You were interrupted by a usage limit; that has been sorted out. Continue exactly where you left off.";

export const preferences = defineSettings({
  id: "preferences",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Move an agent to another account of the same provider when its account hits a usage limit. */
    autoSwitch: z.boolean().default(true),
    /** After an automatic switch, send a follow-up so the interrupted turn keeps going. */
    autoContinue: z.boolean().default(true),
    continuePrompt: z.string().trim().min(1).max(500).default(DEFAULT_CONTINUE_PROMPT),
    /**
     * When the default account changes, open agents that follow it move to the new one. Off, each
     * stays pinned to the account it runs on (so it stays there when it next opens too), unless that
     * account can't be used right now, and the new default is for new agents and ones that aren't
     * open at the time. Codex threads never move either way.
     */
    moveAgentsOnDefaultChange: z.boolean().default(true),
    /** New agents choose an account by usage instead of the default. */
    balanceNewAgents: z.boolean().default(false),
    /** When every account of a provider is at its limit, spend a banked reset instead of stopping. */
    autoRedeem: z.boolean().default(false),
    /**
     * A ChatGPT account at its limit stays in use while it has ChatGPT credits, so new agents may
     * spend paid credits even while another account still has room. A limit a turn ran into stands.
     */
    useCredits: z.boolean().default(false),
    /**
     * When every account of a provider is at its limit, carry the chat on in a new agent on the
     * other provider (Claude ↔ ChatGPT) or, for Claude, on OpenCode. ChatGPT gets a mode no looser than the original's; OpenCode runs the host's policy.
     */
    forkOtherProvider: z.boolean().default(false),
    /** Where a stopped Claude chat continues when the fork option is on. */
    claudeForkDestination: z.enum(["codex", "opencode"]).default("codex"),
    /** OpenCode model for that fork, from this host's catalog. Empty uses the host's default. */
    forkOpenCodeModel: z.string().default(""),
    /** Thinking option that model offers, from this host's catalog. Empty uses the model's default. */
    forkOpenCodeThinking: z.string().default(""),
    /** Show the account pill in the composer of Claude and Codex agents. */
    showComposerPill: z.boolean().default(true),
  }),
});

export type Preferences = z.output<typeof preferences.schema>;
