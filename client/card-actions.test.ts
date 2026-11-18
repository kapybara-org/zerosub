import { describe, expect, it } from "vitest";
import type { AccountView } from "../shared/model";
import { cardActions, claudeCardDetails, removeText } from "./card-actions";

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
  azure: null,
  bedrock: null,
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

describe("an AWS Bedrock account's card", () => {
  const bedrock = { ...claude, auth: "api" as const, bedrock: {} as NonNullable<AccountView["bedrock"]> };

  it("opens its own settings form, not the API key one, and has no usage to refresh", () => {
    const keys = cardActions(bedrock);
    expect(keys).toContain("bedrock");
    expect(keys).not.toContain("api");
    expect(keys).not.toContain("usage");
  });

  it("says Remove deletes its folder and AWS settings, and its agents move to the default", () => {
    const text = removeText({ family: "claude", auth: "api", home: "/h", externalHome: false, launcher: null, azure: null, bedrock: bedrock.bedrock });
    expect(text.body).toBe(
      "This deletes the account's folder on this machine, with its AWS settings (and access key, if it has one) and its token counts. Agents using it move to the default account; their conversations are kept.",
    );
    expect(text.tooltip).toBe("Delete its AWS settings; its agents move to the default");
  });
});

describe("a card's details and Remove dialog with Grok and Cursor", () => {
  const removable = (family: AccountView["family"], extra: Partial<AccountView> = {}) =>
    ({ family, kind: "managed", auth: "subscription", label: "Work", home: `/p/homes/${family}-a`, externalHome: false, launcher: null, ...extra }) as AccountView;

  it("offers Grok and Cursor accounts no usage, key or proxy button", () => {
    for (const family of ["grok", "cursor"] as const) {
      const keys = cardActions({ ...claude, family, proxyEditable: false });
      expect(keys).toEqual(expect.arrayContaining(["next", "default", "toggle", "rename", "remove"]));
      expect(keys).not.toContain("usage");
      expect(keys).not.toContain("api");
      expect(keys).not.toContain("proxy");
    }
  });

  it("says agents move only for families whose conversations can move", () => {
    for (const family of ["claude", "pi"] as const) {
      expect(removeText(removable(family)).body).toContain("their conversations are kept");
      expect(removeText(removable(family)).tooltip).toContain("its agents move to the default");
    }
    for (const family of ["codex", "grok", "cursor"] as const) {
      const { body, tooltip } = removeText(removable(family));
      expect(body).not.toContain("their conversations are kept");
      expect(body).toContain("conversations on it can't move");
      expect(tooltip).not.toContain("agents move");
    }
    expect(removeText(removable("cursor")).body).toContain("Existing Cursor conversations");
  });

  it("names ZeroSub and keeps an outside folder", () => {
    const outside = removeText(removable("claude", { externalHome: true, home: "/x/claude-work", launcher: "claude-work.sh" }));
    expect(outside.body).toContain("only removes the account from ZeroSub");
    expect(outside.tooltip).toContain("ZeroSub");
  });

  it("says an API account's key is deleted, not signed out", () => {
    expect(removeText(removable("claude", { auth: "api" })).body).toContain("saved key");
    expect(removeText(removable("claude", { auth: "api" })).body).not.toContain("signs the account out");
  });

  it("gives an Azure OpenAI account its own settings button and says its key and endpoint are deleted", () => {
    const azure = { endpoint: "https://r.openai.azure.com/openai/v1" } as unknown as AccountView["azure"];
    const keys = cardActions({ ...claude, family: "codex", auth: "api", proxyEditable: false, azure });
    expect(keys).toContain("azure");
    expect(keys).not.toContain("api");
    const { body } = removeText(removable("codex", { auth: "api", azure }));
    expect(body).toContain("saved key and endpoint");
    expect(body).toContain("Existing ChatGPT conversations");
  });

  it("shows the address Anthropic sees on a Claude card, with its key, proxy and script", () => {
    const egress = { ip: "203.0.113.9", country: "US", checkedAt: new Date().toISOString(), error: null };
    const details = claudeCardDetails({
      family: "claude",
      api: { keyKind: "api_key", keyHint: "abcd", baseUrl: null },
      proxy: "http://127.0.0.1:7890",
      egress,
      launcher: "claude-work.sh",
    } as unknown as AccountView);
    expect(details).toBe("Key …abcd · Anthropic API · Via http://127.0.0.1:7890 · IP: 203.0.113.9 (US) · Terminal: claude-work.sh");
    expect(claudeCardDetails({ family: "claude", api: null, proxy: null, egress: null, launcher: null } as unknown as AccountView)).toBeNull();
    expect(claudeCardDetails({ family: "cursor", api: null, proxy: null, egress, launcher: null } as unknown as AccountView)).toBeNull();
  });
});
