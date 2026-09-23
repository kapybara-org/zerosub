import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import type { LoginMethod, Usage, UsageWindow } from "../shared/model";
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
import { browserCaptureScript, providerCommand } from "./binaries";
import { CLAUDE_RESET_PROGRAM, describeResetBlock, parseClaudeResets, readClaimReply } from "./claude-resets";
import { prepareClaudeHome } from "./homes";
import { detectClaudeLimit, detectClaudeSignOut } from "./limits";
import { mainClaudeGlobalConfig } from "./paths";
import { firstUrl, run, stripAnsi } from "./process";
import { retryDelayMs } from "./usage";

const API = "https://api.anthropic.com";

function apiHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

function isFresh(credentials: Credentials | null): credentials is Credentials {
  return Boolean(credentials?.accessToken) && (!credentials?.expiresAt || credentials.expiresAt > Date.now() + 60_000);
}

function statusFailure(status: number): RedeemReply {
  if (status === 429) return { outcome: "error", message: "Too many attempts. Wait a minute and try again.", left: null };
  if (status === 401 || status === 403) {
    return { outcome: "error", message: "Claude rejected this account's sign-in. Sign it in again, then retry.", left: null };
  }
  return { outcome: "error", message: `Claude answered with HTTP ${status}. Try again later.`, left: null };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Variables that would make a routed session use something other than its account's own login. */
const OVERRIDING_AUTH = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

export class ClaudeAdapter implements FamilyAdapter {
  readonly family = "claude" as const;
  readonly portable = true;
  /** Anthropic's usage endpoint answers 429 to rapid repeats. */
  readonly usageSpacingMs = 90_000;
  private readonly renewing = new Map<string, Promise<Credentials | null>>();
  private readonly resetNotes = new Map<string, string>();

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return { CLAUDE_CONFIG_DIR: null, CLAUDE_SECURESTORAGE_CONFIG_DIR: null };
    // Both point at the home so the keychain entry and refresh locks follow it even when the
    // daemon itself runs with CLAUDE_SECURESTORAGE_CONFIG_DIR set.
    const patch: EnvPatch = { CLAUDE_CONFIG_DIR: home, CLAUDE_SECURESTORAGE_CONFIG_DIR: home };
    for (const key of OVERRIDING_AUTH) if (process.env[key]) patch[key] = "";
    return patch;
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("claude");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  prepareHome(home: string): Promise<void> {
    return prepareClaudeHome(home);
  }

  async identity(home: string | null): Promise<Identity> {
    const { command, prefix } = await providerCommand("claude");
    const result = await run(command, [...prefix, "auth", "status", "--json"], {
      env: spawnEnv(await this.env(home)),
      timeoutMs: 30_000,
    });
    const status = parseJsonObject(result.stdout);
    if (!status) throw new Error(result.stderr.trim() || "Could not read Claude sign-in status");
    const signedIn = status.loggedIn === true;
    const email = str(status.email);
    const orgId = str(status.orgId);
    return {
      signedIn,
      email,
      plan: str(status.subscriptionType),
      organization: str(status.orgName),
      identity: email ? `${orgId ?? "personal"}|${email.toLowerCase()}` : null,
    };
  }

  async usage(home: string | null, options: { renewLogin?: boolean } = {}): Promise<UsageRead> {
    const fetchedAt = new Date().toISOString();
    let credentials = await readCredentials(home).catch(() => null);
    if (!isFresh(credentials) && options.renewLogin) credentials = await this.renewLogin(home);
    const profileScope = !credentials?.scopes || credentials.scopes.includes("user:profile");
    if (credentials?.accessToken && isFresh(credentials) && profileScope) {
      try {
        // The `cedar_ember` read is the one Claude Code's /limit-reset makes: usage plus banked resets.
        const response = await fetch(`${API}/api/oauth/usage?cedar_ember=1&skip_spend=1`, {
          headers: apiHeaders(credentials.accessToken),
          signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) {
          const body = (await response.json()) as { cedar_ember?: unknown };
          const windows = parseUsage(body);
          this.noteResetStatus(home, body.cedar_ember);
          return { fetchedAt, windows, error: null, cached: false, resets: parseClaudeResets(body.cedar_ember).offer };
        }
        // Anthropic rate-limits this endpoint (Claude Code and Paseo read it too). Wait as long as it
        // asks; meanwhile the last reading stays up, or Claude Code's own cached copy if it's newer.
        if (response.status === 429) {
          const retryAt = Date.now() + retryDelayMs(response.headers.get("retry-after"));
          const cached = await cachedUsage(home);
          return { ...(cached ?? { fetchedAt, windows: [], error: null, cached: false, resets: null }), retryAt };
        }
        if (response.status !== 401 && response.status !== 403) {
          return { fetchedAt, windows: [], error: `Usage request failed (HTTP ${response.status})`, cached: false, resets: null };
        }
      } catch (error) {
        return { fetchedAt, windows: [], error: error instanceof Error ? error.message : String(error), cached: false, resets: null };
      }
    }
    // An idle account's token may have expired; Claude Code refreshes it on next use. Until then,
    // show the last utilisation Claude Code itself cached for this account.
    const cached = await cachedUsage(home);
    if (cached) return cached;
    return { fetchedAt, windows: [], error: "Usage shows up after this account is next used.", cached: false, resets: null };
  }

  /** Logs (only when it changes) why an account does or doesn't show a banked reset. */
  private noteResetStatus(home: string | null, block: unknown): void {
    const key = home ? (home.split(/[\\/]/).pop() ?? home) : "CLI login";
    const note = describeResetBlock(block);
    if (this.resetNotes.get(key) === note) return;
    this.resetNotes.set(key, note);
    console.log(`[ZeroSub] Claude limit resets for ${key}: ${note}`);
  }

  /**
   * Has Claude Code itself refresh an expired sign-in: `claude -p /usage` runs locally (no model
   * call, no cost) and fetches usage with Claude Code's own refresh-and-lock logic. ZeroSub never
   * refreshes tokens itself, so two refreshers can't race and burn a single-use refresh token.
   */
  private renewLogin(home: string | null): Promise<Credentials | null> {
    const key = home ?? "";
    let pending = this.renewing.get(key);
    if (!pending) {
      pending = (async () => {
        const { command, prefix } = await providerCommand("claude");
        await run(command, [...prefix, "-p", "/usage", "--no-session-persistence", "--output-format", "json"], {
          env: spawnEnv(await this.env(home)),
          cwd: tmpdir(),
          timeoutMs: 90_000,
        });
        return readCredentials(home).catch(() => null);
      })().finally(() => this.renewing.delete(key));
      this.renewing.set(key, pending);
    }
    return pending;
  }

  async redeemReset(home: string | null, options: { onlyAtLimit?: boolean } = {}): Promise<RedeemReply> {
    let credentials = await readCredentials(home).catch(() => null);
    if (!isFresh(credentials)) credentials = await this.renewLogin(home);
    const token = credentials?.accessToken;
    if (!token || !isFresh(credentials)) {
      return { outcome: "error", message: "Couldn't use this account's sign-in. Sign it in again, then retry.", left: null };
    }

    // Ask which grant is next: the server only accepts that one.
    let status: ReturnType<typeof parseClaudeResets>;
    try {
      const response = await fetch(`${API}/api/oauth/usage?cedar_ember=1&skip_spend=1`, {
        headers: apiHeaders(token),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) return statusFailure(response.status);
      status = parseClaudeResets(((await response.json()) as { cedar_ember?: unknown }).cedar_ember);
    } catch (error) {
      return { outcome: "error", message: `Couldn't check the account's resets: ${describe(error)}`, left: null };
    }
    if (!status.offer || !status.nextGrantId) return { outcome: "none", message: "No banked resets left on this account.", left: 0 };
    if (options.onlyAtLimit && !status.atLimit) {
      // Something refilled the account since the limit hit, e.g. another host sharing it spent a reset.
      return { outcome: "not_limited", message: "Claude says this account has room again, so the reset was kept.", left: status.offer.available };
    }
    if (!status.offer.usableNow) {
      return {
        outcome: "unavailable",
        message: status.offer.blockedReason ?? "The reset can't be used right now.",
        left: status.offer.available,
      };
    }

    const organization = await this.organizationId(home);
    if (!organization) return { outcome: "error", message: "Couldn't tell which Claude organization this account belongs to.", left: null };
    try {
      const response = await fetch(`${API}/api/organizations/${organization}/reset_rate_limits`, {
        method: "POST",
        headers: apiHeaders(token),
        body: JSON.stringify({ program: CLAUDE_RESET_PROGRAM, grant_id: status.nextGrantId, request_id: randomUUID() }),
        signal: AbortSignal.timeout(25_000),
      });
      if (!response.ok) return statusFailure(response.status);
      return readClaimReply(await response.json().catch(() => null));
    } catch (error) {
      return {
        outcome: "error",
        message: `The reset request didn't finish (${describe(error)}), so it may or may not have gone through. Refresh usage before trying again.`,
        left: null,
      };
    }
  }

  /** The account's organization UUID, as Claude Code records it. */
  private async organizationId(home: string | null): Promise<string | null> {
    const config = parseJsonObject(await readFile(home ? join(home, ".claude.json") : mainClaudeGlobalConfig(), "utf8").catch(() => ""));
    const account = config?.oauthAccount as { organizationUuid?: unknown } | undefined;
    let id = typeof account?.organizationUuid === "string" ? account.organizationUuid : null;
    if (!id) {
      const { command, prefix } = await providerCommand("claude");
      const result = await run(command, [...prefix, "auth", "status", "--json"], { env: spawnEnv(await this.env(home)), timeoutMs: 30_000 });
      id = str(parseJsonObject(result.stdout)?.orgId);
    }
    return id && /^[0-9a-f-]{8,64}$/i.test(id) ? id : null;
  }

  async login(home: string | null, _method: LoginMethod): Promise<LoginHandle> {
    const { command, prefix } = await providerCommand("claude");
    const shim = await browserCaptureScript();
    const capture = join(tmpdir(), `zerosub-login-${randomBytes(6).toString("hex")}.url`);
    const env = spawnEnv(await this.env(home));
    if (shim) {
      env.BROWSER = shim;
      env.ZEROSUB_BROWSER_OUT = capture;
    }
    return new ClaudeLogin(command, [...prefix, "auth", "login", "--claudeai"], env, shim ? capture : null);
  }

  async logout(home: string): Promise<void> {
    const { command, prefix } = await providerCommand("claude");
    const result = await run(command, [...prefix, "auth", "logout"], { env: spawnEnv(await this.env(home)), timeoutMs: 30_000 });
    if (result.code === 0 || process.platform !== "darwin") return; // Elsewhere the login lives in the home itself.
    // Don't leave a live refresh token behind in the keychain for a home that is about to be deleted.
    await run("/usr/bin/security", ["delete-generic-password", "-a", keychainAccount(), "-s", keychainService(home)], {
      timeoutMs: 10_000,
    });
  }

  detectLimit = detectClaudeLimit;
  detectSignOut = detectClaudeSignOut;
}

class ClaudeLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private readonly child;
  private stdout = "";
  private stderr = "";
  private poll: ReturnType<typeof setInterval> | null = null;
  private canceled = false;
  private exited = false;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, private readonly capture: string | null) {
    super();
    this.child = spawn(command, args, { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin.on("error", () => undefined);
    this.finished = new Promise((resolve) => {
      this.child.on("error", (error) => {
        this.stop();
        resolve({ ok: false, message: `Could not start Claude Code: ${error.message}` });
      });
      this.child.on("close", (code) => {
        this.exited = true;
        this.stop();
        if (this.canceled) return resolve({ ok: false, message: "Sign-in was canceled." });
        if (code === 0) return resolve({ ok: true, message: null });
        const failure = this.stderr
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .reverse()
          .find((line) => /login failed|error/i.test(line));
        resolve({ ok: false, message: friendlyFailure(failure ?? this.stderr.trim()) });
      });
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.stdout += stripAnsi(chunk.toString("utf8"));
      const manual = firstUrl(this.stdout, /\/oauth\/authorize/);
      if (manual && manual !== this.progress.codeUrl) this.update({ codeUrl: manual, step: "waiting" });
    });
    this.child.stderr.on("data", (chunk: Buffer) => {
      const text = stripAnsi(chunk.toString("utf8"));
      this.stderr += text;
      if (/invalid code/i.test(text)) {
        this.update({ message: "That code didn't work. Copy the whole code from the page and paste it again." });
      }
    });
    if (capture) {
      const startedAt = Date.now();
      this.poll = setInterval(() => {
        void readFile(capture, "utf8")
          .then((value) => {
            const url = value.trim();
            if (url.startsWith("http") && url !== this.progress.url) this.update({ url });
          })
          .catch(() => undefined);
        if (Date.now() - startedAt > 20_000 && this.poll) clearInterval(this.poll);
      }, 250);
    }
  }

  async submitCode(code: string): Promise<void> {
    let value = code.trim().replace(/\s+/g, "");
    if (!value) throw new Error("Paste the code from the sign-in page.");
    // The CLI only checks that a `#state` suffix is present; the exchange uses the flow's own state.
    if (!value.includes("#")) value = `${value}#zerosub`;
    if (this.exited) throw new Error("This sign-in has ended. Start again.");
    this.update({ message: "Checking the code…" });
    this.child.stdin.write(`${value}\n`);
  }

  cancel(): void {
    this.canceled = true;
    this.child.kill("SIGTERM");
  }

  private stop(): void {
    if (this.poll) clearInterval(this.poll);
    if (this.capture) void rm(this.capture, { force: true });
  }
}

function friendlyFailure(message: string): string {
  if (!message) return "Sign-in did not finish.";
  if (/status code 400/i.test(message)) return "That code was rejected. Start again and paste the newest code.";
  return message.replace(/^Login failed:\s*/i, "Sign-in failed: ");
}

// --------------------------------------------------------------------------- credentials (read-only)

interface Credentials {
  accessToken: string | null;
  expiresAt: number | null;
  scopes: string[] | null;
}

function keychainAccount(): string {
  let name: string;
  try {
    name = process.env.USER || userInfo().username;
  } catch {
    name = "claude-code-user";
  }
  return /^[a-zA-Z0-9._-]+$/.test(name) ? name : "claude-code-user";
}

/** Directory that decides where Claude Code keeps credentials for a home. */
function storageDir(home: string | null): { path: string; hashed: boolean } {
  if (home) return { path: home, hashed: true };
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) return secure ? { path: secure, hashed: true } : { path: join(homedir(), ".claude"), hashed: false };
  const config = process.env.CLAUDE_CONFIG_DIR;
  return config ? { path: config, hashed: true } : { path: join(homedir(), ".claude"), hashed: false };
}

/** Matches Claude Code: "Claude Code-credentials" plus the first 8 hex of sha256(NFC path) for custom dirs. */
export function keychainService(home: string | null): string {
  const { path, hashed } = storageDir(home);
  if (!hashed) return "Claude Code-credentials";
  return `Claude Code-credentials-${createHash("sha256").update(path.normalize("NFC")).digest("hex").slice(0, 8)}`;
}

function parseCredentials(raw: string): Credentials | null {
  let text = raw.trim();
  if (/^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) text = Buffer.from(text, "hex").toString("utf8");
  const parsed = parseJsonObject(text);
  const oauth = parsed?.claudeAiOauth as Record<string, unknown> | undefined;
  if (!oauth) return null;
  return {
    accessToken: str(oauth.accessToken),
    expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null,
    scopes: Array.isArray(oauth.scopes) ? oauth.scopes.filter((scope): scope is string => typeof scope === "string") : null,
  };
}

/** Reads the account's OAuth token only to ask Anthropic for its usage. Never logged or stored. */
async function readCredentials(home: string | null): Promise<Credentials | null> {
  if (process.platform === "darwin") {
    const result = await run(
      "/usr/bin/security",
      ["find-generic-password", "-a", keychainAccount(), "-w", "-s", keychainService(home)],
      { timeoutMs: 10_000 },
    );
    if (result.code === 0) {
      const credentials = parseCredentials(result.stdout);
      if (credentials) return credentials;
    }
  }
  const file = join(storageDir(home).path, ".credentials.json");
  return parseCredentials(await readFile(file, "utf8"));
}

async function cachedUsage(home: string | null): Promise<Usage | null> {
  const config = parseJsonObject(await readFile(home ? join(home, ".claude.json") : mainClaudeGlobalConfig(), "utf8").catch(() => ""));
  const cache = config?.cachedUsageUtilization as { fetchedAtMs?: unknown; utilization?: unknown } | undefined;
  if (!cache || typeof cache.fetchedAtMs !== "number") return null;
  const windows = parseUsage(cache.utilization);
  if (windows.length === 0) return null;
  return { fetchedAt: new Date(cache.fetchedAtMs).toISOString(), windows, error: null, cached: true, resets: null };
}

const WINDOW_LABELS: Array<[key: string, label: string]> = [
  ["five_hour", "5-hour"],
  ["seven_day", "Weekly"],
  ["seven_day_opus", "Weekly · Opus"],
  ["seven_day_sonnet", "Weekly · Sonnet"],
];

export function parseUsage(body: unknown): UsageWindow[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const windows: UsageWindow[] = [];
  for (const [key, label] of WINDOW_LABELS) {
    const entry = record[key] as { utilization?: unknown; resets_at?: unknown } | null | undefined;
    if (entry && typeof entry.utilization === "number") {
      windows.push({ id: key, label, usedPercent: entry.utilization, resetsAt: isoDate(entry.resets_at) });
    }
  }
  if (Array.isArray(record.limits)) {
    for (const limit of record.limits as Array<Record<string, unknown>>) {
      if (limit?.kind !== "weekly_scoped" || typeof limit.percent !== "number") continue;
      const scope = limit.scope as { model?: { display_name?: unknown }; surface?: { display_name?: unknown } } | undefined;
      const name = str(scope?.model?.display_name) ?? str(scope?.surface?.display_name);
      if (!name || windows.some((window) => window.label === `Weekly · ${name}`)) continue;
      windows.push({
        id: `weekly_${name.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`,
        label: `Weekly · ${name}`,
        usedPercent: limit.percent,
        resetsAt: isoDate(limit.resets_at),
      });
    }
  }
  return windows;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  try {
    const value = JSON.parse(text.slice(start)) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isoDate(value: unknown): string | null {
  const text = str(value);
  if (!text) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
