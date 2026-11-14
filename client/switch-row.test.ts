import { describe, expect, it, vi } from "vitest";
import { SwitchRowSchema, type SwitchRow } from "../shared/timeline";

// The row note is pure text, but it lives beside react-native views a Node test can't load.
vi.mock("react-native", () => ({ Text: () => null, View: () => null }));
vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: () => null }));

import { describeRow } from "./switch-row";

const at = "2026-11-11T00:00:00.000Z";

function row(patch: Partial<SwitchRow>): SwitchRow {
  return SwitchRowSchema.parse({
    family: "claude",
    from: "marketing",
    to: "hello",
    reason: "exhausted",
    resetsAt: null,
    continued: true,
    continuedIn: null,
    toFamily: null,
    toProvider: null,
    outcome: "switched",
    detail: null,
    at,
    ...patch,
  });
}

describe("describing a switch row", () => {
  it("names the ChatGPT account a fork moved to, as before", () => {
    const note = describeRow(
      row({
        reason: "exhausted",
        to: "hello",
        toFamily: "codex",
        continuedIn: { agentId: "fork-1", title: "Fix the build (continued on ChatGPT)" },
        outcome: "continued",
      }),
    );
    expect(note).toBe(
      "Every Claude account is at its limit, so the work continues on ChatGPT in a new agent: “Fix the build (continued on ChatGPT)” (hello).",
    );
  });

  it("says an OpenCode fork continues there, with no account to name", () => {
    const note = describeRow(
      row({
        reason: "exhausted",
        to: "OpenCode",
        toFamily: null,
        toProvider: "opencode",
        continuedIn: { agentId: "fork-2", title: "Fix the build (continued on OpenCode)" },
        outcome: "continued",
      }),
    );
    expect(note).toBe(
      "Every Claude account is at its limit, so the work continues on OpenCode in a new agent: “Fix the build (continued on OpenCode)”.",
    );
  });

  it.each([
    [
      "up-to-date",
      "The work is already up to date in “Fix the build (continued on OpenCode)” on OpenCode; ZeroSub sent nothing new. DETAIL",
    ],
    [
      "found",
      "ZeroSub found the existing OpenCode continuation “Fix the build (continued on OpenCode)” but couldn't tell what it has received. Nothing was sent; open that chat to check it against the latest instructions. DETAIL",
    ],
    [
      "uncertain",
      "ZeroSub couldn't confirm its last handoff to “Fix the build (continued on OpenCode)”. Nothing more was sent; open that chat before retrying. DETAIL",
    ],
  ] as const)("describes a %s fork without claiming it continued", (delivery, expected) => {
    const note = describeRow(
      row({
        reason: "manual",
        to: "OpenCode",
        toProvider: "opencode",
        continuedIn: { agentId: "fork-2", title: "Fix the build (continued on OpenCode)" },
        outcome: "stayed",
        delivery,
        detail: "DETAIL",
      }),
    );
    expect(note).toBe(expected);
    expect(note).not.toContain("in a new agent");
  });

  it("points an uncertain fork row at the known agent ID when the target has no title", () => {
    const note = describeRow(
      row({
        reason: "manual",
        to: "OpenCode",
        toProvider: "opencode",
        continuedIn: { agentId: "fork-9", title: "OpenCode agent fork-9" },
        outcome: "stayed",
        delivery: "uncertain",
        detail: null,
      }),
    );
    expect(note).toContain("fork-9");
    expect(note).not.toMatch(/continues on|opened|in a new agent/);
  });

  it("keeps a refused fork a stayed row that says why", () => {
    const note = describeRow(
      row({
        reason: "exhausted",
        to: "marketing",
        outcome: "stayed",
        detail: "The saved OpenCode model is no longer in this host's catalog. Pick one in ZeroSub's settings.",
      }),
    );
    expect(note).toBe(
      "Every Claude account is at its limit. Add another account, use a banked reset from the account button, or wait. The saved OpenCode model is no longer in this host's catalog. Pick one in ZeroSub's settings.",
    );
  });
});
