import { describe, expect, it } from "vitest";
import type { AccountView } from "../shared/model";
import { cardActions } from "./card-actions";

type CardAccount = Parameters<typeof cardActions>[0];

const claude: CardAccount = {
  family: "claude",
  kind: "managed",
  auth: "subscription",
  status: "ready",
  disabled: false,
  isDefault: false,
  nextAgentUntil: null,
  apiEditable: false,
  proxyEditable: true,
};
const pi: CardAccount = { ...claude, family: "pi", auth: "api", apiEditable: true };

describe("an account card's buttons", () => {
  it("offers Disable on an account another one can stand in for", () => {
    expect(cardActions(claude)).toContain("toggle");
    expect(cardActions({ ...claude, family: "codex" })).toContain("toggle");
  });

  it("offers no Disable on a Pi account, which nothing would stand in for, but still Enable on one disabled before", () => {
    expect(cardActions(pi)).not.toContain("toggle");
    expect(cardActions({ ...pi, kind: "main", auth: "subscription", apiEditable: false })).not.toContain("toggle");
    expect(cardActions({ ...pi, disabled: true })).toContain("toggle");
    expect(cardActions({ ...pi, status: "disabled" } as AccountView)).toContain("toggle");
  });

  it("offers Next new agent on an account that can take agents, and Cancel on a waiting pick whatever its account has become", () => {
    expect(cardActions(claude)).toContain("next");
    expect(cardActions(pi)).toContain("next");
    expect(cardActions({ ...claude, status: "signed_out" })).not.toContain("next");
    expect(cardActions({ ...claude, disabled: true })).not.toContain("next");
    const waiting = new Date(Date.now() + 60_000).toISOString();
    expect(cardActions({ ...claude, status: "signed_out", nextAgentUntil: waiting })).toContain("next");
    expect(cardActions({ ...claude, disabled: true, nextAgentUntil: waiting })).toContain("next");
  });
});
