import { spawn } from "node:child_process";
import {
  ProgressEmitter,
  spawnEnv,
  type EnvPatch,
  type FamilyAdapter,
  type Identity,
  type LoginHandle,
  type RedeemReply,
  type UsageRead,
} from "./adapter";
import { cursorBinary } from "./binaries";
import { prepareCursorHome } from "./homes";
import { firstUrl, run, stripAnsi } from "./process";

/**
 * Logins `cursor-agent` takes from the environment over the one in its login file, and saves into
 * that file when it does: an added account's agents get them blanked, when the daemon's environment
 * sets them, so their work never runs on, or overwrites the account with, another login.
 */
export const OVERRIDING_AUTH = ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] as const;

/**
 * Why Cursor accounts are Linux only: elsewhere `cursor-agent` keeps its login where only moving a
 * folder every tool reads too would separate it (`HOME` on macOS, `APPDATA` on Windows).
 */
export const CURSOR_UNSUPPORTED: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Cursor accounts are Linux only for now: on macOS cursor-agent keeps its login in the Keychain or under ~/.cursor, which only moving HOME for every tool would separate.",
  win32: "Cursor accounts are Linux only for now: on Windows cursor-agent keeps its login under %APPDATA%, which only moving APPDATA for every tool would separate.",
};

const OTHER_PLATFORM = "Cursor accounts are Linux only for now.";

function str(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Who `cursor-agent status --format json` says is signed in: `isAuthenticated`, and `userInfo` with
 * `email`, `userId` and `teamId` (`teamName` too), when Cursor could say. Signed in without
 * `userInfo` is still signed in, just not knowing as whom. Never reads anything else. Throws on output
 * that isn't that JSON, so a failed check never counts as signed out.
 */
export function parseCursorStatus(output: string): Identity {
  const start = output.indexOf("{");
  const value = JSON.parse(start >= 0 ? output.slice(start) : output) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as { isAuthenticated?: unknown }).isAuthenticated !== "boolean") {
    throw new Error("cursor-agent status gave no sign-in status.");
  }
  const status = value as { isAuthenticated: boolean; userInfo?: unknown };
  if (!status.isAuthenticated) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
  const info = status.userInfo && typeof status.userInfo === "object" && !Array.isArray(status.userInfo) ? (status.userInfo as Record<string, unknown>) : {};
  const email = str(info.email);
  const who = str(info.userId) ?? email?.toLowerCase() ?? null;
  const team = str(info.teamId);
  return {
    signedIn: true,
    email,
    plan: null,
    organization: str(info.teamName),
    identity: who ? `cursor|${team && team !== "0" ? team : "personal"}|${who}` : null,
  };
}

/** The sign-in link `cursor-agent login` prints (`https://cursor.com/loginDeepControl?…`), once it has. */
export function readCursorLogin(output: string): { url: string; userCode: null } | null {
  const url =
    firstUrl(output, /^https:\/\/(?:[\w-]+\.)*cursor\.(?:com|sh)\/loginDeepControl\b/) ?? firstUrl(output, /^https:\/\/(?:[\w-]+\.)*cursor\.(?:com|sh)\//);
  return url ? { url, userCode: null } : null;
}

export class CursorAdapter implements FamilyAdapter {
  readonly family = "cursor" as const;
  /**
   * Resuming a Cursor conversation on a second account isn't verified, so Cursor agents stay on their
   * account, like Grok's, and don't hand off (see `HAND_OFF`).
   */
  readonly portable = false;
  readonly usageSpacingMs = 60_000;

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  /**
   * An added account's home is its `XDG_CONFIG_HOME` (see `prepareCursorHome`); the CLI login runs as
   * the daemon has it. A `CURSOR_CONFIG_DIR` in the daemon's environment is blanked for added accounts,
   * like the logins in `OVERRIDING_AUTH`, so it can't point every account at one `cli-config.json`
   * (`cursor-agent` takes an empty one as unset).
   */
  async env(home: string | null): Promise<EnvPatch> {
    if (this.platform !== "linux") return {};
    if (!home) return { XDG_CONFIG_HOME: null };
    const patch: EnvPatch = { XDG_CONFIG_HOME: home };
    for (const key of [...OVERRIDING_AUTH, "CURSOR_CONFIG_DIR"]) if (process.env[key]) patch[key] = "";
    return patch;
  }

  /** Linux only (see `CURSOR_UNSUPPORTED`); there, once a Paseo provider runs `cursor-agent acp`. */
  async available(): Promise<{ ok: boolean; detail: string | null }> {
    if (this.platform !== "linux") return { ok: false, detail: CURSOR_UNSUPPORTED[this.platform] ?? OTHER_PLATFORM };
    const command = await cursorBinary();
    if (!command) return { ok: false, detail: "no Paseo provider runs `cursor-agent acp`" };
    const result = await run(command, ["--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  prepareHome(home: string): Promise<void> {
    if (this.platform !== "linux") return Promise.reject(new Error(CURSOR_UNSUPPORTED[this.platform] ?? OTHER_PLATFORM));
    return prepareCursorHome(home);
  }

  /** Runs `cursor-agent status --format json` with the account's folders; never reads its login file. */
  async identity(home: string | null): Promise<Identity> {
    const command = (await cursorBinary()) ?? "cursor-agent";
    const result = await run(command, ["status", "--format", "json"], { env: spawnEnv(await this.env(home), "cursor"), timeoutMs: 30_000 });
    if (result.timedOut) throw new Error("`cursor-agent status` didn't answer in time.");
    if (result.code !== 0) {
      throw new Error(stripAnsi(result.stderr || result.stdout).trim().split("\n")[0] || `cursor-agent status failed (exit ${result.code ?? "signal"})`);
    }
    return parseCursorStatus(stripAnsi(result.stdout));
  }

  /**
   * `cursor-agent` has no command that shows plan usage, and ZeroSub doesn't call Cursor's dashboard
   * API with the account's login, so usage stays unavailable.
   */
  async usage(): Promise<UsageRead> {
    return {
      fetchedAt: new Date().toISOString(),
      windows: [],
      error: "cursor-agent has no command that shows plan usage yet. Check it in Cursor's dashboard.",
      cached: false,
      resets: null,
    };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Cursor has no banked resets.", left: null };
  }

  async login(home: string | null): Promise<LoginHandle> {
    if (home && this.platform !== "linux") throw new Error(CURSOR_UNSUPPORTED[this.platform] ?? OTHER_PLATFORM);
    const command = (await cursorBinary()) ?? "cursor-agent";
    // The link is read from what `cursor-agent login` prints; no browser opens on the daemon's machine.
    const env = { ...spawnEnv(await this.env(home), "cursor"), NO_OPEN_BROWSER: "1" };
    return new CursorLogin(command, ["login"], env);
  }

  async logout(home: string): Promise<void> {
    const command = (await cursorBinary()) ?? "cursor-agent";
    const result = await run(command, ["logout"], { env: spawnEnv(await this.env(home), "cursor"), timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n")[0] || "cursor-agent logout failed");
  }

  /** Failover is for a follow-up: how Cursor's limit and sign-out notices reach Paseo isn't known yet. */
  detectLimit(): null {
    return null;
  }

  detectSignOut(): null {
    return null;
  }
}

/**
 * `cursor-agent login`: it prints a sign-in link, which works in a browser on any device (the CLI asks
 * Cursor whether it was used), and exits 0 once signed in.
 */
export class CursorLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private output = "";
  private canceled = false;
  private exited = false;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.finished = new Promise((settle) => {
      this.child.on("error", (error) => settle({ ok: false, message: `Could not start cursor-agent: ${error.message}` }));
      this.child.on("close", (code) => {
        this.exited = true;
        if (this.canceled) return settle({ ok: false, message: "Sign-in was canceled." });
        if (code === 0) return settle({ ok: true, message: null });
        const lines = this.output.split("\n").map((line) => line.trim()).filter(Boolean);
        settle({ ok: false, message: lines.reverse().find((line) => /error|fail|denied|expired|timed out/i.test(line)) ?? "Sign-in did not finish." });
      });
    });
    const read = (chunk: string) => {
      this.output = (this.output + stripAnsi(chunk)).slice(-16_384);
      const link = readCursorLogin(this.output);
      if (link && link.url !== this.progress.url) this.update({ step: "waiting", ...link });
    };
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", read);
    this.child.stderr.on("data", read);
  }

  async submitCode(): Promise<void> {
    throw new Error("Cursor sign-in doesn't use a pasted code. Finish on the sign-in page.");
  }

  cancel(): void {
    if (this.exited || this.canceled) return;
    this.canceled = true;
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (!this.exited) this.child.kill("SIGKILL");
    }, 3_000).unref();
  }
}
