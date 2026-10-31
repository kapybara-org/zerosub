import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DEFAULT_CONTINUE_PROMPT, preferences } from "./preferences";

// The preferences 1.2.1 and 1.2.2 shipped, before "Move open agents when the default changes".
const shipped = z.object({
  autoSwitch: z.boolean().default(true),
  autoContinue: z.boolean().default(true),
  continuePrompt: z.string().trim().min(1).max(500).default(DEFAULT_CONTINUE_PROMPT),
  balanceNewAgents: z.boolean().default(false),
  autoRedeem: z.boolean().default(false),
  forkOtherProvider: z.boolean().default(false),
  showComposerPill: z.boolean().default(true),
});

describe("preferences", () => {
  it("keeps moving open agents to a new default for preferences saved before the switch existed", () => {
    const saved = shipped.parse({ autoSwitch: false });
    expect(preferences.schema.parse(saved)).toMatchObject({ autoSwitch: false, moveAgentsOnDefaultChange: true });
    expect(preferences.schema.parse({}).moveAgentsOnDefaultChange).toBe(true);
  });

  it("doesn't spend ChatGPT credits for preferences saved before that switch existed", () => {
    const saved = preferences.schema.parse({ autoSwitch: false, moveAgentsOnDefaultChange: false });
    expect(saved.useCredits).toBe(false);
    expect(preferences.schema.parse(shipped.parse({})).useCredits).toBe(false);
  });

  it("can still be read by 1.2.2 after a downgrade", () => {
    const saved = preferences.schema.parse({ autoSwitch: false, moveAgentsOnDefaultChange: false });
    expect(shipped.safeParse(saved)).toMatchObject({ success: true, data: { autoSwitch: false } });
    // Paseo won't load preferences saved under a newer version number, so a new switch mustn't bump it.
    expect(preferences.version).toBe(1);
  });
});
