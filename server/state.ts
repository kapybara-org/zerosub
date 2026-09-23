import { copyFile } from "node:fs/promises";
import { z } from "zod";
import { AccountKindSchema, FamilySchema, type Family } from "../shared/model";
import { Mutex, readJson, writeJsonAtomic } from "./json-file";
import { statePath } from "./paths";

export const StoredAccountSchema = z.object({
  id: z.string(),
  family: FamilySchema,
  label: z.string(),
  /** The label was generated from the email and may be replaced when the identity is learned. */
  autoLabel: z.boolean().default(true),
  kind: AccountKindSchema,
  /** Credential home (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`). `null` for the CLI's own login. */
  home: z.string().nullable(),
  email: z.string().nullable().default(null),
  plan: z.string().nullable().default(null),
  organization: z.string().nullable().default(null),
  /** Stable identity used to spot the same account being added twice. */
  identity: z.string().nullable().default(null),
  signedIn: z.boolean().default(true),
  limitedUntil: z.string().nullable().default(null),
  /** What kind of limit `limitedUntil` records; only `window` limits clear from usage readings. */
  limitKind: z.enum(["window", "budget"]).nullable().default(null),
  /** When the current limit was recorded. */
  limitedAt: z.string().nullable().default(null),
  createdAt: z.string(),
});
export type StoredAccount = z.infer<typeof StoredAccountSchema>;

export const BindingSchema = z.object({
  accountId: z.string(),
  /**
   * `user`: chosen in the UI. `auto`: moved after a limit. `balance`: spread at creation.
   * `thread`: a conversation that can't change accounts, pinned where it started.
   */
  source: z.enum(["user", "auto", "balance", "thread"]),
  at: z.string(),
});
export type Binding = z.infer<typeof BindingSchema>;

export const LiveSessionSchema = z.object({
  accountId: z.string(),
  family: FamilySchema,
  openedAt: z.string(),
});
export type LiveSession = z.infer<typeof LiveSessionSchema>;

export const StoredStateSchema = z.object({
  version: z.literal(1).default(1),
  accounts: z.array(StoredAccountSchema).default([]),
  defaults: z
    .object({ claude: z.string().nullable().default(null), codex: z.string().nullable().default(null) })
    .default({ claude: null, codex: null }),
  /** Per-agent overrides of the default account. */
  bindings: z.record(z.string(), BindingSchema).default({}),
  /** Which account each agent's live provider session was opened with. */
  sessions: z.record(z.string(), LiveSessionSchema).default({}),
});
export type StoredState = z.infer<typeof StoredStateSchema>;

export const MAIN_ACCOUNT_ID: Record<Family, string> = { claude: "claude-main", codex: "codex-main" };

export function emptyState(): StoredState {
  return StoredStateSchema.parse({});
}

/**
 * Keeps every entry that still validates, so one bad record (say, after a downgrade) can't wipe
 * the accounts and every Codex thread's pin. Reports whether anything had to be dropped.
 */
export function salvageState(raw: unknown): { state: StoredState; dropped: boolean } {
  const whole = StoredStateSchema.safeParse(raw);
  if (whole.success) return { state: whole.data, dropped: false };
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  let dropped = false;
  const keep = <T>(schema: z.ZodType<T>, value: unknown): T | undefined => {
    const parsed = schema.safeParse(value);
    if (!parsed.success) dropped = true;
    return parsed.success ? parsed.data : undefined;
  };
  const accounts = (Array.isArray(source.accounts) ? source.accounts : [])
    .map((entry) => keep(StoredAccountSchema, entry))
    .filter((entry): entry is StoredAccount => entry !== undefined);
  const records = <T>(schema: z.ZodType<T>, value: unknown): Record<string, T> => {
    const result: Record<string, T> = {};
    if (!value || typeof value !== "object") return result;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const parsed = keep(schema, entry);
      if (parsed !== undefined) result[key] = parsed;
    }
    return result;
  };
  const defaults = keep(StoredStateSchema.shape.defaults, source.defaults) ?? { claude: null, codex: null };
  return {
    state: {
      version: 1,
      accounts,
      defaults,
      bindings: records(BindingSchema, source.bindings),
      sessions: records(LiveSessionSchema, source.sessions),
    },
    dropped: true,
  };
}

/** The registry: small, read on every session open, written atomically. */
export class StateStore {
  private cached: StoredState | null = null;
  private readonly mutex = new Mutex();

  constructor(private readonly path: string = statePath()) {}

  async read(): Promise<StoredState> {
    if (this.cached) return this.cached;
    return this.mutex.run(async () => {
      if (!this.cached) this.cached = await this.load();
      return this.cached;
    });
  }

  /** Applies `change` to a copy and persists it. Returns the new state. */
  update(change: (draft: StoredState) => void): Promise<StoredState> {
    return this.mutex.run(async () => {
      const current = this.cached ?? (await this.load());
      const draft = structuredClone(current);
      change(draft);
      const next = StoredStateSchema.parse(draft);
      await writeJsonAtomic(this.path, next);
      this.cached = next;
      return next;
    });
  }

  /** Throws on a transient read error so nothing overwrites a file that couldn't be read. */
  private async load(): Promise<StoredState> {
    let raw: unknown;
    try {
      raw = await readJson(this.path);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      await this.backup("unparseable");
      return emptyState();
    }
    if (raw === undefined) return emptyState();
    const { state, dropped } = salvageState(raw);
    if (dropped) await this.backup("partly invalid");
    return state;
  }

  private async backup(why: string): Promise<void> {
    const copy = `${this.path}.bad-${Date.now()}`;
    await copyFile(this.path, copy).catch(() => undefined);
    console.error(`[ZeroSub] state file was ${why}; kept a copy at ${copy} and continued with what was readable`);
  }
}

export function findAccount(state: StoredState, accountId: string | null | undefined): StoredAccount | undefined {
  return accountId ? state.accounts.find((account) => account.id === accountId) : undefined;
}

export function accountsOf(state: StoredState, family: Family): StoredAccount[] {
  return state.accounts.filter((account) => account.family === family);
}

/** The explicit default, else the CLI's own login, else the first account. */
export function defaultAccount(state: StoredState, family: Family): StoredAccount | undefined {
  const chosen = findAccount(state, state.defaults[family]);
  if (chosen && chosen.family === family) return chosen;
  const accounts = accountsOf(state, family);
  return accounts.find((account) => account.kind === "main") ?? accounts[0];
}

/** The CLI's own login for a family, if registered. */
export function mainAccount(state: StoredState, family: Family): StoredAccount | undefined {
  return findAccount(state, MAIN_ACCOUNT_ID[family]);
}
