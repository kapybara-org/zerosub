import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { delimiter } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { PluginHandlerContext, PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import {
  OmpSettingsSchema,
  type LoginStep,
  type OmpAccountView,
  type OmpLoginView,
  type OmpSettings,
  type OmpView,
  type ResetOffer,
  type UsageWindow,
} from "../shared/model";
import { providerCommand, type Command } from "./binaries";
import { writeJsonAtomic } from "./json-file";
import { buildOverlay, OmpControlsStore, overlayPath, sameAccount, type AccountKey, type OmpControls } from "./omp-controls";
import { run, stripAnsi } from "./process";

type PaseoApi = PluginHandlerContext["paseo"];

/** Offered for sign-in even before they have an account; providers that already have one are offered too. */
const SIGN_IN_PROVIDERS = ["anthropic", "openai-codex"];
/** Models `omp dry-balance` previews with, per provider; OMP resolves the short names itself. */
const PREVIEW_MODELS: Record<string, string> = { anthropic: "anthropic/sonnet", "openai-codex": "openai-codex/gpt" };
/** OMP settings shown as the default beside ZeroSub's own choice. */
const DEFAULT_KEYS = [...Object.keys(OmpSettingsSchema.shape), "retry.usageReservePct"];
const STALE_MS = 60_000;
const ENABLED_CACHE_MS = 30_000;
const NOT_INSTALLED_RECHECK_MS = 5 * 60_000;
const LOGIN_TIMEOUT_MS = 15 * 60_000;
const FINISHED_LOGIN_TTL_MS = 10 * 60_000;
/** A bare session: no tools, extensions or context, nothing saved. Only the account commands are used. */
const RPC_ARGS = [
  "--mode", "rpc", "--no-session", "--no-ui", "--no-tools", "--no-extensions",
  "--no-skills", "--no-rules", "--no-lsp", "--no-title",
];

interface Frame {
  type?: string;
  id?: string;
  success?: boolean;
  data?: unknown;
  error?: string;
  method?: string;
  url?: string;
  instructions?: string;
  title?: string;
  message?: string;
}

interface StoredAccount {
  credentialId: number;
  provider: string;
  label: string;
  type: string;
}

interface UsageReport {
  provider: string;
  /** Epoch ms when OMP read this report from the provider. */
  fetchedAt?: number;
  limits?: Array<{
    id: string;
    label: string;
    window?: { resetsAt?: number };
    amount?: { usedFraction?: number };
  }>;
  metadata?: { accountId?: string; orgId?: string };
}

interface ResetAccount {
  provider: string;
  credentialId: number;
  accountId?: string;
  orgId?: string;
  availableCount: number;
  redeemableCount: number;
  soonestExpiry?: string;
  unavailableReason?: string;
  credits?: Array<{ title?: string }>;
}

interface Login {
  id: string;
  provider: string;
  step: LoginStep;
  url: string | null;
  instructions: string | null;
  codePrompt: string | null;
  message: string | null;
  /** The pending `input` request OMP wants the pasted code for. */
  promptId: string | null;
  process: OmpProcess | null;
  endedAt: number | null;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isOpen(step: LoginStep): boolean {
  return step === "starting" || step === "waiting" || step === "verifying";
}

/** One short-lived `omp --mode rpc` process, spoken to in JSON lines. */
class OmpProcess {
  private readonly child: ChildProcess;
  private readonly pending = new Map<string, { resolve(data: unknown): void; reject(error: Error): void }>();
  private nextId = 0;
  private stderr = "";

  constructor(omp: Command, private readonly onUi?: (frame: Frame) => void) {
    this.child = spawn(omp.command, [...omp.prefix, ...RPC_ARGS], { cwd: tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    this.child.stdin?.on("error", () => undefined);
    this.child.stderr?.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-2_000);
    });
    if (this.child.stdout) createInterface({ input: this.child.stdout }).on("line", (line) => this.receive(line));
    this.child.on("error", (error) => this.failAll(error));
    this.child.on("close", (code) => {
      const detail = stripAnsi(this.stderr).trim().split("\n").pop();
      this.failAll(new Error(`omp exited${code === null ? "" : ` with code ${code}`}${detail ? `: ${detail}` : ""}`));
    });
  }

  request<T>(command: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    const id = `zerosub-${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`omp did not answer ${String(command.type)} in time`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (data) => {
          clearTimeout(timer);
          resolve(data as T);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.send({ ...command, id });
    });
  }

  send(frame: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(frame)}\n`);
  }

  close(): void {
    this.child.kill();
  }

  private receive(line: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(line) as Frame;
    } catch {
      return;
    }
    if (frame.type === "response" && frame.id && this.pending.has(frame.id)) {
      const waiter = this.pending.get(frame.id)!;
      this.pending.delete(frame.id);
      if (frame.success) waiter.resolve(frame.data);
      else waiter.reject(new Error(frame.error ?? "omp refused the request"));
    } else if (frame.type === "extension_ui_request") {
      this.onUi?.(frame);
    }
  }

  private failAll(error: Error): void {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

/** Every OAuth account in OMP's store, read through its rpc account commands. */
async function listAccounts(omp: Command): Promise<{ names: Map<string, string>; accounts: StoredAccount[] }> {
  const rpc = new OmpProcess(omp);
  try {
    const { providers } = await rpc.request<{ providers: Array<{ id: string; name: string; authenticated: boolean }> }>({
      type: "get_login_providers",
    });
    const names = new Map(providers.map((provider) => [provider.id, provider.name]));
    const lists = await Promise.all(
      providers
        .filter((provider) => provider.authenticated)
        .map((provider) =>
          rpc.request<{ accounts: StoredAccount[] }>({ type: "get_logout_accounts", providerId: provider.id }),
        ),
    );
    // Login aliases (`openai-codex-device`) list the same credentials as their target.
    const accounts = new Map<string, StoredAccount>();
    for (const account of lists.flatMap((list) => list.accounts)) {
      if (account.type === "oauth") accounts.set(`${account.provider}/${account.credentialId}`, account);
    }
    return { names, accounts: [...accounts.values()] };
  } finally {
    rpc.close();
  }
}

async function runJson<T>(omp: Command, args: string[]): Promise<T> {
  const result = await run(omp.command, [...omp.prefix, ...args], { timeoutMs: 60_000, cwd: tmpdir() });
  if (result.code !== 0) throw new Error(stripAnsi(result.stderr || result.stdout).trim() || `omp ${args.join(" ")} failed`);
  return JSON.parse(result.stdout) as T;
}

function toWindows(report: UsageReport | undefined): UsageWindow[] {
  return (report?.limits ?? []).flatMap((limit) =>
    typeof limit.amount?.usedFraction === "number"
      ? [
          {
            id: limit.id,
            label: limit.label,
            usedPercent: Math.round(limit.amount.usedFraction * 1000) / 10,
            resetsAt: limit.window?.resetsAt ? new Date(limit.window.resetsAt).toISOString() : null,
          },
        ]
      : [],
  );
}

function toResets(reset: ResetAccount | undefined): ResetOffer | null {
  if (!reset || reset.availableCount <= 0) return null;
  const usableNow = reset.redeemableCount > 0;
  return {
    available: reset.availableCount,
    usableNow,
    blockedReason: usableNow ? null : `OMP can't use a reset on this account right now (${reset.unavailableReason ?? "not redeemable"}).`,
    expiresAt: reset.soonestExpiry ?? null,
    refills: [],
    label: reset.credits?.[0]?.title ?? null,
  };
}

/** One recorded limit reading from `omp usage --history --json`. */
interface HistoryEntry {
  recordedAt: number;
  provider: string;
  accountId?: string;
  limitId: string;
  label: string;
  usedFraction?: number | null;
  resetsAt?: number | null;
}

/** The account's newest recorded reading, for when OMP has no live one (e.g. the provider refused it for a while). */
function lastRecorded(history: HistoryEntry[], provider: string, accountId: string): { windows: UsageWindow[]; at: number } | null {
  const rows = history.filter((entry) => entry.provider === provider && entry.accountId === accountId);
  const at = Math.max(...rows.map((entry) => entry.recordedAt));
  const windows = rows.flatMap((entry) =>
    entry.recordedAt === at && typeof entry.usedFraction === "number"
      ? [
          {
            id: entry.limitId,
            label: entry.label,
            usedPercent: Math.round(entry.usedFraction * 1000) / 10,
            resetsAt: entry.resetsAt ? new Date(entry.resetsAt).toISOString() : null,
          },
        ]
      : [],
  );
  return windows.length > 0 ? { windows, at } : null;
}

/**
 * Pairs each account with its usage report. Reports carry no credential id, so the match goes
 * through the account id OMP's reset listing gives per credential; a provider with a single account
 * and a single report needs no id. Without a live report, the newest recorded reading stands in.
 */
export function joinAccounts(
  accounts: StoredAccount[],
  reports: UsageReport[],
  resets: ResetAccount[],
  history: HistoryEntry[] = [],
  controls: OmpControls = { preferred: [], reserves: [], settings: {} },
): OmpAccountView[] {
  return accounts
    .map((account) => {
      const reset = resets.find((entry) => entry.provider === account.provider && entry.credentialId === account.credentialId);
      const candidates = reports.filter((report) => report.provider === account.provider);
      const siblings = accounts.filter((other) => other.provider === account.provider).length;
      const report = reset?.accountId
        ? candidates.find(
            (entry) =>
              entry.metadata?.accountId === reset.accountId &&
              (!reset.orgId || !entry.metadata?.orgId || entry.metadata.orgId === reset.orgId),
          )
        : siblings === 1 && candidates.length === 1
          ? candidates[0]
          : undefined;
      const live = toWindows(report);
      const recorded = live.length === 0 && reset?.accountId ? lastRecorded(history, account.provider, reset.accountId) : null;
      const usageAt = recorded?.at ?? report?.fetchedAt;
      const key = accountKey(reset);
      return {
        provider: account.provider,
        credentialId: account.credentialId,
        label: account.label,
        windows: recorded?.windows ?? live,
        usageAt: usageAt ? new Date(usageAt).toISOString() : null,
        resets: toResets(reset),
        controllable: key !== null,
        preferred: key !== null && controls.preferred.some((ref) => sameAccount(ref, key)),
        reservePct: (key && controls.reserves.find((ref) => sameAccount(ref, key))?.reservePct) ?? null,
      };
    })
    .sort((a, b) => a.provider.localeCompare(b.provider) || a.credentialId - b.credentialId);
}

/** The ids OMP's account policies select this login by; only known for accounts with reset listings. */
function accountKey(reset: ResetAccount | undefined): AccountKey | null {
  return reset?.accountId ? { provider: reset.provider, accountId: reset.accountId, orgId: reset.orgId ?? null } : null;
}

type Preview = OmpView["preview"][number];

/** Where new sessions would go right now, by OMP's own balancer with the overlay applied. */
async function previewBalance(omp: Command, provider: string): Promise<Preview | null> {
  const model = PREVIEW_MODELS[provider];
  if (!model) return null;
  const result = await runJson<{ model: string; success: { accounts: Array<{ account: string; percent: number }> } }>(omp, [
    "dry-balance", model, "--count", "20", "--json", "--config", overlayPath(),
  ]).catch(() => null);
  return result
    ? { provider, model: result.model, accounts: result.success.accounts.map((entry) => ({ label: entry.account, percent: entry.percent })) }
    : null;
}

/**
 * Exposes OMP's own multi-account store. OMP balances its agents across these accounts and moves
 * off one that hits a limit by itself, so ZeroSub only lists, adds, removes and resets them.
 */
export class OmpAccounts {
  private snapshot: Omit<OmpView, "logins" | "settings"> | null = null;
  private loading: Promise<void> | null = null;
  private loadedAt = 0;
  private installed: { at: number; ok: boolean } | null = null;
  private enabled: { at: number; value: boolean } | null = null;
  private readonly logins = new Map<string, Login>();
  private readonly controls = new OmpControlsStore();
  /** `omp config list --json`: OMP's own settings, read without ZeroSub's overlay. */
  private config: Record<string, { value?: unknown }> | null = null;
  /** `provider/credentialId` → the ids its policies select it by. */
  private identities = new Map<string, AccountKey>();
  private overlayWritten: Promise<void> | null = null;

  async view(paseo: PaseoApi, refresh: boolean): Promise<OmpView | undefined> {
    if (!(await this.isEnabled(paseo)) || !(await this.isInstalled())) return undefined;
    if (refresh) await this.load(true);
    else if (Date.now() - this.loadedAt > STALE_MS) void this.load(false);
    const base = this.snapshot ?? { providers: [], accounts: [], fetchedAt: null, error: null, defaults: {}, policiesLocked: false, preview: [] };
    return { ...base, settings: (await this.controls.read()).settings, logins: [...this.logins.values()].map(toLoginView) };
  }

  /** Adds ZeroSub's overlay to every OMP session Paseo opens, after any overlays already configured. */
  async openSession(request: PluginSessionOpenRequest): Promise<PluginSessionOpenRequest | undefined> {
    if (!(await this.isInstalled())) return undefined;
    await (this.overlayWritten ??= this.writeOverlay());
    const existing = (request.env.PI_CONFIG_FILES ?? process.env.PI_CONFIG_FILES ?? "").split(delimiter).filter(Boolean);
    if (existing.includes(overlayPath())) return undefined;
    return { ...request, env: { ...request.env, PI_CONFIG_FILES: [...existing, overlayPath()].join(delimiter) } };
  }

  async prefer(provider: string, credentialId: number, preferred: boolean): Promise<void> {
    const key = this.identityOf(provider, credentialId);
    await this.change((draft) => {
      draft.preferred = draft.preferred.filter((ref) => ref.provider !== provider);
      if (preferred) draft.preferred.push(key);
    });
  }

  async setReserve(provider: string, credentialId: number, reservePct: number | null): Promise<void> {
    const key = this.identityOf(provider, credentialId);
    await this.change((draft) => {
      draft.reserves = draft.reserves.filter((ref) => !sameAccount(ref, key));
      if (reservePct !== null) draft.reserves.push({ ...key, reservePct });
    });
  }

  async setSettings(settings: OmpSettings): Promise<void> {
    await this.change((draft) => {
      draft.settings = settings;
    });
  }

  private identityOf(provider: string, credentialId: number): AccountKey {
    const key = this.identities.get(`${provider}/${credentialId}`);
    if (!key) throw new Error("OMP doesn't say which account this login belongs to, so ZeroSub can't set its preferences.");
    return key;
  }

  /** Saves a change, rewrites the overlay new OMP sessions read, and refreshes the preview. */
  private async change(edit: (draft: OmpControls) => void): Promise<void> {
    await this.controls.update(edit);
    this.overlayWritten = this.writeOverlay();
    await this.overlayWritten;
    await this.reload();
  }

  private async writeOverlay(): Promise<void> {
    this.config ??= await this.readConfig(await providerCommand("omp"));
    const reserve = this.config["retry.usageReservePct"]?.value;
    await writeJsonAtomic(
      overlayPath(),
      buildOverlay(await this.controls.read(), typeof reserve === "number" ? reserve : 10, !this.policiesLocked()),
    );
  }

  private readConfig(omp: Command): Promise<Record<string, { value?: unknown }>> {
    return runJson<Record<string, { value?: unknown }>>(omp, ["config", "list", "--json"]);
  }

  private policiesLocked(): boolean {
    const policies = this.config?.["auth.accountPolicies"]?.value;
    return Array.isArray(policies) && policies.length > 0;
  }

  startLogin(provider: string): OmpLoginView {
    // OAuth callbacks listen on fixed local ports, so only one sign-in runs at a time.
    for (const other of this.logins.values()) if (isOpen(other.step)) this.settle(other, "canceled", "A newer sign-in replaced this one.");
    for (const [id, login] of this.logins) {
      if (login.endedAt !== null && Date.now() - login.endedAt > FINISHED_LOGIN_TTL_MS) this.logins.delete(id);
    }
    const login: Login = {
      id: randomUUID(),
      provider,
      step: "starting",
      url: null,
      instructions: null,
      codePrompt: null,
      message: null,
      promptId: null,
      process: null,
      endedAt: null,
    };
    this.logins.set(login.id, login);
    void this.runLogin(login);
    return toLoginView(login);
  }

  submitCode(loginId: string, code: string): OmpLoginView {
    const login = this.logins.get(loginId);
    if (!login || !isOpen(login.step) || !login.process) throw new Error("This sign-in is no longer running. Start it again.");
    if (!login.promptId) throw new Error("OMP isn't waiting for a code for this sign-in.");
    login.process.send({ type: "extension_ui_response", id: login.promptId, value: code });
    login.promptId = null;
    login.codePrompt = null;
    login.step = "verifying";
    return toLoginView(login);
  }

  cancelLogin(loginId: string): OmpLoginView | null {
    const login = this.logins.get(loginId);
    if (!login) return null;
    if (isOpen(login.step)) this.settle(login, "canceled", "Sign-in was canceled.");
    return toLoginView(login);
  }

  async remove(provider: string, credentialId: number): Promise<void> {
    const rpc = new OmpProcess(await providerCommand("omp"));
    try {
      await rpc.request({ type: "logout", providerId: provider, credentialId });
    } finally {
      rpc.close();
    }
    await this.reload();
  }

  async redeem(provider: string, credentialId: number): Promise<{ ok: boolean; message: string }> {
    const omp = await providerCommand("omp");
    const result = await run(omp.command, [...omp.prefix, "usage", "reset", `${provider}/${credentialId}`], {
      timeoutMs: 120_000,
      cwd: tmpdir(),
    });
    const lines = stripAnsi(result.code === 0 ? result.stdout : result.stderr || result.stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    await this.reload(true);
    return { ok: result.code === 0, message: lines.at(-1) ?? (result.code === 0 ? "Reset used." : "OMP could not use the reset.") };
  }

  stop(): void {
    for (const login of this.logins.values()) if (isOpen(login.step)) this.settle(login, "canceled", null);
  }

  /** Paseo ships its OMP provider turned off; ZeroSub shows and changes OMP only while it is on. */
  async isEnabled(paseo: PaseoApi): Promise<boolean> {
    if (this.enabled && Date.now() - this.enabled.at < ENABLED_CACHE_MS) return this.enabled.value;
    let value = false;
    try {
      const { config } = await paseo.config.get();
      const providers = config.providers as Record<string, { enabled?: unknown } | undefined> | undefined;
      value = providers?.omp?.enabled === true;
    } catch (error) {
      console.warn("[ZeroSub] could not read whether the OMP provider is on; treating it as off", describe(error));
    }
    this.enabled = { at: Date.now(), value };
    return value;
  }

  async assertEnabled(paseo: PaseoApi): Promise<void> {
    this.enabled = null;
    if (!(await this.isEnabled(paseo))) throw new Error("The OMP agent provider is turned off in Paseo, so ZeroSub leaves OMP alone.");
  }

  private async isInstalled(): Promise<boolean> {
    if (this.installed && (this.installed.ok || Date.now() - this.installed.at < NOT_INSTALLED_RECHECK_MS)) {
      return this.installed.ok;
    }
    const omp = await providerCommand("omp");
    const result = await run(omp.command, [...omp.prefix, "--version"], { timeoutMs: 15_000 });
    this.installed = { at: Date.now(), ok: result.code === 0 };
    return this.installed.ok;
  }

  private load(invalidate: boolean): Promise<void> {
    this.loading ??= this.fetch(invalidate).finally(() => {
      this.loading = null;
      this.loadedAt = Date.now();
    });
    return this.loading;
  }

  /** Loads again after a change, even if a load that started before it is still running. */
  private async reload(invalidate = false): Promise<void> {
    await this.loading?.catch(() => undefined);
    await this.load(invalidate);
  }

  private async fetch(invalidate: boolean): Promise<void> {
    try {
      const omp = await providerCommand("omp");
      // Asks the providers again instead of answering from OMP's usage cache.
      if (invalidate) await run(omp.command, [...omp.prefix, "usage", "invalidate"], { timeoutMs: 30_000, cwd: tmpdir() });
      const usageErrors: string[] = [];
      const [listing, usage, resets, history, config] = await Promise.all([
        listAccounts(omp),
        runJson<{ reports?: UsageReport[] }>(omp, ["usage", "--json"]).catch((error: unknown) => {
          usageErrors.push(`Usage: ${describe(error)}`);
          return { reports: [] };
        }),
        runJson<{ accounts?: ResetAccount[] }>(omp, ["usage", "reset", "--json"]).catch((error: unknown) => {
          usageErrors.push(`Resets: ${describe(error)}`);
          return { accounts: [] };
        }),
        // Local only (OMP's own records), so it is cheap; it stands in for missing live readings.
        runJson<{ entries?: HistoryEntry[] }>(omp, ["usage", "--history", "--json", "--days", "1"]).catch(() => ({ entries: [] })),
        this.readConfig(omp).catch(() => this.config ?? {}),
      ]);
      this.config = config;
      this.identities = new Map(
        (resets.accounts ?? []).flatMap((reset) => {
          const key = accountKey(reset);
          return key ? [[`${reset.provider}/${reset.credentialId}`, key] as const] : [];
        }),
      );
      // OMP's own settings may have changed, and the preview below reads the overlay.
      this.overlayWritten = this.writeOverlay();
      await this.overlayWritten;
      const accounts = joinAccounts(listing.accounts, usage.reports ?? [], resets.accounts ?? [], history.entries ?? [], await this.controls.read());
      const crowded = [...new Set(accounts.map((account) => account.provider))].filter(
        (provider) => accounts.filter((account) => account.provider === provider).length > 1,
      );
      const preview = (await Promise.all(crowded.map((provider) => previewBalance(omp, provider)))).filter(
        (entry): entry is Preview => entry !== null,
      );
      const defaults: OmpView["defaults"] = {};
      for (const key of DEFAULT_KEYS) {
        const value = config[key]?.value;
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") defaults[key] = value;
      }
      const providerIds = [...new Set([...SIGN_IN_PROVIDERS, ...listing.accounts.map((account) => account.provider)])];
      this.snapshot = {
        providers: providerIds.map((id) => ({ id, name: listing.names.get(id) ?? id })),
        accounts,
        fetchedAt: new Date().toISOString(),
        error: usageErrors.length > 0 ? usageErrors.join(" · ") : null,
        defaults,
        policiesLocked: this.policiesLocked(),
        preview,
      };
    } catch (error) {
      this.snapshot = {
        providers: this.snapshot?.providers ?? [],
        accounts: this.snapshot?.accounts ?? [],
        fetchedAt: this.snapshot?.fetchedAt ?? null,
        error: `Could not read OMP's accounts: ${describe(error)}`,
        defaults: this.snapshot?.defaults ?? {},
        policiesLocked: this.snapshot?.policiesLocked ?? false,
        preview: this.snapshot?.preview ?? [],
      };
    }
  }

  private async runLogin(login: Login): Promise<void> {
    try {
      const process = new OmpProcess(await providerCommand("omp"), (frame) => {
        if (!isOpen(login.step)) return;
        if (frame.method === "open_url") {
          login.url = frame.url ?? null;
          login.instructions = frame.instructions ?? null;
          login.step = "waiting";
        } else if (frame.method === "input" && frame.id) {
          // Asked again after a paste: OMP didn't accept what was pasted.
          if (login.step === "verifying") login.message = "OMP didn't accept that. Paste the code or the full redirect URL again.";
          login.promptId = frame.id;
          login.codePrompt = frame.title ?? "Paste the authorization code";
          login.step = "waiting";
        } else if (frame.method === "notify" && frame.message) {
          login.message = frame.message;
        }
      });
      if (!isOpen(login.step)) {
        process.close();
        return;
      }
      login.process = process;
      await process.request({ type: "login", providerId: login.provider }, LOGIN_TIMEOUT_MS);
      if (!isOpen(login.step)) return;
      login.step = "verifying";
      login.codePrompt = null;
      await this.reload();
      this.settle(login, "done", null);
    } catch (error) {
      if (isOpen(login.step)) this.settle(login, "failed", describe(error));
    }
  }

  private settle(login: Login, step: LoginStep, message: string | null): void {
    login.step = step;
    login.message = message;
    login.codePrompt = null;
    login.promptId = null;
    login.endedAt = Date.now();
    login.process?.close();
    login.process = null;
  }
}

function toLoginView(login: Login): OmpLoginView {
  return {
    id: login.id,
    provider: login.provider,
    step: login.step,
    url: login.url,
    instructions: login.instructions,
    codePrompt: login.codePrompt,
    message: login.message,
  };
}
