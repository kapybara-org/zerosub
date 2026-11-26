import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AntigravityAdapter,
  AntigravityLogin,
  antigravityEmail,
  parseAntigravityUsage,
  readDesktopAntigravitySecret,
  signedInAntigravityEmail,
} from "./antigravity";
import { familiesFromConfig } from "./families";
import type { run } from "./process";

const posix = process.platform === "linux" || process.platform === "darwin";

async function withTempHome<T>(fn: (home: string, configDir: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "zerosub-agy-"));
  const configDir = join(home, ".gemini", "antigravity-cli");
  try {
    return await fn(home, configDir);
  } finally {
    await chmod(join(configDir, "antigravity-oauth-token"), 0o600).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
}

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

  it("keeps the CLI environment, isolates added sign-ins on Linux and macOS, and rejects Windows", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const adapter = new AntigravityAdapter(platform);
      expect(await adapter.env(null)).toEqual({});
      expect(await adapter.env("/isolated")).toMatchObject({
        HOME: "/isolated", SSH_CONNECTION: "paseo", GEMINI_API_KEY: "", GOOGLE_APPLICATION_CREDENTIALS: "",
      });
    }
    const win = new AntigravityAdapter("win32");
    expect(await win.env(null)).toEqual({});
    await expect(win.env("/isolated")).rejects.toThrow("Linux and macOS");
    await expect(win.prepareHome("/isolated")).rejects.toThrow("Linux and macOS");
    await expect(win.available()).resolves.toEqual({ ok: false, detail: "Isolated Antigravity accounts are supported on Linux and macOS." });
  });

  it.skipIf(!posix)("passes the pasted code to the official login process", async () => {
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

  it("matches personal Google identities across plain, go-keyring-base64, and hex encodings", () => {
    const consumer = '{"auth_method":"consumer","id_token_email":" Example@Google.com ","token":{}}';
    const keyringEncoded = `go-keyring-base64:${Buffer.from(consumer, "utf8").toString("base64")}`;
    const hexEncoded = Buffer.from(keyringEncoded, "utf8").toString("hex");
    expect(antigravityEmail(consumer)).toBe("example@google.com");
    expect(antigravityEmail(keyringEncoded)).toBe("example@google.com");
    expect(antigravityEmail(hexEncoded)).toBe("example@google.com");
    expect(antigravityEmail(`go-keyring-base64:${Buffer.from('{"auth_method":"enterprise","id_token_email":"example@google.com"}').toString("base64")}`)).toBeNull();
    expect(antigravityEmail(`go-keyring-base64:${Buffer.from("not-json").toString("base64")}`)).toBeNull();
    expect(antigravityEmail("abc")).toBeNull(); // odd-length hex
    expect(antigravityEmail("deadbeef")).toBeNull(); // even-length non-JSON hex
    expect(antigravityEmail('{"auth_method":"enterprise","id_token_email":"example@google.com"}')).toBeNull();
    expect(antigravityEmail('{"auth_method":"consumer","id_token_email":"invalid"}')).toBeNull();
    expect(antigravityEmail("malformed JSON")).toBeNull();
  });

  it("calls /usr/bin/security on macOS and secret-tool on Linux, returning null on failure or timeout", async () => {
    const ok = vi.fn<typeof run>(async () => ({ code: 0, stdout: "secret", stderr: "", timedOut: false }));
    await expect(readDesktopAntigravitySecret({}, "darwin", ok)).resolves.toBe("secret");
    expect(ok).toHaveBeenCalledWith("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], expect.objectContaining({ timeoutMs: 6_000 }));

    ok.mockClear();
    await expect(readDesktopAntigravitySecret({}, "linux", ok)).resolves.toBe("secret");
    expect(ok).toHaveBeenCalledWith("secret-tool", ["lookup", "service", "gemini", "username", "antigravity"], expect.objectContaining({ timeoutMs: 6_000 }));

    const failed = vi.fn<typeof run>(async () => ({ code: 44, stdout: "", stderr: "not found", timedOut: false }));
    await expect(readDesktopAntigravitySecret({}, "darwin", failed)).resolves.toBeNull();

    const timedOut = vi.fn<typeof run>(async () => ({ code: 0, stdout: "secret", stderr: "", timedOut: true }));
    await expect(readDesktopAntigravitySecret({}, "darwin", timedOut)).resolves.toBeNull();

    await expect(readDesktopAntigravitySecret({}, "win32", ok)).resolves.toBeNull();
  });

  it("reads desktop Keychain on macOS and falls back to the file token when Keychain returns null", async () => {
    const desktopPayload = `go-keyring-base64:${Buffer.from('{"auth_method":"consumer","id_token_email":"desktop@example.com","token":{}}').toString("base64")}`;
    await withTempHome(async (home, configDir) => {
      const readSecret = vi.fn(async () => desktopPayload);
      await expect(signedInAntigravityEmail({ HOME: home }, { platform: "darwin", readSecret })).resolves.toBe("desktop@example.com");
      expect(readSecret).toHaveBeenCalledTimes(1);

      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "antigravity-oauth-token"), '{"auth_method":"consumer","id_token_email":"fallback@example.com","token":{}}');
      const noKeychain = vi.fn(async () => null);
      await expect(signedInAntigravityEmail({ HOME: home }, { platform: "darwin", readSecret: noKeychain })).resolves.toBe("fallback@example.com");
    });
  });

  it("reads the file token in SSH mode on Linux and macOS, falling back to the desktop store only on ENOENT", async () => {
    const desktopPayload = `go-keyring-base64:${Buffer.from('{"auth_method":"consumer","id_token_email":"desktop@example.com","token":{}}').toString("base64")}`;
    await withTempHome(async (home, configDir) => {
      const readSecret = vi.fn(async () => desktopPayload);
      // Missing token file (ENOENT) falls back to the desktop store on both platforms.
      for (const platform of ["darwin", "linux"] as const) {
        readSecret.mockClear();
        await expect(signedInAntigravityEmail({ HOME: home, SSH_CONNECTION: "1" }, { platform, readSecret })).resolves.toBe("desktop@example.com");
        expect(readSecret).toHaveBeenCalledTimes(1);
      }

      // Existing consumer file token is read directly without touching the desktop store.
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "antigravity-oauth-token"), '{"auth_method":"consumer","id_token_email":"ssh@example.com","token":{}}');
      for (const platform of ["darwin", "linux"] as const) {
        readSecret.mockClear();
        await expect(signedInAntigravityEmail({ HOME: home, SSH_CONNECTION: "1" }, { platform, readSecret })).resolves.toBe("ssh@example.com");
        expect(readSecret).not.toHaveBeenCalled();
      }

      // Existing enterprise or malformed file token never falls back to a consumer desktop entry.
      for (const content of ['{"auth_method":"enterprise","id_token_email":"corp@example.com"}', "not-json"]) {
        readSecret.mockClear();
        await writeFile(join(configDir, "antigravity-oauth-token"), content);
        await expect(signedInAntigravityEmail({ HOME: home, SSH_CONNECTION: "1" }, { platform: "darwin", readSecret })).resolves.toBeNull();
        expect(readSecret).not.toHaveBeenCalled();
      }
    });
  });

  it.skipIf(!posix || process.getuid?.() === 0)("does not fall back to Keychain when an SSH token file fails with EACCES", async () => {
    await withTempHome(async (home, configDir) => {
      const readSecret = vi.fn(async () => '{"auth_method":"consumer","id_token_email":"desktop@example.com"}');
      await mkdir(configDir, { recursive: true });
      const tokenPath = join(configDir, "antigravity-oauth-token");
      await writeFile(tokenPath, '{"auth_method":"consumer","id_token_email":"ssh@example.com"}');
      await chmod(tokenPath, 0o000);
      await expect(signedInAntigravityEmail({ HOME: home, SSH_CONNECTION: "1" }, { platform: "darwin", readSecret })).resolves.toBeNull();
      expect(readSecret).not.toHaveBeenCalled();
    });
  });

  it("treats an isolated home without its own token file as signed out and never calls the desktop store", async () => {
    await withTempHome(async (home, configDir) => {
      const readSecret = vi.fn(async () => '{"auth_method":"consumer","id_token_email":"desktop@example.com"}');
      const okModels = vi.fn<typeof run>(async () => ({ code: 0, stdout: "gemini-4-neon-high\n", stderr: "", timedOut: false }));
      const adapter = new AntigravityAdapter("darwin", readSecret, okModels);

      // Missing isolated file -> even if `agy models` fell back outside the home, do not treat it as signed in.
      await expect(adapter.identity(home)).resolves.toEqual({ signedIn: false, email: null, plan: null, organization: null, identity: null });
      expect(readSecret).not.toHaveBeenCalled();

      // Isolated non-consumer (e.g. enterprise) file present -> signed in with null email, desktop store untouched.
      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "antigravity-oauth-token"), '{"auth_method":"enterprise","id_token_email":"corp@example.com","token":{}}');
      await expect(adapter.identity(home)).resolves.toEqual({ signedIn: true, email: null, plan: null, organization: null, identity: null });
      expect(readSecret).not.toHaveBeenCalled();

      // Isolated consumer file present -> reads that file only, desktop store still untouched.
      await writeFile(join(configDir, "antigravity-oauth-token"), '{"auth_method":"consumer","id_token_email":"isolated@example.com","token":{}}');
      await expect(adapter.identity(home)).resolves.toEqual({
        signedIn: true,
        email: "isolated@example.com",
        plan: null,
        organization: null,
        identity: "antigravity|isolated@example.com",
      });
      expect(readSecret).not.toHaveBeenCalled();
    });
  });

  it("ignores auth env overrides, non-personal settings.json, and malformed settings.json", async () => {
    await withTempHome(async (home, configDir) => {
      const readSecret = vi.fn(async () => '{"auth_method":"consumer","id_token_email":"desktop@example.com"}');
      await expect(signedInAntigravityEmail({ HOME: home, GEMINI_API_KEY: "key" }, { platform: "darwin", readSecret })).resolves.toBeNull();
      expect(readSecret).not.toHaveBeenCalled();

      await mkdir(configDir, { recursive: true });
      await writeFile(join(configDir, "settings.json"), JSON.stringify({ modelProvider: "vertex" }));
      await expect(signedInAntigravityEmail({ HOME: home }, { platform: "darwin", readSecret })).resolves.toBeNull();

      await writeFile(join(configDir, "settings.json"), JSON.stringify({ auth: { type: "oauth-business" } }));
      await expect(signedInAntigravityEmail({ HOME: home, SSH_CONNECTION: "1" }, { platform: "darwin", readSecret })).resolves.toBeNull();
      expect(readSecret).not.toHaveBeenCalled();

      // Malformed settings.json throws from readJson; adapter.identity catches it and returns null email.
      await writeFile(join(configDir, "antigravity-oauth-token"), '{"auth_method":"consumer","id_token_email":"isolated@example.com","token":{}}');
      await writeFile(join(configDir, "settings.json"), "{broken");
      const okModels = vi.fn<typeof run>(async () => ({ code: 0, stdout: "gemini-4-neon-high\n", stderr: "", timedOut: false }));
      const adapter = new AntigravityAdapter("darwin", readSecret, okModels);
      await expect(adapter.identity(home)).resolves.toEqual({ signedIn: true, email: null, plan: null, organization: null, identity: null });
    });
  });

  it.runIf(process.platform === "darwin" && process.env.ZEROSUB_REAL_AGY === "1")(
    "keeps an isolated macOS home signed out even when the desktop Keychain holds a login",
    async () => {
      await withTempHome(async (home) => {
        const adapter = new AntigravityAdapter("darwin");
        const isolated = await adapter.identity(home);
        expect(isolated.signedIn).toBe(false);
        expect(isolated.email).toBeNull();
      });
    },
  );

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
