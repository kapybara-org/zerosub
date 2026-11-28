import { describe, expect, it } from "vitest";
import { familiesFromConfig } from "./families";

/** A derived provider as the Workspace Sandbox plugin writes it into Paseo's config. */
const sandboxed = (base: string) => ({
  extends: base,
  command: ["/home/me/.paseo/plugin-data/workspace-sandbox/bin/sandbox-run", "agent", base],
});

describe("familiesFromConfig and sandboxed providers", () => {
  it("doesn't route a provider whose command runs inside a sandbox", () => {
    // An account's home is a host folder the sandbox can't see, so routing one signs the agent out.
    const families = familiesFromConfig({ "claude-sandbox": sandboxed("claude"), "codex-sandbox": sandboxed("codex") });
    expect(families["claude-sandbox"]).toBeUndefined();
    expect(families["codex-sandbox"]).toBeUndefined();
    expect(families.claude).toBe("claude");
    expect(families.codex).toBe("codex");
  });

  it("keeps routing custom providers that run the CLI on the host", () => {
    const families = familiesFromConfig({
      "claude-work": { extends: "claude" },
      "claude-wrapped": { extends: "claude", command: ["/usr/local/bin/my-claude-wrapper"] },
      "codex-sandbox": { extends: "codex" },
    });
    expect(families["claude-work"]).toBe("claude");
    expect(families["claude-wrapped"]).toBe("claude");
    expect(families["codex-sandbox"]).toBe("codex");
  });

  it("ignores a command that isn't a list of strings", () => {
    const families = familiesFromConfig({ "claude-odd": { extends: "claude", command: "sandbox-run" } });
    expect(families["claude-odd"]).toBe("claude");
  });
});
