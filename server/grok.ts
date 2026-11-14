import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { LoginMethod } from "../shared/model";
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
import { browserCaptureScript, grokBinary } from "./binaries";
import { prepareGrokHome } from "./homes";
import { mainGrokHome } from "./paths";
import { firstUrl, run, stripAnsi } from "./process";

/**
 * Logins Grok would use in place of the home's `auth.json`, or fall back to once its sign-in lapses:
 * an added account's agents get them blanked, when the daemon's environment sets them, so their work
 * never moves to another login or onto an API key's bill.
 */
const OVERRIDING_AUTH = [
  "GROK_AUTH",
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_AUTH_PROVIDER_ACCESS_TOKEN",
  "GROK_OIDC_ISSUER",
  "GROK_OIDC_CLIENT_ID",
  "GROK_OIDC_AUDIENCE",
  "GROK_OIDC_SCOPES",
  "GROK_DEPLOYMENT_KEY",
  "GROK_CLI_CHAT_PROXY_BASE_URL",
] as const;

/** The login file of a home (`home === null`: the CLI login, which may name another with `GROK_AUTH_PATH`). */
export function grokAuthPath(home: string | null): string {
  if (home) return join(home, "auth.json");
  const configured = process.env.GROK_AUTH_PATH?.trim();
  return configured ? resolve(configured) : join(mainGrokHome(), "auth.json");
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/**
 * Who a Grok `auth.json` is signed in as. It holds one entry per sign-in scope, keyed
 * `https://auth.x.ai::<client id>` for Grok's own sign-in (preferred), with `email`, `user_id` and
 * `team_id` beside the login. Only those are read, and whether a login (`key` or `refresh_token`) is
 * there; never its value. Null when no entry holds a login.
 */
export function parseGrokAuth(value: unknown): Identity | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (entry): entry is [string, Record<string, unknown>] => Boolean(entry[1]) && typeof entry[1] === "object" && !Array.isArray(entry[1]),
  );
  const preferred = entries.filter(([key]) => key.startsWith("https://auth.x.ai::"));
  const login = (preferred.length > 0 ? preferred : entries).map(([, entry]) => entry).find((entry) => str(entry.key) || str(entry.refresh_token));
  if (!login) return null;
  const email = str(login.email);
  const who = str(login.user_id) ?? email?.toLowerCase() ?? null;
  return {
    signedIn: true,
    email,
    plan: null,
    organization: null,
    identity: who ? `grok|${str(login.team_id) ?? "personal"}|${who}` : null,
  };
}

/** Why `grok usage --json` gave no reading, in a few words. */
export function grokUsageProblem(result: { code: number | null; stdout: string; stderr: string; timedOut: boolean }): string {
  if (result.timedOut) return "`grok usage` didn't answer in time.";
  const said = stripAnsi(`${result.stderr}\n${result.stdout}`);
  if (/can't show your plan's usage here/i.test(said)) return "Grok can't show plan usage on this machine yet. Run /usage inside Grok instead.";
  if (/managed by your team/i.test(said)) return "Usage limits are managed by your team.";
  const line = said.split("\n").map((entry) => entry.replace(/^Error:\s*/i, "").trim()).find(Boolean);
  if (result.code !== 0) return line ? line.slice(0, 200) : `\`grok usage\` failed (exit ${result.code ?? "signal"}).`;
  return "Grok usage JSON format support awaits verification. Run /usage inside Grok to check your plan.";
}

export class GrokAdapter implements FamilyAdapter {
  readonly family = "grok" as const;
  /**
   * A conversation's history may carry reasoning only its account can read (Grok has an
   * `encrypted_content_mismatch` error), and resuming on a second account isn't verified, so Grok
   * agents stay on their account, like Codex threads, and don't hand off (see `HAND_OFF`).
   */
  readonly portable = false;
  readonly usageSpacingMs = 60_000;

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return { GROK_HOME: null, GROK_AUTH_PATH: null };
    // `GROK_AUTH_PATH` too, so one set in the daemon's environment can't point every account at one file.
    const patch: EnvPatch = { GROK_HOME: home, GROK_AUTH_PATH: join(home, "auth.json") };
    for (const key of OVERRIDING_AUTH) if (process.env[key]) patch[key] = "";
    return patch;
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const command = await grokBinary();
    if (!command) return { ok: false, detail: "no Paseo provider runs `grok agent stdio`" };
    const result = await run(command, ["--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  prepareHome(home: string): Promise<void> {
    return prepareGrokHome(home);
  }

  async identity(home: string | null): Promise<Identity> {
    let text = "";
    try {
      text = await readFile(grokAuthPath(home), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const identity = text.trim() ? parseGrokAuth(JSON.parse(text)) : null;
    return identity ?? { signedIn: false, email: null, plan: null, organization: null, identity: null };
  }

  /** Invoke only Grok's own CLI; its successful JSON stays unavailable until the format is verified. */
  async usage(home: string | null): Promise<UsageRead> {
    const fetchedAt = new Date().toISOString();
    const command = (await grokBinary()) ?? "grok";
    const result = await run(command, ["usage", "--json"], { env: spawnEnv(await this.env(home)), timeoutMs: 30_000 });
    return { fetchedAt, windows: [], error: grokUsageProblem(result), cached: false, resets: null };
  }

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Grok has no banked resets.", left: null };
  }

  async login(home: string | null, method: LoginMethod): Promise<LoginHandle> {
    const command = (await grokBinary()) ?? "grok";
    const env = spawnEnv(await this.env(home));
    // The link is read from what `grok login` prints; no browser opens on the daemon's machine.
    const shim = await browserCaptureScript();
    if (shim) env.BROWSER = shim;
    return new GrokLogin(command, ["login", method === "code" ? "--device-auth" : "--oauth"], env);
  }

  async logout(home: string): Promise<void> {
    const command = (await grokBinary()) ?? "grok";
    const result = await run(command, ["logout"], { env: spawnEnv(await this.env(home)), timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().split("\n")[0] || "grok logout failed");
  }

  /** Failover is for a follow-up: how Grok's limit and sign-out notices reach Paseo isn't known yet. */
  detectLimit(): null {
    return null;
  }

  detectSignOut(): null {
    return null;
  }
}

/** Grok's device code, as `grok login --device-auth` prints it: `ABCD-1234`. */
const DEVICE_CODE = /\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/;

/**
 * The link and code `grok login` printed so far: `--device-auth` prints the device page and a code to
 * confirm there (any device), `--oauth` the sign-in link (its callback is on the daemon's machine).
 */
export function readGrokLogin(output: string): { url: string; userCode: string | null } | null {
  const device = firstUrl(output, /\/oauth2\/device/);
  if (device) {
    const code = output.slice(output.indexOf(device) + device.length).match(DEVICE_CODE)?.[1] ?? new URL(device).searchParams.get("user_code");
    return { url: device, userCode: code };
  }
  const browser = firstUrl(output, /\/oauth2\/authorize/);
  return browser ? { url: browser, userCode: null } : null;
}

/** `grok login`, which exits 0 once signed in. */
export class GrokLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private output = "";
  private canceled = false;
  private exited = false;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.finished = new Promise((settle) => {
      this.child.on("error", (error) => settle({ ok: false, message: `Could not start Grok: ${error.message}` }));
      this.child.on("close", (code) => {
        this.exited = true;
        if (this.canceled) return settle({ ok: false, message: "Sign-in was canceled." });
        if (code === 0) return settle({ ok: true, message: null });
        const lines = this.output.split("\n").map((line) => line.trim()).filter(Boolean);
        settle({ ok: false, message: lines.reverse().find((line) => /error|fail|denied|expired/i.test(line)) ?? "Sign-in did not finish." });
      });
    });
    const read = (chunk: string) => {
      this.output = (this.output + stripAnsi(chunk)).slice(-16_384);
      const link = readGrokLogin(this.output);
      if (link && (link.url !== this.progress.url || link.userCode !== this.progress.userCode)) this.update({ step: "waiting", ...link });
    };
    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");
    this.child.stdout.on("data", read);
    this.child.stderr.on("data", read);
  }

  async submitCode(): Promise<void> {
    throw new Error("Grok sign-in doesn't use a pasted code. Finish on the sign-in page.");
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
