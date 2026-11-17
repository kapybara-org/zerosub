import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ApiMonthSchema, ApiPriceSchema, TokenCountSchema, usageMonth, type ApiMonth, type ApiPrice, type TokenCount } from "../shared/model";
import { Mutex, readJson, writeJsonAtomic } from "./json-file";
import { dataDir } from "./paths";

/**
 * Monthly token totals of the paid API accounts (Azure OpenAI under ChatGPT), counted per turn from
 * the CLI's own session files, in `$PASEO_HOME/zerosub/api-usage.json`. No keys, no text.
 */

/** What one Codex thread had used by the last time its tokens were counted (see `countThread`). */
const ThreadMarkSchema = TokenCountSchema.extend({ at: z.string() });

export interface ApiUsageFile {
  accounts: Record<string, ApiMonth>;
  threads: Record<string, TokenCount & { at: string }>;
}

/** A thread not counted for this long is forgotten (its next turn counts from what it had then). */
const MARK_KEEP_MS = 62 * 24 * 60 * 60_000;

export const EMPTY_COUNT: TokenCount = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };

/** A price table as read back from a file: entries that don't parse, or have no model name, are left out. */
export function cleanPrices(value: unknown): Record<string, ApiPrice> {
  const prices: Record<string, ApiPrice> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return prices;
  for (const [model, entry] of Object.entries(value)) {
    const parsed = ApiPriceSchema.safeParse(entry);
    if (model.trim() && parsed.success) prices[model.trim()] = parsed.data;
  }
  return prices;
}

function emptyMonth(now: number): ApiMonth {
  return { month: usageMonth(now), models: {}, uncounted: 0, updatedAt: null };
}

/** Adds `delta` tokens of `model` to the account's month, starting a new month (UTC) when it has turned. */
export function addApiTokens(month: ApiMonth | undefined, model: string, delta: TokenCount, now: number): ApiMonth {
  const current = month && month.month === usageMonth(now) ? structuredClone(month) : emptyMonth(now);
  const entry = current.models[model] ?? EMPTY_COUNT;
  current.models[model] = {
    input: entry.input + delta.input,
    cachedInput: entry.cachedInput + delta.cachedInput,
    cacheWrite: entry.cacheWrite + delta.cacheWrite,
    output: entry.output + delta.output,
  };
  current.updatedAt = new Date(now).toISOString();
  return current;
}

/** Notes a turn whose tokens couldn't be read, in the account's month. */
export function addUncounted(month: ApiMonth | undefined, now: number): ApiMonth {
  const current = month && month.month === usageMonth(now) ? structuredClone(month) : emptyMonth(now);
  current.uncounted += 1;
  current.updatedAt = new Date(now).toISOString();
  return current;
}

/** The month as it shows now: an earlier month's totals don't count any more. */
export function currentMonth(month: ApiMonth | undefined, now: number): ApiMonth | null {
  return month && month.month === usageMonth(now) ? month : null;
}

/** How much more a thread used since `previous`; all of `total` when it's new or its count went back. */
export function tokenDelta(previous: TokenCount | undefined, total: TokenCount): TokenCount {
  if (!previous || total.input < previous.input || total.output < previous.output) return { ...total };
  return {
    input: total.input - previous.input,
    cachedInput: Math.max(0, total.cachedInput - previous.cachedInput),
    cacheWrite: Math.max(0, total.cacheWrite - previous.cacheWrite),
    output: total.output - previous.output,
  };
}

function usagePath(): string {
  return join(dataDir(), "api-usage.json");
}

export class ApiUsageStore {
  private cached: ApiUsageFile | null = null;
  private readonly mutex = new Mutex();

  constructor(private readonly path: string = usagePath()) {}

  async read(): Promise<ApiUsageFile> {
    if (this.cached) return this.cached;
    const raw = (await readJson(this.path).catch(() => undefined)) as Partial<ApiUsageFile> | undefined;
    const file: ApiUsageFile = { accounts: {}, threads: {} };
    for (const [id, value] of Object.entries(raw?.accounts ?? {})) {
      const parsed = ApiMonthSchema.safeParse(value);
      if (parsed.success) file.accounts[id] = parsed.data;
    }
    for (const [id, value] of Object.entries(raw?.threads ?? {})) {
      const parsed = ThreadMarkSchema.safeParse(value);
      if (parsed.success) file.threads[id] = parsed.data;
    }
    this.cached ??= file;
    return this.cached;
  }

  update(change: (draft: ApiUsageFile) => void): Promise<ApiUsageFile> {
    return this.mutex.run(async () => {
      const draft = structuredClone(await this.read());
      change(draft);
      const now = Date.now();
      for (const [id, mark] of Object.entries(draft.threads)) if (now - Date.parse(mark.at) > MARK_KEEP_MS) delete draft.threads[id];
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      await writeJsonAtomic(this.path, draft, { durable: false });
      this.cached = draft;
      return draft;
    });
  }

  /**
   * Counts what a Codex thread used since it was last counted, against `accountId`'s month. Each thread
   * runs on one account (Codex threads can't change accounts), so its whole growth is that account's.
   */
  async countThread(accountId: string, threadId: string, reading: { model: string | null; total: TokenCount }, fallbackModel: string, now = Date.now()): Promise<TokenCount> {
    let delta: TokenCount = EMPTY_COUNT;
    await this.update((draft) => {
      delta = tokenDelta(draft.threads[threadId], reading.total);
      draft.threads[threadId] = { ...reading.total, at: new Date(now).toISOString() };
      if (delta.input + delta.output > 0) draft.accounts[accountId] = addApiTokens(draft.accounts[accountId], reading.model ?? fallbackModel, delta, now);
    });
    return delta;
  }

  async noteUncounted(accountId: string, now = Date.now()): Promise<void> {
    await this.update((draft) => {
      draft.accounts[accountId] = addUncounted(draft.accounts[accountId], now);
    });
  }

  async forget(accountId: string): Promise<void> {
    if (!(await this.read()).accounts[accountId]) return;
    await this.update((draft) => {
      delete draft.accounts[accountId];
    });
  }
}
