import { describe, expect, it } from "vitest";
import { sameAccountIdentity } from "./account-identity";

describe("account identity compatibility", () => {
  it("conservatively rejects a workspace duplicate when the member is unknown", () => {
    expect(sameAccountIdentity("codex",
      { identity: "chatgpt|team", email: null },
      { identity: "chatgpt|team|member@example.com", email: "member@example.com" },
      true,
    )).toBe(true);
  });

  it("does not match unknown identities", () => {
    expect(sameAccountIdentity("codex", { identity: null, email: "me@example.com" },
      { identity: null, email: "me@example.com" })).toBe(false);
  });

  it("keeps Claude identity comparison exact", () => {
    expect(sameAccountIdentity("claude", { identity: "org-a|me@example.com", email: "me@example.com" },
      { identity: "org-b|me@example.com", email: "me@example.com" })).toBe(false);
  });
});
