import { spawn } from "node:child_process";
import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { UsageWindow } from "../shared/model";
import { ProgressEmitter, spawnEnv, type EnvPatch, type FamilyAdapter, type Identity, type LoginHandle, type RedeemReply, type UsageRead } from "./adapter";
import { providerCommand } from "./binaries";
import { ANTIGRAVITY_AUTH_ENV } from "./families";
import { readJson } from "./json-file";
import { firstUrl, run, stripAnsi } from "./process";

const SUPPORTED_PLATFORMS = new Set<NodeJS.Platform>(["linux", "darwin"]);
const unsupported = "Isolated Antigravity accounts are supported on Linux and macOS.";
const signedOut = /please sign in|authentication required|not signed in/i;
const GO_KEYRING_BASE64 = "go-keyring-base64:";
/** Bounded so a locked or slow OS keyring falls back to the token file instead of hanging identity checks. */
const KEYRING_TIMEOUT_MS = 6_000;

/** Only consumer OAuth establishes a match; an enterprise identity can cover several organizations. */
export function antigravityEmail(raw: string): string | null {
  try {
    let text = raw.trim();
    if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
      text = Buffer.from(text, "hex").toString("utf8").trim();
    }
    if (text.startsWith(GO_KEYRING_BASE64)) {
      text = Buffer.from(text.slice(GO_KEYRING_BASE64.length), "base64").toString("utf8");
    }
    const auth = JSON.parse(text) as { auth_method?: unknown; id_token_email?: unknown } | null;
    const email = typeof auth?.id_token_email === "string" ? auth.id_token_email.trim().toLowerCase() : "";
    return auth?.auth_method === "consumer" && /^[^\s@]+@[^\s@]+$/.test(email) ? email : null;
  } catch {
    return null;
  }
}

export async function readDesktopAntigravitySecret(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  exec: typeof run = run,
): Promise<string | null> {
  if (platform === "darwin") {
    const secret = await exec("/usr/bin/security", ["find-generic-password", "-s", "gemini", "-a", "antigravity", "-w"], {
      env,
      timeoutMs: KEYRING_TIMEOUT_MS,
    });
    return secret.code === 0 && !secret.timedOut ? secret.stdout : null;
  }
  if (platform === "linux") {
    const secret = await exec("secret-tool", ["lookup", "service", "gemini", "username", "antigravity"], {
      env,
      timeoutMs: KEYRING_TIMEOUT_MS,
    });
    return secret.code === 0 && !secret.timedOut ? secret.stdout : null;
  }
  return null;
}

export async function signedInAntigravityEmail(
  env: NodeJS.ProcessEnv,
  options: {
    isolated?: boolean;
    platform?: NodeJS.Platform;
    readSecret?: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => Promise<string | null>;
  } = {},
): Promise<string | null> {
  if (ANTIGRAVITY_AUTH_ENV.some((key) => env[key])) return null;
  const platform = options.platform ?? process.platform;
  const configDir = join(env.HOME || homedir(), ".gemini", "antigravity-cli");
  const settings = await readJson(join(configDir, "settings.json")) as { auth?: { type?: unknown }; modelProvider?: unknown } | null | undefined;
  if (settings?.modelProvider || (settings?.auth?.type && settings.auth.type !== "oauth-personal")) return null;
  const tokenPath = join(configDir, "antigravity-oauth-token");
  // Added accounts always use their isolated file-backed token; never read the shared desktop store for them.
  if (options.isolated) {
    return antigravityEmail(await readFile(tokenPath, "utf8"));
  }
  const readSecret = options.readSecret ?? readDesktopAntigravitySecret;
  // In an SSH session agy checks the file token first, and may fall back to the desktop store when no file exists.
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
    try {
      return antigravityEmail(await readFile(tokenPath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
    }
    const secret = await readSecret(env, platform);
    return secret !== null ? antigravityEmail(secret) : null;
  }
  // On desktop, agy tries the OS keyring first and falls back to the file token when the keyring fails or times out.
  const secret = await readSecret(env, platform);
  if (secret !== null) return antigravityEmail(secret);
  const fileToken = await readFile(tokenPath, "utf8").catch(() => null);
  return fileToken !== null ? antigravityEmail(fileToken) : null;
}

export function parseAntigravityUsage(output: string): UsageWindow[] {
  let body: unknown;
  try {
    body = JSON.parse(output);
  } catch {
    return [];
  }
  if (!body || typeof body !== "object" || !("response" in body) || typeof body.response !== "string") return [];
  const windows = new Map<string, UsageWindow>();
  for (const line of body.response.split("\n")) {
    const [group, period, remaining, reset] = line.trim().split("\t");
    if (!group || !/^(Weekly|Five Hour) Limit Remaining$/.test(period ?? "") || !/^\d{1,3}(?:\.\d+)?%$/.test(remaining ?? "")) continue;
    const left = Number(remaining!.slice(0, -1));
    if (left > 100) continue;
    const span = period === "Weekly Limit Remaining" ? "Weekly" : "5-hour";
    const key = group.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!key) continue;
    const id = `agy-${key}-${span.toLowerCase()}`;
    const resets = Date.parse(reset ?? "");
    windows.set(id, { id, label: `${span} · ${group}`, usedPercent: 100 - left, resetsAt: Number.isFinite(resets) ? new Date(resets).toISOString() : null });
  }
  return [...windows.values()];
}

export class AntigravityAdapter implements FamilyAdapter {
  readonly family = "antigravity" as const;
  readonly portable = false;
  readonly usageSpacingMs = 5 * 60_000;

  constructor(
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly readSecret: (env: NodeJS.ProcessEnv, platform: NodeJS.Platform) => Promise<string | null> = readDesktopAntigravitySecret,
    private readonly exec: typeof run = run,
  ) {}

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return {};
    if (!SUPPORTED_PLATFORMS.has(this.platform)) throw new Error(unsupported);
    // On macOS, moving HOME takes the login Keychain out of the search list; SSH_CONNECTION makes agy store its sign-in in a file.
    // On Linux, SSH_CONNECTION makes agy use the account-specific token file under HOME instead of the shared desktop keyring.
    return { HOME: home, SSH_CONNECTION: "paseo", ...Object.fromEntries(ANTIGRAVITY_AUTH_ENV.map((key) => [key, ""])) };
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    if (!SUPPORTED_PLATFORMS.has(this.platform)) return { ok: false, detail: unsupported };
    const { command } = await providerCommand(this.family);
    const result = await this.exec(command, ["acp", "--help"], { timeoutMs: 10_000 }).catch(() => null);
    const ok = result?.code === 0 && /--login\b/.test(`${result.stdout}\n${result.stderr}`);
    return { ok, detail: ok ? null : "Install an agy version with ACP terminal sign-in (1.5 or later)." };
  }

  async prepareHome(home: string): Promise<void> {
    if (!SUPPORTED_PLATFORMS.has(this.platform)) throw new Error(unsupported);
    await mkdir(home, { recursive: true, mode: 0o700 });
  }

  async identity(home: string | null): Promise<Identity> {
    const { command } = await providerCommand(this.family);
    const env = spawnEnv(await this.env(home), this.family);
    const result = await this.exec(command, ["models"], { env, timeoutMs: 20_000 });
    if (result.code !== 0 && !signedOut.test(`${result.stdout}\n${result.stderr}`)) throw new Error("Antigravity could not check the sign-in.");
    if (result.code !== 0) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    if (home !== null) {
      // An added account must authenticate from its own token file; succeeding without it means agy fell back outside this home.
      const tokenPath = join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
      const hasToken = await access(tokenPath).then(() => true, (error: NodeJS.ErrnoException) => error.code !== "ENOENT");
      if (!hasToken) return { signedIn: false, email: null, plan: null, organization: null, identity: null };
    }
    const email = await signedInAntigravityEmail(env, { isolated: home !== null, platform: this.platform, readSecret: this.readSecret }).catch(() => null);
    return { signedIn: true, email, plan: null, organization: null, identity: email && `antigravity|${email}` };
  }

  async usage(home: string | null): Promise<UsageRead> {
    const { command } = await providerCommand(this.family);
    const result = await run(command, ["-p", "/usage", "--output-format", "json"], {
      env: spawnEnv(await this.env(home), this.family), timeoutMs: 20_000,
    });
    const windows = result.code === 0 ? parseAntigravityUsage(result.stdout) : [];
    return {
      fetchedAt: new Date().toISOString(), windows, cached: false, resets: null,
      error: windows.length ? null : "Antigravity did not report usage. Check /usage inside agy.",
    };
  }

  async login(home: string | null): Promise<LoginHandle> {
    const { command } = await providerCommand(this.family);
    return new AntigravityLogin(command, spawnEnv(await this.env(home), this.family));
  }

  // Removing a managed home deletes its file-backed login with it.
  async logout(): Promise<void> {}

  async redeemReset(): Promise<RedeemReply> {
    return { outcome: "none", message: "Antigravity has no banked resets in ZeroSub.", left: null };
  }

  detectLimit(): null { return null; }
  detectSignOut(): null { return null; }
}

export class AntigravityLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private ended = false;
  private submitted = false;

  constructor(command: string, env: NodeJS.ProcessEnv) {
    super();
    this.child = spawn(command, ["acp", "--login", "--disable-telemetry"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    const read = (chunk: string) => {
      output = (output + chunk).slice(-8192);
      const codeUrl = firstUrl(stripAnsi(output), /^https:\/\/accounts\.google\.com\//);
      if (codeUrl && codeUrl !== this.progress.codeUrl) this.update({ step: "waiting", codeUrl });
    };
    this.child.stdout.setEncoding("utf8").on("data", read);
    this.child.stderr.setEncoding("utf8").on("data", read);
    this.child.stdin.on("error", () => undefined);
    this.finished = new Promise((resolve) => {
      this.child.once("error", () => resolve({ ok: false, message: "Could not start Antigravity sign-in." }));
      this.child.once("close", (code) => {
        this.ended = true;
        resolve({ ok: code === 0, message: code === 0 ? null : "Antigravity sign-in did not finish. Start again for a fresh link." });
      });
    });
  }

  async submitCode(code: string): Promise<void> {
    if (this.ended || this.submitted || !this.progress.codeUrl) throw new Error("Start Antigravity sign-in again for a fresh link.");
    if (!code.trim() || /[\r\n]/.test(code)) throw new Error("Paste a single authorization code or redirect URL.");
    this.submitted = true;
    this.child.stdin.end(`${code.trim()}\n`);
  }

  cancel(): void {
    if (this.ended) return;
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (!this.ended) this.child.kill("SIGKILL");
    }, 3_000).unref();
  }
}
