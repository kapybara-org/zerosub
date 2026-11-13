import { chmod, copyFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AccountKindSchema, FamilySchema, type Family } from "../shared/model";
import { Mutex, readJson, readText, writeJsonAtomic } from "./json-file";
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
  /** Set aside by the user for a while: stays signed in, but nothing is routed to it. */
  disabled: z.boolean().default(false),
  limitedUntil: z.string().nullable().default(null),
  /** What kind of limit `limitedUntil` records; only `window` limits clear from usage readings. */
  limitKind: z.enum(["window", "budget"]).nullable().default(null),
  /** When the current limit was recorded. */
  limitedAt: z.string().nullable().default(null),
  /**
   * What reported the current limit: a turn's limit notice, or a usage reading. Missing for limits
   * saved by earlier versions, which count as a turn's.
   */
  limitSource: z.enum(["turn", "reading"]).optional(),
  createdAt: z.string(),
});
export type StoredAccount = z.infer<typeof StoredAccountSchema>;

export const BindingSchema = z.object({
  accountId: z.string(),
  /**
   * `user`: chosen in the UI. `auto`: moved after a limit, or kept on its account when the default
   * changed. `balance`: spread at creation.
   * `thread`: a conversation that can't change accounts, pinned where it started.
   */
  source: z.enum(["user", "auto", "balance", "thread"]),
  at: z.string(),
  selectionReason: z.enum(["weekly_reset", "headroom"]).optional(),
});
export type Binding = z.infer<typeof BindingSchema>;

export const LiveSessionSchema = z.object({
  accountId: z.string(),
  family: FamilySchema,
  openedAt: z.string(),
});
export type LiveSession = z.infer<typeof LiveSessionSchema>;

const TimelineMarkSchema = z.object({ epoch: z.string(), seq: z.number().int().nonnegative() });
const ContinuationMemberSchema = z.object({
  accountId: z.string(),
  identity: z.string().nullable(),
  email: z.string().nullable(),
  /** Timeline ranges already known by this tab; no conversation text is stored here. */
  seen: z.record(z.string(), TimelineMarkSchema).default({}),
  /** Reserved/created without a handoff; not a source of task history yet. */
  unstarted: z.boolean().optional(),
});
export const ContinuationChainSchema = z.object({
  activeAgentId: z.string(),
  members: z.record(z.string(), ContinuationMemberSchema),
  /** A full fallback that replaces history from deleted/moved tabs. */
  baselineMessageId: z.string().optional(),
  /** Written before dispatch. An uncertain dispatch must never start a second turn. */
  pending: z.object({
    agentId: z.string(),
    messageId: z.string(),
    seen: z.record(z.string(), TimelineMarkSchema),
    stage: z.enum(["creating", "sending"]).default("sending"),
    replaceHistory: z.array(z.string()).optional(),
    /** The agent a new tab is created under. A retried creation must repeat its first request. */
    parent: z.string().optional(),
  }).optional(),
});
export type ContinuationChain = z.infer<typeof ContinuationChainSchema>;

/** A home to sign out and delete once nothing runs on it any more. */
export const CleanupSchema = z.object({
  family: FamilySchema,
  /** The account it was (or was going to be) the home of; its agents' sessions name this ID. */
  accountId: z.string(),
  /** `removed`: the user removed the account. `unfinished`: a new account whose sign-in hasn't been saved yet. */
  why: z.enum(["removed", "unfinished"]),
  at: z.string(),
});
export type Cleanup = z.infer<typeof CleanupSchema>;

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
  continuations: z.record(z.string(), ContinuationChainSchema).default({}),
  /**
   * Homes to clean up, by path. Only these are ever signed out or deleted: a home missing from
   * `accounts` may just be missing from a damaged or hand-edited registry.
   */
  cleanup: z.record(z.string(), CleanupSchema).default({}),
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
      continuations: records(ContinuationChainSchema, source.continuations),
      cleanup: records(CleanupSchema, source.cleanup),
    },
    dropped: true,
  };
}

/**
 * Which snapshots of the registry are kept: the last few writes, which a damaged registry is
 * restored from, then the last one of each recent hour and day, to undo a mistake noticed later.
 * Buckets are prefixes of the snapshot's name (`state-2026-10-28T09-15-02-123Z.json`).
 */
const SNAPSHOT_TIERS = [
  { count: 5, bucket: (name: string) => name },
  { count: 12, bucket: (name: string) => name.slice(0, "state-2026-10-28T09".length) },
  { count: 7, bucket: (name: string) => name.slice(0, "state-2026-10-28".length) },
];
const SNAPSHOT_NAME = /^state-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

function snapshotName(at: Date): string {
  return `state-${at.toISOString().replace(/[:.]/g, "-")}.json`;
}

/** The snapshots rotation keeps, out of `names`; at most the sum of the tiers' counts. */
export function snapshotsToKeep(names: readonly string[]): Set<string> {
  const newestFirst = [...names].sort().reverse();
  const keep = new Set<string>();
  for (const { count, bucket } of SNAPSHOT_TIERS) {
    const buckets = new Set<string>();
    for (const name of newestFirst) {
      const key = bucket(name);
      if (buckets.has(key)) continue;
      if (buckets.size === count) break;
      buckets.add(key);
      keep.add(name);
    }
  }
  return keep;
}

/**
 * The registry: small, read on every session open, written atomically. Every write also leaves a
 * snapshot in `backups/` beside it, which a damaged or missing registry is restored from.
 */
export class StateStore {
  private cached: StoredState | null = null;
  private readonly mutex = new Mutex();
  private readonly backups: string;

  constructor(private readonly path: string = statePath()) {
    this.backups = join(dirname(path), "backups");
  }

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
      await this.write(next);
      this.cached = next;
      return next;
    });
  }

  private async write(state: StoredState): Promise<void> {
    await writeJsonAtomic(this.path, state);
    // The registry itself is saved; a snapshot that can't be written only costs a backup.
    await this.snapshot(state).catch((error: unknown) => console.error("[ZeroSub] could not back up the state file", message(error)));
  }

  private async snapshot(state: StoredState): Promise<void> {
    // Not synced: one lost to a crash doesn't parse and is skipped, and the registry itself is.
    await writeJsonAtomic(join(this.backups, snapshotName(new Date())), state, { durable: false });
    const names = await this.snapshotNames();
    const keep = snapshotsToKeep(names);
    for (const name of names) if (!keep.has(name)) await rm(join(this.backups, name), { force: true });
  }

  private async snapshotNames(): Promise<string[]> {
    return (await readdir(this.backups).catch(() => [] as string[])).filter((name) => SNAPSHOT_NAME.test(name));
  }

  /** The newest snapshot that parses, with its contents if they validate whole. */
  private async newestSnapshot(): Promise<{ path: string; raw: unknown; whole: StoredState | null } | null> {
    for (const name of (await this.snapshotNames()).sort().reverse()) {
      const path = join(this.backups, name);
      const raw = await readJson(path).catch(() => undefined);
      if (raw === undefined) continue;
      const whole = StoredStateSchema.safeParse(raw);
      return { path, raw, whole: whole.success ? whole.data : null };
    }
    return null;
  }

  /**
   * A registry that is missing, empty, not JSON, or has records that don't validate is replaced by
   * the newest snapshot, and a damaged file kept aside, rather than carrying on with fewer accounts
   * or none. Throws on a transient read error so nothing overwrites a file that couldn't be read.
   */
  private async load(): Promise<StoredState> {
    const text = await readText(this.path);
    let raw: unknown;
    if (text?.trim()) {
      try {
        raw = JSON.parse(text);
      } catch {
        // Recovered below.
      }
    }
    if (raw !== undefined) {
      const whole = StoredStateSchema.safeParse(raw);
      if (whole.success) return whole.data;
    }
    const snapshot = await this.newestSnapshot();
    if (text === undefined && !snapshot) return emptyState(); // A new install.
    const problem = text === undefined ? "missing" : !text.trim() ? "empty" : raw === undefined ? "not valid JSON" : "partly invalid";
    const kept = text === undefined ? null : await this.keepAside();
    let state: StoredState;
    let outcome: string;
    if (snapshot?.whole) {
      state = snapshot.whole;
      outcome = `restored it from ${snapshot.path}`;
    } else if (raw !== undefined) {
      // No snapshot yet, or the newest one doesn't validate either, so another version wrote them
      // (say, before a downgrade): the file is the newest record, and its valid entries are kept.
      state = salvageState(raw).state;
      outcome = "continued with the records that were still valid";
    } else if (snapshot) {
      state = salvageState(snapshot.raw).state;
      outcome = `continued with the records of ${snapshot.path} that were still valid`;
    } else {
      state = emptyState();
      outcome = "continued with an empty registry, as there is no backup";
    }
    console.error(`[ZeroSub] ${this.path} was ${problem}${kept ? `; kept it as ${kept}` : ""}; ${outcome}`);
    await this.write(state).catch((error: unknown) => console.error("[ZeroSub] could not save the recovered state file", message(error)));
    return state;
  }

  /** Copies a damaged registry aside before it's replaced, so a hand edit isn't lost. */
  private async keepAside(): Promise<string> {
    const copy = `${this.path}.bad-${Date.now()}`;
    await copyFile(this.path, copy);
    await chmod(copy, 0o600);
    return copy;
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
