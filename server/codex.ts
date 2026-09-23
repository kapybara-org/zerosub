import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { LoginMethod, ResetOffer, Usage, UsageWindow } from "../shared/model";
import {
  ProgressEmitter,
  spawnEnv,
  type EnvPatch,
  type FamilyAdapter,
  type Identity,
  type LoginHandle,
  type RedeemReply,
} from "./adapter";
import { providerCommand } from "./binaries";
import { codexSqliteHome, prepareCodexHome } from "./homes";
import { detectCodexLimit, detectCodexSignOut } from "./limits";
import { run } from "./process";

/** The originator Codex's own CLI logs in with; the sign-in service knows it. */
const CLIENT_NAME = "codex_cli_rs";

type Json = Record<string, unknown>;

/** Newline-delimited JSON-RPC with `codex app-server` (no `jsonrpc` field on the wire). */
class AppServer {
  private nextId = 1;
  private buffer = "";
  private stderr = "";
  private closed = false;
  private ending = false;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  private readonly listeners = new Map<string, Set<(params: Json) => void>>();
  readonly exited: Promise<void>;

  private constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdin.on("error", () => undefined);
    child.stdout.on("data", (chunk: Buffer) => this.receive(chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4_000);
    });
    this.exited = new Promise((resolve) => {
      const finish = (error?: Error) => {
        this.closed = true;
        const reason = error ?? new Error(this.stderr.trim().split("\n").pop() || "Codex exited");
        for (const request of this.pending.values()) request.reject(reason);
        this.pending.clear();
        resolve();
      };
      child.on("error", (error) => finish(error));
      child.on("close", () => finish());
    });
  }

  static async open(env: NodeJS.ProcessEnv): Promise<AppServer> {
    const { command, prefix } = await providerCommand("codex");
    const child = spawn(command, [...prefix, "app-server"], { env, stdio: ["pipe", "pipe", "pipe"] });
    const server = new AppServer(child);
    try {
      await server.request(
        "initialize",
        { clientInfo: { name: CLIENT_NAME, title: "Paseo ZeroSub", version: "1.0.0" }, capabilities: { experimentalApi: false } },
        60_000,
      );
      server.send({ method: "initialized" });
      return server;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  on(method: string, listener: (params: Json) => void): void {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(listener);
  }

  request(method: string, params?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed || this.ending) return Promise.reject(new Error("Codex is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not answer ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send(params === undefined ? { id, method } : { id, method, params });
    });
  }

  close(): void {
    if (this.closed || this.ending) return;
    this.ending = true;
    for (const request of this.pending.values()) request.reject(new Error("Codex was stopped"));
    this.pending.clear();
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    setTimeout(() => {
      if (!this.closed) this.child.kill("SIGKILL");
    }, 3_000).unref();
  }

  private send(message: Json): void {
    if (!this.closed && !this.ending) this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(text: string): void {
    this.buffer += text;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
      if (!line) continue;
      let message: Json;
      try {
        message = JSON.parse(line) as Json;
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: Json): void {
    const id = typeof message.id === "number" ? message.id : null;
    if (id !== null && typeof message.method === "string") {
      // A request from the server (e.g. external token refresh); ZeroSub never uses external auth.
      this.send({ id, error: { code: -32601, message: "Not supported" } });
      return;
    }
    if (id !== null) {
      const request = this.pending.get(id);
      if (!request) return;
      this.pending.delete(id);
      const error = message.error as { message?: unknown } | undefined;
      if (error) request.reject(new Error(typeof error.message === "string" ? error.message : "Codex request failed"));
      else request.resolve(message.result);
      return;
    }
    if (typeof message.method === "string") {
      for (const listener of this.listeners.get(message.method) ?? []) listener((message.params ?? {}) as Json);
    }
  }
}

interface Snapshot {
  identity: Identity;
  usage: Usage;
}

export class CodexAdapter implements FamilyAdapter {
  readonly family = "codex" as const;
  /** ChatGPT accounts can't decrypt each other's reasoning, so threads stay on their account. */
  readonly portable = false;
  readonly usageSpacingMs = 20_000;
  private readonly snapshots = new Map<string, { at: number; value: Promise<Snapshot> }>();

  async env(home: string | null): Promise<EnvPatch> {
    if (!home) return { CODEX_HOME: null, CODEX_SQLITE_HOME: null };
    const patch: EnvPatch = { CODEX_HOME: home };
    // Share thread metadata with the main home so every account sees the same threads.
    const sqlite = await codexSqliteHome();
    patch.CODEX_SQLITE_HOME = sqlite;
    if (process.env.CODEX_ACCESS_TOKEN) patch.CODEX_ACCESS_TOKEN = "";
    return patch;
  }

  async available(): Promise<{ ok: boolean; detail: string | null }> {
    const { command, prefix } = await providerCommand("codex");
    const result = await run(command, [...prefix, "--version"], { timeoutMs: 30_000 });
    if (result.code === 0) return { ok: true, detail: null };
    return { ok: false, detail: (result.stderr || result.stdout).trim().split("\n")[0] || `${command} not found` };
  }

  prepareHome(home: string): Promise<void> {
    return prepareCodexHome(home);
  }

  async identity(home: string | null): Promise<Identity> {
    return (await this.snapshot(home)).identity;
  }

  async usage(home: string | null): Promise<Usage> {
    return (await this.snapshot(home, true)).usage;
  }

  /** One short app-server session answers both "who is this" and "how much is left". */
  private snapshot(home: string | null, fresh = false): Promise<Snapshot> {
    const key = home ?? "";
    const cached = this.snapshots.get(key);
    if (cached && Date.now() - cached.at < (fresh ? 5_000 : 15_000)) return cached.value;
    const value = this.readSnapshot(home);
    this.snapshots.set(key, { at: Date.now(), value });
    value.catch(() => this.snapshots.delete(key));
    return value;
  }

  private async readSnapshot(home: string | null): Promise<Snapshot> {
    const server = await AppServer.open(spawnEnv(await this.env(home)));
    try {
      const account = ((await server.request("account/read", {})) ?? {}) as Json;
      const details = account.account as { type?: unknown; email?: unknown; planType?: unknown } | null;
      const fetchedAt = new Date().toISOString();
      if (!details || details.type !== "chatgpt") {
        const signedIn = Boolean(details);
        return {
          identity: { signedIn, email: null, plan: signedIn ? "API key" : null, organization: null, identity: null },
          usage: {
            fetchedAt,
            windows: [],
            error: signedIn ? "Signed in with an API key, not a ChatGPT plan." : "Not signed in.",
            cached: false,
            resets: null,
          },
        };
      }
      const email = typeof details.email === "string" ? details.email : null;
      const plan = typeof details.planType === "string" ? details.planType : null;
      let usage: Usage;
      let accountId: string | null = null;
      try {
        // Background reads skip the reset-credit detail lookup; the count still comes back.
        let limits = (await server.request("account/rateLimits/read", { excludeResetCreditDetails: true })) as Json;
        if (resetCount(limits.rateLimitResetCredits) > 0) {
          limits = (await server.request("account/rateLimits/read", {}).catch(() => limits)) as Json;
        }
        accountId = typeof limits.accountId === "string" ? limits.accountId : null;
        usage = {
          fetchedAt,
          windows: parseRateLimits(limits.rateLimits),
          error: null,
          cached: false,
          resets: parseResetCredits(limits.rateLimitResetCredits),
        };
      } catch (error) {
        usage = { fetchedAt, windows: [], error: error instanceof Error ? error.message : String(error), cached: false, resets: null };
      }
      return {
        identity: {
          signedIn: true,
          email,
          plan,
          organization: null,
          // The ChatGPT account (workspace) ID tells a personal plan from a Team workspace on the same
          // email; without it, fall back to email plus plan so those two still stay distinct.
          identity: accountId ? `chatgpt|${accountId}` : email ? `chatgpt-email|${email.toLowerCase()}|${plan ?? "unknown"}` : null,
        },
        usage,
      };
    } finally {
      server.close();
    }
  }

  async login(home: string | null, method: LoginMethod): Promise<LoginHandle> {
    this.snapshots.delete(home ?? "");
    const server = await AppServer.open(spawnEnv(await this.env(home)));
    return new CodexLogin(server, method, () => this.snapshots.delete(home ?? ""));
  }

  async logout(home: string): Promise<void> {
    this.snapshots.delete(home);
    const server = await AppServer.open(spawnEnv(await this.env(home)));
    try {
      await server.request("account/logout");
    } finally {
      server.close();
    }
  }

  /**
   * Codex's own reset-credit API (what `/usage` → reset in the Codex CLI uses). It never spends a
   * credit while nothing is used up (`nothingToReset`), so automatic use needs no extra check.
   */
  async redeemReset(home: string | null): Promise<RedeemReply> {
    this.snapshots.delete(home ?? "");
    const server = await AppServer.open(spawnEnv(await this.env(home)));
    try {
      // One idempotency key per attempt, so a retried request can never spend a second credit.
      const reply = (await server.request(
        "account/rateLimitResetCredit/consume",
        { idempotencyKey: randomUUID() },
        60_000,
      )) as { outcome?: unknown };
      const after = (await server.request("account/rateLimits/read", { excludeResetCreditDetails: true }).catch(() => null)) as Json | null;
      const left = after ? resetCount(after.rateLimitResetCredits) : null;
      return readConsumeReply(reply?.outcome, left);
    } catch (error) {
      return {
        outcome: "error",
        message: `The reset request didn't finish (${error instanceof Error ? error.message : String(error)}). Refresh usage before trying again.`,
        left: null,
      };
    } finally {
      server.close();
      this.snapshots.delete(home ?? "");
    }
  }

  detectLimit = detectCodexLimit;
  detectSignOut = detectCodexSignOut;
}

class CodexLogin extends ProgressEmitter implements LoginHandle {
  readonly finished: Promise<{ ok: boolean; message: string | null }>;
  private loginId: string | null = null;
  private settle!: (result: { ok: boolean; message: string | null }) => void;
  private done = false;

  constructor(
    private readonly server: AppServer,
    method: LoginMethod,
    private readonly onFinished: () => void,
  ) {
    super();
    this.finished = new Promise((resolve) => {
      this.settle = (result) => {
        if (this.done) return;
        this.done = true;
        this.server.close();
        this.onFinished();
        resolve(result);
      };
    });
    server.on("account/login/completed", (params) => {
      if (this.loginId && params.loginId && params.loginId !== this.loginId) return;
      if (params.success === true) this.settle({ ok: true, message: null });
      else this.settle({ ok: false, message: friendlyCodexError(typeof params.error === "string" ? params.error : null) });
    });
    void server.exited.then(() => this.settle({ ok: false, message: "Codex stopped before sign-in finished." }));
    void this.begin(method);
  }

  private async begin(method: LoginMethod): Promise<void> {
    try {
      const result = (await this.server.request("account/login/start", {
        type: method === "code" ? "chatgptDeviceCode" : "chatgpt",
      })) as Json;
      this.loginId = typeof result.loginId === "string" ? result.loginId : null;
      if (result.type === "chatgptDeviceCode") {
        this.update({
          step: "waiting",
          url: typeof result.verificationUrl === "string" ? result.verificationUrl : null,
          userCode: typeof result.userCode === "string" ? result.userCode : null,
          message:
            "If the page says device codes are off, turn on “device code login” in ChatGPT → Settings → Security, or use the browser option.",
        });
      } else {
        this.update({ step: "waiting", url: typeof result.authUrl === "string" ? result.authUrl : null });
      }
    } catch (error) {
      this.settle({ ok: false, message: friendlyCodexError(error instanceof Error ? error.message : String(error)) });
    }
  }

  async submitCode(): Promise<void> {
    throw new Error("ChatGPT sign-in doesn't use a pasted code. Finish on the sign-in page.");
  }

  cancel(): void {
    if (this.done) return;
    const loginId = this.loginId;
    if (loginId) void this.server.request("account/login/cancel", { loginId }, 5_000).catch(() => undefined);
    setTimeout(() => this.settle({ ok: false, message: "Sign-in was canceled." }), 300);
  }
}

function friendlyCodexError(message: string | null): string {
  if (!message) return "Sign-in did not finish.";
  if (/device code login is not enabled/i.test(message)) {
    return "Device-code sign-in is turned off for this ChatGPT account. Turn on “device code login” in ChatGPT → Settings → Security, or sign in with the browser option.";
  }
  if (/not completed|timed out/i.test(message)) return "Sign-in timed out or was closed. Try again.";
  return message;
}

function windowLabel(minutes: number | null): string {
  if (!minutes) return "Usage";
  if (minutes === 10_080) return "Weekly";
  if (minutes % 1_440 === 0) return `${minutes / 1_440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export function parseRateLimits(snapshot: unknown): UsageWindow[] {
  if (!snapshot || typeof snapshot !== "object") return [];
  const record = snapshot as Json;
  const windows: UsageWindow[] = [];
  for (const key of ["primary", "secondary"] as const) {
    const window = record[key] as { usedPercent?: unknown; windowDurationMins?: unknown; resetsAt?: unknown } | null;
    if (!window || typeof window.usedPercent !== "number") continue;
    const minutes = typeof window.windowDurationMins === "number" ? window.windowDurationMins : null;
    windows.push({
      id: key,
      label: windowLabel(minutes),
      usedPercent: window.usedPercent,
      resetsAt: typeof window.resetsAt === "number" ? new Date(window.resetsAt * 1000).toISOString() : null,
    });
  }
  return windows;
}

/** Banked reset credits, from `rateLimitResetCredits` (`availableCount` is a JSON number on the wire). */
export function resetCount(summary: unknown): number {
  const count = (summary as { availableCount?: unknown } | null)?.availableCount;
  return typeof count === "number" && Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function parseResetCredits(summary: unknown): ResetOffer | null {
  const available = resetCount(summary);
  if (available === 0) return null;
  const credits = (summary as { credits?: unknown }).credits;
  const usable = (Array.isArray(credits) ? credits : []).filter(
    (credit): credit is Json => Boolean(credit) && typeof credit === "object" && (credit as Json).status === "available",
  );
  const expiring = usable
    .map((credit) => (typeof credit.expiresAt === "number" ? credit.expiresAt : null))
    .filter((at): at is number => at !== null)
    .sort((a, b) => a - b);
  const title = usable.map((credit) => credit.title).find((value): value is string => typeof value === "string" && value.trim() !== "");
  return {
    available,
    // Codex decides at redeem time (it answers "nothing to reset" when the limits aren't used up).
    usableNow: true,
    blockedReason: null,
    expiresAt: expiring[0] !== undefined ? new Date(expiring[0] * 1000).toISOString() : null,
    refills: ["5-hour", "weekly"],
    label: title?.trim() ?? null,
  };
}

export function readConsumeReply(outcome: unknown, left: number | null): RedeemReply {
  const leftText = left === null ? "" : ` · ${left} left`;
  switch (outcome) {
    case "reset":
      return { outcome: "reset", message: `Codex usage limits reset${leftText}.`, left };
    case "nothingToReset":
      return {
        outcome: "not_limited",
        message: "Nothing to reset: this account's limits aren't used up, so the reset was kept.",
        left,
      };
    case "noCredit":
      return { outcome: "none", message: "No banked resets left on this account.", left: 0 };
    case "alreadyRedeemed":
      return { outcome: "already_used", message: `That reset was already used${leftText}.`, left };
    default:
      return { outcome: "error", message: "Codex sent an unexpected reply. Refresh usage before trying again.", left };
  }
}
