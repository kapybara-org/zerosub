import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AntigravityAdapter, AntigravityLogin, parseAntigravityUsage } from "./antigravity";
import { familiesFromConfig } from "./families";

describe("Antigravity accounts", () => {
  it("routes the built-in provider and leaves independently configured homes and keys alone", () => {
    expect(familiesFromConfig({}).antigravity).toBe("antigravity");
    const families = familiesFromConfig({
      work: { extends: "antigravity" },
      separate: { extends: "antigravity", command: ["agy", "acp", "--gemini-dir", "/other"] },
      key: { extends: "antigravity", env: { GEMINI_API_KEY: "fixture" } },
    });
    expect(families).toMatchObject({ antigravity: "antigravity", work: "antigravity" });
    expect(families).not.toHaveProperty("separate");
    expect(families).not.toHaveProperty("key");
    expect(familiesFromConfig({ antigravity: { env: { HOME: "/other" } } }).antigravity).toBeUndefined();
    expect(familiesFromConfig({ antigravity: { command: ["agy", "acp", "--app-data-dir=/other"] } }).antigravity).toBeUndefined();
  });

  it.skipIf(process.platform !== "linux")("keeps the CLI environment and isolates the added sign-in", async () => {
    const adapter = new AntigravityAdapter();
    expect(await adapter.env(null)).toEqual({});
    expect(await adapter.env("/isolated")).toMatchObject({
      HOME: "/isolated", SSH_CONNECTION: "paseo", GEMINI_API_KEY: "", GOOGLE_APPLICATION_CREDENTIALS: "",
    });
  });

  it.skipIf(process.platform !== "linux")("passes the pasted code to the official login process", async () => {
    const home = await mkdtemp(join(tmpdir(), "zerosub-agy-login-"));
    const command = join(home, "agy");
    await writeFile(command, '#!/bin/sh\nprintf "https://accounts.google.com/sign-in\\n"\nread -r code\n[ "$code" = "test-code" ]\n', { mode: 0o700 });
    const login = new AntigravityLogin(command, { ...process.env, HOME: home });
    try {
      await vi.waitFor(() => expect(login.progress).toMatchObject({ step: "waiting", codeUrl: "https://accounts.google.com/sign-in" }));
      await expect(login.submitCode("first\nsecond")).rejects.toThrow("single authorization code");
      await login.submitCode("test-code");
      await expect(login.finished).resolves.toMatchObject({ ok: true });
    } finally {
      login.cancel();
      await login.finished;
      await rm(home, { recursive: true });
    }
  });

  it("shows quota buckets as usage and ignores disabled and malformed windows", () => {
    expect(parseAntigravityUsage(JSON.stringify({ response: [
      "Gemini Models\tWeekly Limit Remaining\t25%\t2026-11-30T19:58:00Z",
      "Claude and GPT models\tFive Hour Limit Remaining\t99.5%\t",
      "Gemini Models\tFive Hour Limit Remaining\tdisabled\t",
      "invalid",
      "Other\tWeekly Limit Remaining\t101%",
    ].join("\n") }))).toEqual([
      { id: "agy-gemini-models-weekly", label: "Weekly · Gemini Models", usedPercent: 75, resetsAt: "2026-11-30T19:58:00.000Z" },
      { id: "agy-claude-and-gpt-models-5-hour", label: "5-hour · Claude and GPT models", usedPercent: 0.5, resetsAt: null },
    ]);
    expect(parseAntigravityUsage("<error>")).toEqual([]);
  });
});
