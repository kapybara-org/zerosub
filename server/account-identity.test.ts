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

  it("matches a Codex key read without its workspace by its email alone", () => {
    const member = { identity: "chatgpt|team|member@example.com", email: "member@example.com" };
    expect(sameAccountIdentity("codex", member,
      { identity: "chatgpt-email|member@example.com|team", email: "Member@example.com" })).toBe(true);
    expect(sameAccountIdentity("codex", member,
      { identity: "chatgpt-email|other@example.com|team", email: "other@example.com" })).toBe(false);
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
