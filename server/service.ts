import { createHash, randomBytes } from "node:crypto";
import { lstat, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  PluginHookContext,
  PluginLifecycleEvents,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import {
  FAMILIES,
  FAMILY_LABEL,
  OTHER_FAMILY,
  type AccountView,
  type ApiSummary,
  type AgentRoute,
  type Egress,
  type Family,
  type LoginMethod,
  type LoginView,
  type StateView,
  type Usage,
} from "../shared/model";
import { capsAccount, limitedPick } from "../shared/format";
import { DEFAULT_CONTINUE_PROMPT, type Preferences } from "../shared/preferences";
import type { RedeemResult, ReopenSummary } from "../shared/rpc";
import { SWITCH_ROW_KIND, SWITCH_ROW_VERSION, type SwitchRow } from "../shared/timeline";
import {
  applyEnv,
  type AgentTimelineItem,
  type FamilyAdapter,
  type Identity,
  type LimitHit,
  type LimitKind,
  type LoginHandle,
  type ProxyState,
  type RedeemReply,
  type UsageRead,
} from "./adapter";
import { FamilyResolver } from "./families";
import { sameAccountIdentity, withoutWorkspace } from "./account-identity";
import { CodexContinuations } from "./continuations";
import { CONTINUED_FROM_LABEL, continueInNewAgent, type Continuation } from "./handoff";
import { PI_ACCOUNT_FILE, crossesInheritedProxy, isAccountHome, moveHome, normalizeBaseUrl, plainHttp, readPiAccount, readPiAccountForAgents, removeHome } from "./homes";
import { launcherNames, piLauncherDir, writeLaunchers, type LauncherAccount } from "./launchers";
import { Mutex } from "./json-file";
import { turnRows } from "./limits";
import { canSignInWithBrowser } from "./machine";
import { equivalentMode } from "./modes";
import { homesDir, inHomesDir, isOwnHome, shownPath } from "./paths";
import { chooseImportedPiHome, choosePiHomesDir, piHomesDir, placeFor } from "./placement";
import { maskProxy, normalizeProxy } from "./proxy";
import { Reopener, hostCanReload } from "./reopen";
import { SwitchGuard } from "./switch-guard";
import { loadReadings, mergeUsage, pastReset, saveReadings, showLimit } from "./usage";
import { chooseAccount, isLimited, isUsable, mostAvailable, type RouteDecision, type RouteInput } from "./routing";
import {
  MAIN_ACCOUNT_ID,
  StateStore,
  accountsOf,
  defaultAccount,
  findAccount,
  mainAccount,
  type Binding,
  type Cleanup,
  type Move,
  type ContinuationChain,
  type LiveSession,
  type NextAgentPick,
  type StoredAccount,
  type StoredState,
} from "./state";

type PaseoApi = PluginHookContext["paseo"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

const PROVIDER_NAME: Record<Family, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi" };
/** How often to read usage: accounts in use, the defaults, and the rest. Adapters space reads further. */
const USAGE_BUSY_MS = 60_000;
const USAGE_DEFAULT_MS = 5 * 60_000;
const USAGE_IDLE_MS = 20 * 60_000;
/** Background reads renew an expired sign-in (slow) at most this often per account. Explicit refreshes (↻) aren't limited. */
const RENEW_LOGIN_MS = 30 * 60_000;
/** An account counts as in use for this long after one of its agents starts or ends a turn. */
const ACTIVE_WINDOW_MS = 15 * 60_000;
const UPKEEP_MS = 30_000;
const IDENTITY_MS = 30 * 60_000;
const AVAILABILITY_MS = 10 * 60_000;
/** Assumed length of a window limit whose reset time couldn't be read. */
const WINDOW_LIMIT_MS = 60 * 60_000;
/** Budget limits (spend caps, credits) don't show in usage; retry after this long. */
const BUDGET_LIMIT_MS = 3 * 60 * 60_000;
/** A fresh limit isn't second-guessed by usage readings for this long. */
const LIMIT_TRUST_MS = 15 * 60_000;
const LOGIN_TTL_MS = 15 * 60_000;
const LOGIN_GRACE_MS = 3_000;
const PRUNE_MS = 10 * 60_000;
/** Cleanup passes a home's sign-out (or sign-in check) may fail in before it's given up on. */
const CLEANUP_TRIES = 3;
/** After a reset, limit notices from turns that were already running are stale. */
const RESET_GRACE_MS = 5 * 60_000;
const AGENT_LIST_MS = 3_000;
/** How long a default change waits for sessions already being routed to record their account. */
const ROUTING_WAIT_MS = 5_000;
/** How long the end of a turn waits for Paseo to page the agent's timeline. The SDK itself waits 60 s. */
const TURN_READ_MS = 10_000;
/** An agent whose move to an account didn't land isn't moved there again for this long. */
const ALIGN_RETRY_MS = 30 * 60_000;
/**
 * Just after a turn starts or ends, or the user sends a message, alignment leaves the agent alone:
 * failover and waiting switches own it, and a reload would cancel a turn that is about to start.
 */
const TURN_SETTLE_MS = 60_000;
/**
 * How long an RPC that moves agents or spends a reset waits for that before answering, since Paseo
 * gives up on an RPC after 30 s. The work carries on, and timeline notes and the state say how it went.
 */
const REPLY_WAIT_MS = 20_000;
/** How long a usage refresh asked for by hand waits for readings; renewing a sign-in can take a minute. */
const USAGE_REPLY_MS = 15_000;
/**
 * How often to check the address each added Pi account's requests come from, besides once the
 * daemon starts and when its proxy changes. Each check is a request Anthropic's edge sees without a key.
 */
const EGRESS_MS = 30 * 60_000;
/** A home an agent was routed to this recently isn't moved yet: its session may only now be starting. */
const ROUTED_SETTLE_MS = 30_000;

const DEFAULT_PREFERENCES: Preferences = {
  autoSwitch: true,
  autoContinue: true,
  continuePrompt: DEFAULT_CONTINUE_PROMPT,
  moveAgentsOnDefaultChange: true,
  balanceNewAgents: false,
  showComposerPill: true,
  autoRedeem: false,
  useCredits: false,
  forkOtherProvider: false,
};

interface LoginSession {
  id: string;
  family: Family;
  /** Existing account being signed back in. */
  accountId: string | null;
  /** Where the CLI writes credentials; null for the CLI's own login. */
  home: string | null;
  handle: LoginHandle | null;
  view: LoginView;
  finishedAt: number | null;
  /** The account is being written to the registry: its home is in use for as long as that takes. */
  saving: boolean;
}

/** A move of an account's home under way; once `committed`, the account uses `to`. */
interface HomeMove {
  from: string;
  to: string;
  committed: boolean;
}

/** A move that gave way to something started on the home meanwhile (see `moveAccountHome`). */
class MoveGaveWay extends Error {}

interface AgentInfo {
  id: string;
  provider: string;
  status: string;
  archived: boolean;
  /** The conversation has started (so a Codex thread already holds account-bound reasoning). */
  hasHistory: boolean;
  title: string | null;
  /** The agent this one carries on from, when ZeroSub started it as a continuation. */
  continuedFrom: string | null;
  /** When the user last sent it a message (ms), or 0. */
  lastMessageAt: number;
  /** Shells and monitors it left running after its turn (Paseo 0.16+; 0 before). A reload cancels them. */
  backgroundWork: number;
}

/** `unchecked`: Paseo couldn't say how the agent was doing, so it wasn't reloaded at all. */
type ReopenResult =
  | { outcome: "reopened" | "deferred" | "closed" }
  | { outcome: "failed"; error: string; timedOut: boolean; unchecked?: boolean };
/**
 * A move left for the end of the agent's turn: its timeline note, and whether nobody asked for it
 * (alignment), so it also waits for background work when it's finished (see `reopenAgent`).
 */
interface Deferred {
  row: SwitchRow | null;
  unattended: boolean;
}
/** A reload under way: sessions opened since it started, and what the first one recorded in place of what. */
interface Reload {
  opens: number;
  opened?: { replaced: LiveSession | undefined; wrote: LiveSession };
}
/** What routing an interactive session recorded, taken back if the session opens without it (see `onSessionOpen`). */
interface Opening {
  startedAt: number;
  session?: LiveSession;
  /** A Codex thread's pin it wrote, and the one that pin replaced. */
  pin?: { wrote: Binding; replaced: Binding | undefined };
}
type Problem = { kind: "limit"; hit: LimitHit } | { kind: "signed_out" };

/**
 * Whether the agent has a session open. One whose last turn failed ("error": an API key out of
 * credit, say) still does, and its next message goes to that session as it is, so it's moved like an
 * idle one: by a reload.
 */
function isLive(status: string): boolean {
  return status === "idle" || status === "error" || status === "running" || status === "initializing";
}

/** Open and between turns: idle, or stopped by a failed turn. */
function settled(status: string): boolean {
  return status === "idle" || status === "error";
}

function emptySummary(): ReopenSummary {
  return { reopened: [], deferred: [], failed: [], pending: [], continuedIn: null };
}

/** In a turn (or starting one), which a reload would cancel. Every move waits for it. */
function busy(agent: AgentInfo): boolean {
  return agent.status === "running" || agent.status === "initializing";
}

/**
 * Between turns with background work still running (Paseo 0.16+: shells or monitors left after a
 * turn), which a reload would also cancel. Only moves nobody asked for wait for it: a dev server can
 * run for hours, so failover at a limit and switches the user makes go ahead.
 */
function hasBackgroundWork(agent: AgentInfo): boolean {
  return agent.backgroundWork > 0;
}

function sameBinding(a: Binding | undefined, b: Binding | undefined): boolean {
  return a?.accountId === b?.accountId && a?.at === b?.at;
}

/** How long a "next new agent" pick waits to be used. */
const NEXT_PICK_MS = 10 * 60_000;

function nextPickUntil(state: StoredState, accountId: string, family: Family, now: number): string | null {
  const pick = state.nextAgent?.[family];
  return pick && pick.accountId === accountId && Date.parse(pick.until) > now ? pick.until : null;
}

function samePick(a: NextAgentPick | null | undefined, b: NextAgentPick | null | undefined): boolean {
  return a?.accountId === b?.accountId && a?.until === b?.until;
}

/** Forgets the "next new agent" pick of an account that can't take agents any more. */
function dropNextPick(state: StoredState, account: StoredAccount): void {
  if (state.nextAgent[account.family]?.accountId === account.id) state.nextAgent[account.family] = null;
}

/**
 * Whether a session may take the "next new agent" pick: one of the user's own agents, which always
 * open in a workspace. Paseo's helpers for branch names, commit messages and PR text open in none.
 * From Paseo 0.16 a helper hidden from tabs and lists says `background: true`, and older hosts don't
 * send `background` at all, so only `false` or no `background` lets a session take the pick.
 */
function takesNextPick(request: PluginSessionOpenRequest): boolean {
  const { background } = request as { background?: unknown };
  return request.purpose === "interactive" && Boolean(request.workspaceId) && (background === undefined || background === false);
}

export class Service {
  private readonly continuations: CodexContinuations;
  private paseo: PaseoApi | null = null;
  private prefs: Preferences = DEFAULT_PREFERENCES;
  private readonly usage = new Map<string, Usage>();
  private readonly usageAttemptAt = new Map<string, number>();
  private readonly usageInFlight = new Map<string, Promise<void>>();
  private readonly identityCheckedAt = new Map<string, number>();
  private readonly availability = new Map<Family, { ok: boolean; detail: string | null; at: number }>();
  private readonly logins = new Map<string, LoginSession>();
  private readonly loginLocks: Record<Family, Mutex> = { claude: new Mutex(), codex: new Mutex(), pi: new Mutex() };
  /** Homes of API accounts being set up, which cleanup must leave alone. */
  private readonly creatingHomes = new Set<string>();
  /**
   * Agents whose account changed mid-turn (or while starting); reopened when the turn ends, or by
   * alignment once they're idle without one.
   */
  private readonly deferred = new Map<string, Deferred>();
  /**
   * Agents being moved right now (failover, a switch, alignment), so nothing else moves them at the
   * same time. Each resolves when its move is done. See `claim` and `tryClaim`.
   */
  private readonly switching = new Map<string, Promise<void>>();
  /** When alignment last tried a reload of each agent that didn't land, to which account, and whether it said so. */
  private readonly alignedAt = new Map<string, { accountId: string; at: number; noted?: boolean }>();
  /** Agents whose last reload didn't work, and the account it was for; cleared when their session next opens. */
  private readonly failedMoves = new Map<string, string>();
  /** Reloads under way, by agent: sessions opened since, and what the first one recorded and replaced. */
  private readonly reloads = new Map<string, Reload>();
  /**
   * Agents whose live session opened without routing's answer (routing failed, or Paseo stopped
   * waiting for it), so on the CLI login. Cleared when routing next opens one. See `onSessionOpen`.
   */
  private readonly unrouted = new Set<string>();
  /** When each agent's last turn started or ended; see `noteTurn`. */
  private readonly turnAt = new Map<string, number>();
  private aligning = false;
  /**
   * Default changes pinning open agents right now. Until they're pinned, an agent that follows the
   * default looks due to move, so moves nobody asked for (alignment, waiting switches) hold off.
   */
  private pinning = 0;
  /** Where each added Pi account's requests were last seen coming from (see `checkEgress`). */
  private readonly egress = new Map<string, Egress>();
  private readonly egressCheckedAt = new Map<string, number>();
  /** A pass moving homes to where they're kept (see `placeHomes`); a call during one gets that one. */
  private placing: Promise<void> | null = null;
  /** The move of each account's home under way now (see `moveAccountHome`). */
  private readonly moving = new Map<string, HomeMove>();
  /** Each account's last finished move, for a session routed from a registry read before it. */
  private readonly moved = new Map<string, { from: string; to: string }>();
  /** ZeroSub's own calls running on each home (see `onAccount`), which a move of it gives way to. */
  private readonly homeCalls = new Map<string, number>();
  /** When routing last opened a session on each account. */
  private readonly routedAt = new Map<string, number>();
  /** Why each account whose home is due to move hasn't moved yet: what it waits for, or what went wrong. */
  private readonly moveNotes = new Map<string, { waiting: string | null; error: string | null }>();
  /** Each account's script, as the launchers were last written. */
  private launcherFiles: Map<string, string> | null = null;
  /** Interactive sessions being routed right now, and their agents. Where each opens isn't recorded yet. */
  private readonly routing = new Map<Promise<unknown>, string>();
  /** One failover at a time per exhausted account. */
  private readonly failoverLocks = new Map<string, Mutex>();
  private readonly switchGuard = new SwitchGuard();
  /** When ZeroSub last told an agent's timeline why it didn't switch, by agent and notice, so it says so once. */
  private readonly guardNoticeAt = new Map<string, number>();
  /** When each account's agents last started or ended a turn, to read busy accounts often. */
  private readonly activeAt = new Map<string, number>();
  /** The provider asked us not to read this account's usage again before then. */
  private readonly usageRetryAt = new Map<string, number>();
  /** When a usage read last asked each account's CLI to renew its sign-in. */
  private readonly renewAttemptAt = new Map<string, number>();
  /** Accounts whose last usage read was live, rather than an error or the CLI's cached copy. */
  private readonly usageLive = new Set<string>();
  private usageSave: ReturnType<typeof setTimeout> | null = null;
  private readonly lastRedeemAt = new Map<string, number>();
  private readonly redeemLocks = new Map<string, Mutex>();
  /** Accounts a banked reset is being spent on right now. */
  private readonly redeeming = new Set<string>();
  private readonly browserSignIn = canSignInWithBrowser();
  private agentCache: { at: number; agents: Promise<AgentInfo[]> } | null = null;
  private lastPrune = 0;
  private cleaning: Promise<void> | null = null;
  /** Failed cleanup attempts this run, by home. */
  private readonly cleanupFailures = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  /** Startup's steps have all worked; until they have, each upkeep tries them again. See `startUp`. */
  private started = false;
  private starting: Promise<void> | null = null;
  /** When this run began: a session recorded before it may have ended while ZeroSub was off. */
  private readonly startedAt = Date.now();
  /** Whether records of sessions that ended while ZeroSub was off are forgotten yet (once a run). */
  private endedForgotten = false;

  constructor(
    private readonly adapters: Record<Family, FamilyAdapter>,
    private readonly store = new StateStore(),
    private readonly families = new FamilyResolver(),
    private readonly reopener = new Reopener(),
  ) {
    this.continuations = new CodexContinuations(store);
  }

  setPreferences(prefs: Preferences): void {
    const routingChanged = prefs.autoSwitch !== this.prefs.autoSwitch;
    this.prefs = prefs;
    // Whether limited accounts are skipped decides where agents belong: move them now, not at the next upkeep.
    if (routingChanged && this.paseo) void this.alignSessions(this.paseo).catch((error: unknown) => log("aligning agents failed", error));
  }

  /** Remember the plugin's SDK connection for background work (cleanup, failover). */
  attach(paseo: PaseoApi): void {
    this.paseo ??= paseo;
  }

  async start(): Promise<void> {
    // Upkeep runs even when a startup step fails (the registry can't be read or written for a
    // moment, say): it tries the step again until it works.
    this.timer = setInterval(() => void this.tick().catch((error: unknown) => log("upkeep failed", error)), UPKEEP_MS);
    this.timer.unref?.();
    await this.startUp();
    void this.tick().catch(() => undefined);
  }

  /** Shows the last readings and registers the CLIs' own logins, once it all works. */
  private startUp(): Promise<void> {
    if (this.started) return Promise.resolve();
    this.starting ??= (async () => {
      // The last readings show right away; fresh ones replace them as they arrive.
      for (const [accountId, reading] of await loadReadings()) if (!this.usage.has(accountId)) this.usage.set(accountId, reading);
      await Promise.all(FAMILIES.map((family) => this.ensureFamily(family)));
      this.started = true;
      await this.reportStrayHomes().catch(() => undefined);
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.usageSave) {
      clearTimeout(this.usageSave);
      await saveReadings(this.usage).catch(() => undefined);
    }
    for (const login of this.logins.values()) login.handle?.cancel();
  }

  // ------------------------------------------------------------------ upkeep

  /** Checks the CLI is installed and registers its own login as an account. */
  private async ensureFamily(family: Family): Promise<void> {
    const adapter = this.adapters[family];
    const availability = await adapter.available().catch((error: unknown) => ({ ok: false, detail: describe(error) }));
    this.availability.set(family, { ...availability, at: Date.now() });
    if (!availability.ok) return;
    const identity = await adapter.identity(null).catch(() => null);
    this.identityCheckedAt.set(MAIN_ACCOUNT_ID[family], Date.now());
    let handedOver = false;
    await this.store.update((draft) => {
      let main = findAccount(draft, MAIN_ACCOUNT_ID[family]);
      if (!main) {
        main = newAccount({ id: MAIN_ACCOUNT_ID[family], family, kind: "main", home: null });
        main.signedIn = false;
        // Kept until a sign-in names it: Pi's never does.
        main.label = `${FAMILY_LABEL[family]} (CLI login)`;
        draft.accounts.unshift(main);
      }
      if (identity) handedOver = applyIdentity(main, identity, draft);
      if (!main.label) main.label = `${FAMILY_LABEL[family]} (CLI login)`;
    });
    if (handedOver) this.forgetReading(MAIN_ACCOUNT_ID[family]);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    if (!this.started) await this.startUp().catch((error: unknown) => log("startup still didn't finish; trying again in 30 s", error));
    const now = Date.now();
    for (const family of FAMILIES) {
      const availability = this.availability.get(family);
      if (availability && !availability.ok && now - availability.at > AVAILABILITY_MS) {
        void this.ensureFamily(family).catch(() => undefined);
      }
    }
    const state = await this.store.read();
    for (const account of state.accounts) {
      const attempted = this.usageAttemptAt.get(account.id) ?? 0;
      const busy = now - (this.activeAt.get(account.id) ?? 0) < ACTIVE_WINDOW_MS;
      const isDefault = defaultAccount(state, account.family)?.id === account.id;
      const every = account.disabled ? USAGE_IDLE_MS : busy ? USAGE_BUSY_MS : isDefault ? USAGE_DEFAULT_MS : USAGE_IDLE_MS;
      if (account.signedIn && now - attempted > every) {
        void this.refreshUsage(account.id).catch((error: unknown) => log(`usage refresh for ${account.label} failed`, error));
      }
      if (now - (this.identityCheckedAt.get(account.id) ?? 0) > IDENTITY_MS) {
        void this.refreshIdentity(account.id).catch(() => undefined);
      }
      if (now - (this.egressCheckedAt.get(account.id) ?? 0) >= EGRESS_MS) void this.checkEgress(account);
    }
    for (const [id, login] of this.logins) {
      if (login.finishedAt && now - login.finishedAt > LOGIN_TTL_MS) this.logins.delete(id);
      else if (!login.finishedAt && now - Date.parse(login.view.startedAt) > LOGIN_TTL_MS) void this.cancelLogin(id);
    }
    // Keep added Pi homes in step with Pi's own directory (shared entries, sign-ins, settings) even
    // when they're only used from a terminal, which ZeroSub never sees start.
    for (const account of state.accounts) {
      if (account.family === "pi" && account.kind === "managed" && account.home && !this.moving.has(account.id)) {
        await this.adapters.pi
          .prepareHome(account.home, this.stillHas(account))
          .catch((error: unknown) => log(`could not refresh the home of ${account.label}`, error));
      }
    }
    await this.placeHomes().catch((error: unknown) => log("moving accounts' homes failed", error));
    await this.refreshLaunchers().catch((error: unknown) => log("could not write the Pi scripts", error));
    if (this.paseo) {
      await this.forgetEndedSessions(this.paseo).catch((error: unknown) => log("could not check which agents closed while ZeroSub was off", error));
      void this.alignSessions(this.paseo).catch((error: unknown) => log("aligning agents failed", error));
      await this.cleanUpHomes(this.paseo);
    }
  }

  private async refreshIdentity(accountId: string): Promise<void> {
    this.identityCheckedAt.set(accountId, Date.now());
    const account = findAccount(await this.store.read(), accountId);
    // A Pi API account's key is only known to work from a turn: a refused one is learned from a failed turn.
    if (!account || account.auth === "api") return;
    // A check that can't tell (Claude's keychain unreadable just now, say) changes nothing; the next one may.
    const identity = await this.adapters[account.family].identity(account.home).catch((error: unknown) => {
      log(`could not check whether ${account.label} is signed in`, error);
      return null;
    });
    if (!identity) return;
    let handedOver = false;
    await this.store.update((draft) => {
      const target = findAccount(draft, accountId);
      if (target) handedOver = applyIdentity(target, identity, draft);
    });
    if (handedOver) this.forgetReading(accountId);
  }

  /** The CLI login now belongs to someone else, so the last reading, its refresh timing and a reset just spent were the previous person's. */
  private forgetReading(accountId: string): void {
    console.log(`[ZeroSub] the CLI login for ${accountId} changed hands; dropping its old usage and limit`);
    this.setUsage(accountId, null);
    this.usageLive.delete(accountId);
    this.usageRetryAt.delete(accountId);
    this.usageAttemptAt.delete(accountId);
    this.lastRedeemAt.delete(accountId);
    void this.refreshUsage(accountId, true).catch(() => undefined);
  }

  /**
   * Forgets records from before this run of sessions that have ended since: an agent that closed
   * while ZeroSub was off sent no `agent.closed`, and opened again while ZeroSub is off it runs on
   * the CLI login. Once a run, when Paseo lists every agent. One that closed and opened again while
   * ZeroSub was off looks like one that stayed open, so its record stays until its session next opens.
   */
  private async forgetEndedSessions(paseo: PaseoApi): Promise<void> {
    if (this.endedForgotten) return;
    const { agents, complete } = await listAgents(paseo, true);
    if (!complete) return;
    const ended = new Set(agents.filter((agent) => agent.archived || agent.status === "closed").map((agent) => agent.id));
    // Every session routing opens this run is recorded afresh, so only older records can be stale.
    const stale = ([agentId, session]: [string, LiveSession]) => ended.has(agentId) && Date.parse(session.openedAt) < this.startedAt;
    if (Object.entries((await this.store.read()).sessions).some(stale)) {
      await this.store.update((draft) => {
        for (const entry of Object.entries(draft.sessions)) if (stale(entry)) delete draft.sessions[entry[0]];
      });
    }
    this.endedForgotten = true;
  }

  /** Forget bindings and sessions of agents that no longer exist (including Paseo's internal helpers). */
  private async prune(paseo: PaseoApi): Promise<void> {
    const now = Date.now();
    if (now - this.lastPrune < PRUNE_MS) return;
    this.lastPrune = now;
    const { agents, complete } = await listAgents(paseo, true);
    if (!complete) return; // Can't tell "gone" from "not listed".
    const known = new Set(agents.map((agent) => agent.id));
    const state = await this.store.read();
    const old = (at: string) => now - (Date.parse(at) || 0) > PRUNE_MS;
    // Paseo's list leaves out agents in background workspaces, which still run and open sessions, so
    // one missing from it is looked up: only one Paseo doesn't know, or one of its hidden helpers, is
    // gone. One it can't say about now stays for a later pass.
    const unlisted = new Set(
      [
        ...Object.entries(state.sessions).map(([id, session]) => [id, session.openedAt] as const),
        ...Object.entries(state.bindings).map(([id, binding]) => [id, binding.at] as const),
      ]
        .filter(([id, at]) => !known.has(id) && old(at))
        .map(([id]) => id),
    );
    const gone = new Set<string>();
    for (const id of unlisted) {
      const agent = await paseo.agents
        .ref(id)
        .refresh()
        .then((result) => result?.agent ?? null)
        // Paseo 0.9 and 0.10 answer an ID they don't know (their own helpers' included) with an error
        // rather than no agent. Any other error means no answer yet.
        .catch((error: unknown) => (/Agent not found/.test(describe(error)) ? null : undefined));
      if (agent === null || (agent && (agent as { internal?: boolean }).internal)) gone.add(id);
    }
    const staleSessions = Object.entries(state.sessions).filter(([id, session]) => gone.has(id) && old(session.openedAt));
    const staleBindings = Object.entries(state.bindings).filter(([id, binding]) => gone.has(id) && old(binding.at));
    const active = new Set(agents.filter((agent) => !agent.archived).map((agent) => agent.id));
    // A hand-off that may have sent its prompt stays on record while its tab could come back. A
    // failed creation sent nothing, so it doesn't keep the task's record alive.
    const unsettled = (pending: ContinuationChain["pending"]) => pending?.stage === "sending" && known.has(pending.agentId);
    const staleChains = Object.entries(state.continuations).filter(([, chain]) =>
      !unsettled(chain.pending) && Object.keys(chain.members).every((id) => !active.has(id) && !this.switching.has(id)),
    );
    if (staleSessions.length === 0 && staleBindings.length === 0 && staleChains.length === 0) return;
    await this.store.update((draft) => {
      for (const [id] of staleSessions) delete draft.sessions[id];
      for (const [id] of staleBindings) delete draft.bindings[id];
      for (const [id] of staleChains) delete draft.continuations[id];
    });
  }

  /**
   * Signs out and deletes the homes listed for cleanup (see `StoredState.cleanup`): a removed
   * account's, and a new account's whose sign-in never finished, once no live agent session runs on
   * it any more. A home that isn't listed is never touched, whatever the registry says about it: a
   * damaged or hand-edited registry may simply be missing its account. One pass at a time.
   */
  cleanUpHomes(paseo: PaseoApi): Promise<void> {
    this.cleaning ??= this.cleanUpPass(paseo).finally(() => {
      this.cleaning = null;
    });
    return this.cleaning;
  }

  private async cleanUpPass(paseo: PaseoApi): Promise<void> {
    const state = await this.store.read();
    const owned = new Set(state.accounts.map((account) => account.home));
    const busy = new Set<string>();
    for (const login of this.logins.values()) {
      const active = !login.finishedAt || login.saving || Date.now() - login.finishedAt < LOGIN_GRACE_MS;
      if (active && login.home) busy.add(login.home);
    }
    for (const home of this.creatingHomes) busy.add(home);
    for (const [home, entry] of Object.entries(state.cleanup)) {
      if (busy.has(home)) continue;
      if (!isAccountHome(home, entry.family)) {
        // Only a folder ZeroSub made in homes/ is ever signed out or deleted. An entry naming anything
        // else (a hand edit, say) could otherwise sign out the CLI's own login, keychain entry and all.
        await this.store.update((draft) => {
          delete draft.cleanup[home];
        });
        console.error(`[ZeroSub] left ${home} alone: it isn't an account home in ${homesDir()}`);
        continue;
      }
      if (owned.has(home)) {
        // An account uses it again (put back by hand, say), so it's never signed out from under it.
        await this.store.update((draft) => {
          if (draft.accounts.some((account) => account.home === home)) delete draft.cleanup[home];
        });
        continue;
      }
      await this.cleanUpHome(paseo, home, entry, state).catch((error: unknown) => log(`cleaning up ${home} failed`, error));
    }
  }

  private async cleanUpHome(paseo: PaseoApi, home: string, entry: Cleanup, state: StoredState): Promise<void> {
    const users = Object.entries(state.sessions)
      .filter(([, session]) => session.accountId === entry.accountId)
      .map(([agentId]) => agentId);
    for (const agentId of users) {
      const info = await agentInfo(paseo, agentId);
      if (info && !info.archived && info.status !== "closed") return; // Still in use: a later pass.
    }
    // A sign-in this run saw end without an account is its own to undo. One left by an earlier run
    // only goes if it isn't signed in: a registry restored from an older copy can still list a
    // sign-in that has since become an account the registry no longer knows.
    // A Pi account is saved, and its entry dropped, in one write (see `addApiAccount`): an entry left
    // means it never became an account, so its home goes, key and all.
    const earlier = entry.why === "unfinished" && entry.family !== "pi" && !this.endedHere(home);
    let deleteFolder = true;
    let outcome: string;
    try {
      if (earlier) {
        const signedIn = (await this.adapters[entry.family].identity(home)).signedIn;
        if (signedIn) deleteFolder = false;
        outcome = signedIn
          ? `left ${home} alone: no account uses it, but it's signed in, so it may be an account missing from the registry`
          : `deleted ${home}, left by a sign-in that never finished`;
      } else {
        await this.adapters[entry.family].logout(home);
        outcome = entry.why === "unfinished" && entry.family === "pi" ? `deleted ${home}, left by a Pi account that was never saved` : `signed out and deleted ${home}`;
      }
    } catch (error) {
      const failures = (this.cleanupFailures.get(home) ?? 0) + 1;
      this.cleanupFailures.set(home, failures);
      log(`cleaning up ${home} failed`, error);
      if (failures < CLEANUP_TRIES) return;
      // A removed account's home goes anyway, as before; one that may be a lost account stays.
      if (earlier) deleteFolder = false;
      outcome = earlier
        ? `gave up checking whether ${home} is signed in, and left it alone`
        : `gave up signing out ${home}, so its sign-in may still be valid; deleted it anyway`;
    }
    this.cleanupFailures.delete(home);
    if (deleteFolder) await removeHome(home);
    await this.store.update((draft) => {
      delete draft.cleanup[home];
      for (const agentId of users) if (draft.sessions[agentId]?.accountId === entry.accountId) delete draft.sessions[agentId];
    });
    console.log(`[ZeroSub] ${outcome}`);
  }

  /** Whether a sign-in into `home` ran in this process and has ended. */
  private endedHere(home: string): boolean {
    return [...this.logins.values()].some((login) => login.home === home && login.finishedAt !== null);
  }

  /**
   * Folders in `homesDir()` that no account uses and nothing will clean up: leftovers of an earlier
   * version, or homes of accounts a damaged registry lost. They are only ever reported.
   */
  async strayHomes(): Promise<string[]> {
    const state = await this.store.read();
    const known = new Set<string | null>([...state.accounts.map((account) => account.home), ...Object.keys(state.cleanup)]);
    const names = await readdir(homesDir()).catch(() => [] as string[]);
    return names.filter((name) => !name.startsWith(".") && !known.has(join(homesDir(), name)));
  }

  private async reportStrayHomes(): Promise<void> {
    const stray = await this.strayHomes();
    if (stray.length === 0) return;
    console.error(
      `[ZeroSub] no account uses ${stray.join(", ")} in ${homesDir()}, so ${stray.length === 1 ? "it is" : "they are"} left alone. ` +
        "If accounts are missing, restore state.json; otherwise sign them out and delete them yourself.",
    );
  }

  private scheduleCleanup(): void {
    const paseo = this.paseo;
    if (!paseo) return;
    setTimeout(
      () => void this.cleanUpHomes(paseo).catch((error: unknown) => log("cleanup failed", error)),
      LOGIN_GRACE_MS + 500,
    ).unref?.();
  }

  // ------------------------------------------------------------------ hooks

  /**
   * Routes every provider session (create, resume, refresh, import) to the agent's account. When
   * routing fails, or `abandoned` says Paseo stopped waiting for it, Paseo opens an interactive
   * session as it asked: on the CLI login. Then nothing routing recorded for it stands.
   */
  async onSessionOpen(
    request: PluginSessionOpenRequest,
    context: PluginHookContext,
    abandoned?: AbortSignal,
  ): Promise<PluginSessionOpenRequest | undefined> {
    if (request.purpose !== "interactive") return this.route(request, context);
    const { agentId } = request;
    const opening: Opening = { startedAt: Date.now() };
    const routed = this.route(request, context, opening, abandoned);
    this.routing.set(routed, agentId);
    // Noted before Paseo goes on to open the session, so a reload waiting for it knows (see `reopenAgent`).
    const giveUp = () => this.unrouted.add(agentId);
    abandoned?.addEventListener("abort", giveUp, { once: true });
    try {
      const result = await routed;
      if (!abandoned?.aborted) {
        if (result) {
          // A fresh session already runs on the routed account, so any pending switch is done.
          this.deferred.delete(agentId);
          this.failedMoves.delete(agentId);
          this.unrouted.delete(agentId);
        }
        return result;
      }
    } catch (error) {
      this.unrouted.add(agentId);
      await this.openedUnrouted(context.paseo, request, opening).catch((undo: unknown) => log(`could not undo routing ${agentId}`, undo));
      throw error;
    } finally {
      abandoned?.removeEventListener("abort", giveUp);
      this.routing.delete(routed);
    }
    await this.openedUnrouted(context.paseo, request, opening).catch((undo: unknown) => log(`could not undo routing ${agentId}`, undo));
    return undefined;
  }

  /**
   * A session routing didn't answer for runs on the CLI login. Forgets the account recorded for it
   * (by this routing, or for the session before when routing never got that far), so `runningOn`
   * reads the CLI login, unless a session opened since replaced the record. A Codex thread's new pin
   * goes too: the thread starts out where it runs. A Codex thread with no history yet (a new one, or
   * a ChatGPT hand-off pinned before it first opened) writes its history on the CLI login, which no
   * other account can read, so it's pinned there instead.
   */
  private async openedUnrouted(paseo: PaseoApi, request: PluginSessionOpenRequest, opening: Opening): Promise<void> {
    const { agentId } = request;
    const family = (await this.families.resolve(paseo))[request.provider];
    let startsHere: Family | null = null;
    if (family && !this.adapters[family].portable) {
      const info = request.reason === "create" ? null : await agentInfo(paseo, agentId);
      if (request.reason === "create" || (info && !info.hasHistory)) startsHere = family;
    }
    const ours = (session: LiveSession) => session.accountId === opening.session?.accountId && session.openedAt === opening.session.openedAt;
    await this.store.update((draft) => {
      const recorded = draft.sessions[agentId];
      if (recorded && (ours(recorded) || Date.parse(recorded.openedAt) < opening.startedAt)) delete draft.sessions[agentId];
      const { pin } = opening;
      if (pin && sameBinding(draft.bindings[agentId], pin.wrote)) {
        if (pin.replaced) draft.bindings[agentId] = pin.replaced;
        else delete draft.bindings[agentId];
      }
      const cliLogin = startsHere && !draft.sessions[agentId] ? mainAccount(draft, startsHere) : undefined;
      if (cliLogin) draft.bindings[agentId] = { accountId: cliLogin.id, source: "thread", at: new Date().toISOString() };
    });
  }

  private async route(
    request: PluginSessionOpenRequest,
    context: PluginHookContext,
    opening?: Opening,
    abandoned?: AbortSignal,
  ): Promise<PluginSessionOpenRequest | undefined> {
    this.attach(context.paseo);
    const family = (await this.families.resolve(context.paseo))[request.provider];
    if (!family) return undefined;
    const adapter = this.adapters[family];
    const now = Date.now();
    const interactive = request.purpose === "interactive";
    // The first session a reload of ours opens is the one it rolls back if the reload fails.
    const reload = interactive ? this.reloads.get(request.agentId) : undefined;
    if (reload) reload.opens += 1;
    const ownReload = reload?.opens === 1;
    const state = await this.store.read();
    const input: RouteInput = {
      agentId: request.agentId,
      family,
      reason: request.reason,
      now,
      autoSwitch: this.prefs.autoSwitch,
      balanceNewAgents: this.prefs.balanceNewAgents,
      portable: adapter.portable,
      usageOf: (id) => this.usage.get(id),
      // Alignment and the account button decide with the same stand-in rule, so a reopen lands where they expect.
      current: request.reason === "create" ? undefined : this.standingIn(state, request.agentId, family, request.reason === "refresh"),
      allowNextPick: takesNextPick(request),
    };
    const first = chooseAccount(state, input);
    if (!first) return undefined;
    let decision = first;
    const prepare = async (account: StoredAccount) => {
      // Taken before anything else waits, so a move of this home that hasn't finished gives way (see
      // `moveAccountHome`); one that has is followed. Routing itself never waits for a move.
      const home = this.homeNow(account);
      this.routedAt.set(account.id, Date.now());
      if (account.kind === "managed" && home && home === account.home && !this.moving.has(account.id)) {
        await adapter.prepareHome(home, this.stillHas(account)).catch((error: unknown) => log(`could not refresh the home of ${account.label}`, error));
      }
    };

    await prepare(first.account);
    const seenBinding = state.bindings[request.agentId]?.accountId;
    const bindingChanged = (bind: Binding | null) => bind !== null && seenBinding !== bind.accountId;
    // An interactive session is recorded even when it opens on the account the last one did: when it
    // opened tells it from a session that has ended since (see `onAgentClosed`, `forgetEndedSessions`).
    if (bindingChanged(first.bind) || interactive) {
      await this.store.update((draft) => {
        // The pick is claimed here, with the binding it brings, so only one session gets it: one that
        // finds it taken or changed since it decided decides again on what's there now.
        if (decision.nextPick && !samePick(draft.nextAgent[family], decision.nextPick)) {
          decision = chooseAccount(draft, input) ?? { ...first, nextPick: undefined };
        }
        if (decision.nextPick) draft.nextAgent[family] = null;
        const { bind } = decision;
        // Don't overwrite a choice the user made while this decision was being taken.
        if (bind && bindingChanged(bind) && draft.bindings[request.agentId]?.accountId === seenBinding) {
          if (opening && !adapter.portable) opening.pin = { wrote: bind, replaced: draft.bindings[request.agentId] };
          draft.bindings[request.agentId] = bind;
        }
        // Paseo has opened the session without waiting: `onSessionOpen` sorts out its record.
        if (!interactive || abandoned?.aborted) return;
        const session = { accountId: decision.account.id, family, openedAt: new Date(now).toISOString() };
        if (reload && ownReload) reload.opened = { replaced: draft.sessions[request.agentId], wrote: session };
        draft.sessions[request.agentId] = session;
        if (opening) opening.session = session;
      });
    }
    const { account } = decision;
    if (account.id !== first.account.id) await prepare(account);
    if (decision.nextPick && Date.parse(decision.nextPick.until) > now) {
      console.log(`[ZeroSub] next-agent pick ${decision.bind?.source === "user" ? "used" : "dropped, as its account can't take agents now"}: ${request.agentId}`);
    }
    this.activeAt.set(account.id, now);
    console.log(
      `[ZeroSub] ${request.provider} agent ${request.agentId} → ${account.label} (${request.reason}${
        decision.skipped ? `; skipped ${decision.skipped.account.label}: ${decision.skipped.why}` : ""
      })`,
    );
    const home = this.homeNow(account);
    const session = typeof request.cwd === "string" && request.cwd ? { cwd: request.cwd } : undefined;
    return { ...request, env: applyEnv(await adapter.env(home, session), request.env) };
  }

  /**
   * Notes a turn starting or ending on the agent, at a time no earlier event of the agent's shares, so
   * the time an event was noted at also tells whether another came after it (see `untouchedSince`).
   */
  private noteTurn(agentId: string): number {
    const at = Math.max(Date.now(), (this.turnAt.get(agentId) ?? 0) + 1);
    this.turnAt.set(agentId, at);
    return at;
  }

  /** A turn uses the account from its first token, so a long one keeps its usage fresh too. */
  async onTurnStarted(agent: { id: string; provider: string }, context: PluginHookContext): Promise<void> {
    this.noteTurn(agent.id);
    this.attach(context.paseo);
    const family = (await this.families.resolve(context.paseo))[agent.provider];
    if (!family) return;
    const accountId = this.runningOn(await this.store.read(), agent.id, family);
    if (accountId) this.activeAt.set(accountId, Date.now());
  }

  async onTurnEnded(event: TurnEnded, context: PluginHookContext): Promise<void> {
    const endedAt = this.noteTurn(event.agent.id);
    this.attach(context.paseo);
    const family = (await this.families.resolve(context.paseo))[event.agent.provider];
    if (!family) return;
    const adapter = this.adapters[family];
    const agentId = event.agent.id;
    // The account the turn ran on, read before anything that takes a while: the agent may be moved
    // meanwhile, and the limit is still this account's.
    const accountId = this.runningOn(await this.store.read(), agentId, family) ?? null;
    if (accountId) this.activeAt.set(accountId, Date.now());
    if (event.outcome.kind !== "canceled") {
      const turn = await this.turnWithTimeline(context.paseo, event);
      // A hand-off quotes the whole conversation, not just this turn. Paseo 0.13 sends none, so the hand-off pages it.
      const conversation = event.timeline.length > 0 ? event.timeline : undefined;
      const hit = adapter.detectLimit(turn);
      const problem: Problem | null = hit
        ? { kind: "limit", hit }
        : adapter.detectSignOut(turn) && (await this.confirmSignedOut(accountId))
          ? { kind: "signed_out" }
          : null;
      if (problem) {
        await this.handleUnavailable(context.paseo, agentId, family, conversation, problem, endedAt, accountId);
        // A move asked for during the turn still happens when failover didn't move the agent
        // itself (automatic switching off, say), and goes where it was asked to.
        if (this.deferred.has(agentId)) await this.finishDeferred(context.paseo, agentId, family);
        return;
      }
    }
    if (this.deferred.has(agentId)) await this.finishDeferred(context.paseo, agentId, family);
    // The turn just used the account: read its usage again as soon as the provider allows.
    if (accountId) void this.refreshUsage(accountId).catch(() => undefined);
  }

  /**
   * Paseo 0.13 (getpaseo/paseo#7477) stopped copying the conversation into turn-ended hooks: `timeline`
   * is always `[]`. Claude reports its limits as an ordinary reply, so when the hook arrives empty the
   * tail of the agent's timeline is paged here and read as the turn. A hook that still sends the
   * conversation (Paseo 0.12 and older) is used as is. A turn that never started (`turnId === null`)
   * has nothing to read, as `notices()` in limits.ts ignores its timeline anyway, and a hook without
   * a turn id gives nothing to tell its rows by. If the page can't be read within
   * `TURN_READ_MS` the event stands: its failure is still read, and a switch waiting for the turn to
   * end isn't held up.
   *
   * The page can reach back into earlier turns, and a later turn may have started by the time it's
   * read, so only this turn's rows count (`turnRows()` in limits.ts): a turn Claude starts by itself
   * has no message to stop at, and must not find the last turn's limit again. Paseo's
   * `[System Error]` row carries no turn id, but it repeats the failure the hook still sends.
   */
  private async turnWithTimeline(paseo: PaseoApi, event: TurnEnded): Promise<TurnEnded> {
    const { turnId } = event;
    if (!turnId || event.timeline.length > 0) return event;
    try {
      const page = await deadline(
        paseo.agents.ref(event.agent.id).timeline.refetch({ direction: "tail", limit: 40 }),
        TURN_READ_MS,
        "Paseo didn't send the agent's timeline in time",
      );
      return { ...event, timeline: turnRows(page.entries, turnId) };
    } catch (error) {
      log(`could not read the last turn of ${event.agent.id}`, error);
      return event;
    }
  }

  /**
   * A closed agent runs nowhere until a session opens again: through routing, which records it, or
   * while ZeroSub is off, on the CLI login, which no record stands for. So its record goes, unless a
   * session opened since the close.
   */
  async onAgentClosed(agentId: string): Promise<void> {
    const closedAt = Date.now();
    this.deferred.delete(agentId);
    this.alignedAt.delete(agentId);
    this.failedMoves.delete(agentId);
    this.unrouted.delete(agentId);
    const ended = (session: LiveSession | undefined) => session !== undefined && Date.parse(session.openedAt) < closedAt;
    if (!ended((await this.store.read()).sessions[agentId])) return;
    await this.store.update((draft) => {
      if (ended(draft.sessions[agentId])) delete draft.sessions[agentId];
    });
  }

  async onAgentArchived(agentId: string): Promise<void> {
    this.deferred.delete(agentId);
    this.alignedAt.delete(agentId);
    this.failedMoves.delete(agentId);
    this.unrouted.delete(agentId);
    this.turnAt.delete(agentId);
    this.switchGuard.forget(agentId);
    this.guardNoticeAt.delete(agentId);
    this.guardNoticeAt.delete(`${agentId}:elsewhere`);
    if (!(await this.store.read()).sessions[agentId]) return;
    await this.store.update((draft) => {
      delete draft.sessions[agentId];
    });
  }

  /** Re-checks the account an agent was using; true when it really is signed out now. */
  private async confirmSignedOut(accountId: string | null): Promise<boolean> {
    if (!accountId) return false;
    const state = await this.store.read();
    if (findAccount(state, accountId)?.auth === "api") {
      // Nothing to re-check against: the refusal itself is the answer.
      await this.store.update((draft) => {
        const target = findAccount(draft, accountId);
        if (target) {
          target.signedIn = false;
          dropNextPick(draft, target);
        }
      });
      return true;
    }
    await this.refreshIdentity(accountId);
    return findAccount(await this.store.read(), accountId)?.signedIn === false;
  }

  /**
   * Carries out a switch that waited for the agent's turn to end, unless it's no longer wanted. While
   * another move has the agent, or a default change is pinning open agents, it keeps waiting, and
   * alignment picks it up once the agent is idle. `polled`: alignment found it idle, rather than its
   * turn just ending. Whoever finishes it, a move nobody asked for still waits for background work,
   * and one the user asked for doesn't (see `reopenAgent`).
   */
  private async finishDeferred(paseo: PaseoApi, agentId: string, family: Family, polled = false): Promise<void> {
    const release = this.pinning > 0 ? null : this.tryClaim(agentId);
    if (!release) return;
    try {
      const entry = this.deferred.get(agentId);
      // Dropped or done meanwhile (a turn end, a fresh session): nobody wants this move any more.
      if (!entry) return;
      const { row } = entry;
      this.deferred.delete(agentId);
      const state = await this.store.read();
      const current = this.runningOn(state, agentId, family);
      const target = this.targetFor(state, agentId, family, current);
      if (!current || !target || target === current) return; // Switched back meanwhile.
      if (entry.unattended) {
        // Left by alignment for a turn, during which the account may have come back (a limit lifted):
        // nobody asked for this move, so it only goes ahead off an account the agent can't work on.
        const info = await lookUpAgent(paseo, agentId).catch(() => null);
        if (info && !this.movesUnattended(state, info, family, current, target, Date.now())) return;
      }
      const result = await this.reopenAgent(paseo, agentId, { row, settle: !polled, background: polled, unattended: entry.unattended });
      if (row) await this.noteOutcome(paseo, agentId, row, result);
    } finally {
      release();
    }
  }

  // ------------------------------------------------------------------ limits and failover

  private lockFor(accountId: string): Mutex {
    let lock = this.failoverLocks.get(accountId);
    if (!lock) this.failoverLocks.set(accountId, (lock = new Mutex()));
    return lock;
  }

  /**
   * Deals with a turn that `ranOn` an account at its limit or signed out. When another move has the
   * agent, or it has moved since the turn ended, the limit is still recorded against `ranOn`, but
   * where the agent goes is left to that move.
   */
  private async handleUnavailable(
    paseo: PaseoApi,
    agentId: string,
    family: Family,
    timeline: readonly AgentTimelineItem[] | undefined,
    problem: Problem,
    endedAt: number,
    ranOn: string | null,
  ): Promise<void> {
    if (!ranOn) return;
    let release = this.tryClaim(agentId);
    if (!release) {
      // Another move has the agent (alignment, a switch asked for as the turn ended, a manual Codex
      // handoff). The limit is recorded now, so nothing is routed to the account meanwhile, then this
      // waits for that move: giving up would leave the agent waiting on the limit with nobody to carry
      // it on. Failover then finds the agent moved, or its task continued, and leaves it there.
      await this.noteLimit(ranOn, problem);
      release = await this.claim(agentId);
    }
    let exhausted: string | null = null;
    try {
      const state = await this.store.read();
      const account = findAccount(state, ranOn);
      if (!account) return;
      if (this.runningOn(state, agentId, family) !== account.id) {
        // Moved while the turn was being read (the user picked another account, say).
        await this.noteLimit(account.id, problem);
        return;
      }
      exhausted = account.id;
      await this.lockFor(account.id).run(() => this.failover(paseo, agentId, family, account, timeline, problem, endedAt));
    } finally {
      release();
    }
    if (exhausted && this.prefs.autoSwitch && this.adapters[family].portable) {
      void this.moveIdleAgentsOff(paseo, exhausted, family, agentId, problem.kind).catch((error: unknown) =>
        log("moving idle agents failed", error),
      );
    }
  }

  /** Records the limit a turn hit on `accountId`, unless a reset refilled the account just now. */
  private async noteLimit(accountId: string, problem: Problem): Promise<void> {
    if (problem.kind !== "limit") return;
    const { hit } = problem;
    if (hit.kind === "window" && this.recentlyRedeemed(accountId)) return;
    await this.markLimited(accountId, hit.resetsAt ?? new Date(Date.now() + (hit.kind === "budget" ? BUDGET_LIMIT_MS : WINDOW_LIMIT_MS)).toISOString(), hit.kind, "turn");
  }

  private async failover(
    paseo: PaseoApi,
    agentId: string,
    family: Family,
    account: StoredAccount,
    timeline: readonly AgentTimelineItem[] | undefined,
    problem: Problem,
    endedAt: number,
  ): Promise<void> {
    const adapter = this.adapters[family];
    const now = Date.now();
    // A parked Codex tab stays stopped: its task carries on in another tab. A failed lookup must not
    // stop the limit from being recorded below.
    const elsewhere = adapter.portable
      ? null
      : await this.continuations.continuesElsewhere(paseo, agentId).catch((error: unknown) => {
          log(`could not find where ${agentId}'s task continues`, error);
          return null;
        });
    if (problem.kind === "limit" && problem.hit.kind === "window" && this.recentlyRedeemed(account.id)) {
      // This turn hit the limit just before a reset refilled it (another agent's failover or the
      // user spent one moments ago). The account has room again: carry on instead of switching.
      if (elsewhere) {
        await this.noteElsewhere(paseo, agentId, account, "limit", null, elsewhere, "resume");
        return;
      }
      console.log(`[ZeroSub] ${account.label} was just reset; ${agentId} carries on where it is`);
      if (this.prefs.autoContinue && this.switchGuard.allows(agentId, now)) {
        this.switchGuard.note(agentId, now);
        await this.carryOn(paseo, agentId, endedAt);
      }
      return;
    }
    let resetsAt: string | null = null;
    if (problem.kind === "limit") {
      const { hit } = problem;
      resetsAt = hit.resetsAt ?? new Date(now + (hit.kind === "budget" ? BUDGET_LIMIT_MS : WINDOW_LIMIT_MS)).toISOString();
      await this.markLimited(account.id, resetsAt, hit.kind, "turn");
      if (hit.kind === "window") {
        // The notice is the freshest word on usage: show that window full until a new reading lands.
        const shown = this.usage.get(account.id);
        if (shown) this.setUsage(account.id, showLimit(shown, hit.resetsAt));
        // The account was just used, so its token is fresh: ask for the exact reset time.
        await withTimeout(this.refreshUsage(account.id, true), 12_000);
        const exact = this.resetFromUsage(account.id);
        if (exact && Date.parse(exact) > now) {
          resetsAt = exact;
          await this.markLimited(account.id, exact, "window", "turn");
        }
      }
      console.log(`[ZeroSub] ${account.label} hit a ${hit.kind} limit (agent ${agentId}): ${hit.message}`);
    } else {
      console.log(`[ZeroSub] ${account.label} is signed out (agent ${agentId})`);
    }

    if (!this.prefs.autoSwitch) return;
    if (elsewhere) {
      await this.noteElsewhere(paseo, agentId, account, problem.kind, resetsAt, elsewhere, "switch");
      return;
    }
    const latest = await this.store.read();
    if (this.runningOn(latest, agentId, family) !== account.id) return; // Already moved.
    const base = {
      family,
      from: account.label,
      resetsAt,
      continued: false,
      continuedIn: null,
      toFamily: null,
      detail: null,
      at: new Date(now).toISOString(),
    };
    const reason = problem.kind;
    if (!this.switchGuard.allows(agentId, now)) {
      console.warn(`[ZeroSub] not switching ${agentId} again: it changed accounts ${this.switchGuard.limit} times in 10 minutes`);
      // Say so once, so the user knows to pick an account rather than wait.
      if (this.noticeDue(agentId, now)) {
        await this.appendRow(paseo, agentId, {
          ...base,
          to: account.label,
          reason,
          outcome: "stayed",
          detail: `It changed accounts ${this.switchGuard.limit} times in 10 minutes, so ZeroSub stopped switching it for now. Pick an account from the account button to carry on.`,
        });
      }
      return;
    }
    const move = adapter.portable ? this.nextAccount(latest, agentId, family, account.id) : null;
    const next = adapter.portable ? move?.account : mostAvailable(latest, family, (id) => this.usage.get(id), now, new Set([account.id]));
    if (!next) {
      if (problem.kind === "limit" && problem.hit.kind === "window" && this.prefs.autoRedeem && !account.disabled) {
        // Opt-in: every account is out, so spend a banked reset rather than stop.
        const reply = await this.redeemOn(account, true);
        if (reply.outcome === "reset") {
          this.switchGuard.note(agentId, now);
          const continued = this.prefs.autoContinue && (await this.untouchedSince(paseo, agentId, endedAt));
          await this.appendRow(paseo, agentId, {
            ...base,
            to: account.label,
            reason: "limit",
            continued,
            outcome: "reset",
            detail: reply.message,
          });
          if (continued) await this.carryOn(paseo, agentId, endedAt);
          return;
        }
        if (reply.outcome === "not_limited") {
          // Refilled since this turn stopped (another host sharing the account, or the user, spent
          // a reset), so carry on here without spending a second one.
          console.log(`[ZeroSub] ${account.label} has room again; ${agentId} carries on where it is`);
          this.switchGuard.note(agentId, now);
          await this.afterReset(account.id, reply.left);
          if (this.prefs.autoContinue) await this.carryOn(paseo, agentId, endedAt);
          return;
        }
        console.log(`[ZeroSub] no automatic reset for ${account.label}: ${reply.message}`);
      }
      if (reason !== "limit") return;
      let detail: string | null = null;
      const otherFamily = OTHER_FAMILY[family];
      if (this.prefs.forkOtherProvider && otherFamily) {
        // Opt-in: every account of this provider is out, so carry on with the other provider.
        const result = await this.forkToOtherProvider(paseo, agentId, family, timeline, "auto").catch((error: unknown) => ({
          skipped: `Couldn't continue on ${FAMILY_LABEL[otherFamily]}: ${describe(error)}`,
        }));
        if ("fork" in result) {
          this.switchGuard.note(agentId, now);
          await this.appendRow(paseo, agentId, {
            ...base,
            to: result.account.label,
            toFamily: result.family,
            reason: "exhausted",
            continued: true,
            continuedIn: result.fork,
            outcome: "continued",
          });
          return;
        }
        console.log(`[ZeroSub] not continuing ${agentId} on ${FAMILY_LABEL[otherFamily]}: ${result.skipped}`);
        detail = result.skipped;
      } else if (otherFamily && mostAvailable(latest, otherFamily, (id) => this.usage.get(id), now, new Set())) {
        detail = `Or continue on ${FAMILY_LABEL[otherFamily]} in a new agent from the account button.`;
      }
      await this.appendRow(paseo, agentId, { ...base, to: account.label, reason: "exhausted", outcome: "stayed", detail });
      return;
    }

    if (adapter.portable) {
      if (move?.pin) await this.pin(agentId, next.id, latest.bindings[agentId]);
      this.switchGuard.note(agentId, now);
      const result = await this.reopenAgent(paseo, agentId, { settle: true });
      const continued = result.outcome === "reopened" && this.prefs.autoContinue && (await this.untouchedSince(paseo, agentId, endedAt));
      const row = await this.landed(
        {
          ...base,
          to: next.label,
          reason,
          continued,
          outcome: result.outcome === "reopened" ? "switched" : "pending",
          detail: result.outcome === "failed" ? failureDetail(result) : null,
        },
        agentId,
      );
      await this.appendRow(paseo, agentId, row);
      if (continued) await this.carryOn(paseo, agentId, endedAt);
      return;
    }

    // A ChatGPT thread can't move to another account; carry the work on in a new agent there.
    if (!this.prefs.autoContinue) {
      await this.appendRow(paseo, agentId, {
        ...base,
        to: next.label,
        reason,
        outcome: "stayed",
        detail: `New ChatGPT agents will use ${next.label}.`,
      });
      return;
    }
    const why =
      reason === "limit"
        ? `its ChatGPT account (${account.label}) reached its usage limit`
        : `its ChatGPT account (${account.label}) was signed out`;
    try {
      const continuation = await this.continueElsewhere(paseo, agentId, next, why, timeline, "auto");
      this.switchGuard.note(agentId, now);
      await this.appendRow(paseo, agentId, {
        ...base,
        to: next.label,
        reason,
        continued: true,
        continuedIn: continuation,
        outcome: "continued",
      });
    } catch (error) {
      log(`could not continue ${agentId} on ${next.label}`, error);
      await this.appendRow(paseo, agentId, {
        ...base,
        to: next.label,
        reason,
        outcome: "stayed",
        detail: `Couldn't continue on ${next.label}: ${describe(error)}`,
      });
    }
  }

  /** True once per guard window for each agent and notice, so repeated skips don't flood its timeline. */
  private noticeDue(key: string, now: number): boolean {
    if (now - (this.guardNoticeAt.get(key) ?? 0) <= this.switchGuard.windowMs) return false;
    this.guardNoticeAt.set(key, now);
    return true;
  }

  /** Says why ZeroSub left a parked Codex tab alone, instead of silently doing nothing. */
  private async noteElsewhere(
    paseo: PaseoApi,
    agentId: string,
    account: StoredAccount,
    reason: "limit" | "signed_out",
    resetsAt: string | null,
    elsewhere: Continuation,
    skipped: "switch" | "resume",
  ): Promise<void> {
    console.log(`[ZeroSub] not ${skipped === "switch" ? "switching" : "resuming"} ${agentId} automatically: its task continues in ${elsewhere.agentId}`);
    const now = Date.now();
    if (!this.noticeDue(`${agentId}:elsewhere`, now)) return;
    await this.appendRow(paseo, agentId, {
      family: account.family,
      from: account.label,
      to: account.label,
      reason,
      resetsAt,
      continued: false,
      continuedIn: null,
      toFamily: null,
      outcome: "stayed",
      detail: `This task continues in “${elsewhere.title}”, so ZeroSub didn't ${skipped} this tab automatically. Carry on there, or pick an account from the account button to continue from here.`,
      at: new Date(now).toISOString(),
    });
  }

  private async markLimited(accountId: string, until: string, kind: LimitKind, source: "turn" | "reading"): Promise<void> {
    await this.store.update((draft) => {
      const account = findAccount(draft, accountId);
      if (!account) return;
      const limit: Limit = { limitedUntil: until, limitKind: kind, limitedAt: new Date().toISOString(), limitSource: source };
      // A quota belongs to the subscription, so every slot signed into it is out of room.
      for (const slot of [account, ...sameSubscription(draft, account)]) Object.assign(slot, limit);
    });
  }

  // ------------------------------------------------------------------ banked resets

  private recentlyRedeemed(accountId: string): boolean {
    return Date.now() - (this.lastRedeemAt.get(accountId) ?? 0) < RESET_GRACE_MS;
  }

  /**
   * Spends one banked reset on `account`, one attempt at a time per account. A reset this host just
   * spent is shared: concurrent failovers carry on with it, and asking again by hand (a retry after
   * Paseo stopped waiting, say) doesn't spend a second one. `automatic` use spends one only while
   * the provider still sees the limit, so hosts sharing the account can't spend two on the same limit.
   */
  private redeemOn(account: StoredAccount, automatic: boolean): Promise<RedeemReply> {
    let lock = this.redeemLocks.get(account.id);
    if (!lock) this.redeemLocks.set(account.id, (lock = new Mutex()));
    return lock.run(async () => {
      if (this.recentlyRedeemed(account.id)) {
        if (automatic) return { outcome: "reset", message: "A reset was just used on this account.", left: null };
        const minutes = Math.floor((Date.now() - (this.lastRedeemAt.get(account.id) ?? 0)) / 60_000);
        return {
          outcome: "already_used",
          message: `A reset was used on ${account.label} ${minutes < 1 ? "moments" : `${minutes} min`} ago, so another one wasn't spent. Refresh usage to see its limits.`,
          left: null,
        };
      }
      this.redeeming.add(account.id);
      try {
        const reply = await this.adapters[account.family]
          .redeemReset(account.home, { onlyAtLimit: automatic })
          .catch((error: unknown): RedeemReply => ({ outcome: "error", message: describe(error), left: null }));
        console.log(`[ZeroSub] banked reset on ${account.label}: ${reply.outcome}`);
        if (reply.outcome === "reset") {
          const at = Date.now();
          this.lastRedeemAt.set(account.id, at);
          // The reset refilled the subscription, so stale notices from its other slots are past too.
          for (const twin of sameSubscription(await this.store.read(), account)) this.lastRedeemAt.set(twin.id, at);
          await this.afterReset(account.id, reply.left);
        } else if (reply.left !== null) {
          this.updateResetCount(account.id, reply.left);
        }
        return reply;
      } finally {
        this.redeeming.delete(account.id);
      }
    });
  }

  private async afterReset(accountId: string, left: number | null): Promise<void> {
    await this.store.update((draft) => {
      const account = findAccount(draft, accountId);
      if (!account) return;
      for (const slot of [account, ...sameSubscription(draft, account)]) {
        slot.limitedUntil = null;
        slot.limitKind = null;
      }
    });
    if (left !== null) this.updateResetCount(accountId, left);
    // Give the provider a moment to settle before reading the refilled usage.
    setTimeout(() => {
      this.usageAttemptAt.delete(accountId);
      void this.refreshUsage(accountId, true).catch(() => undefined);
    }, 5_000).unref?.();
  }

  private updateResetCount(accountId: string, left: number): void {
    const usage = this.usage.get(accountId);
    if (!usage?.resets) return;
    this.setUsage(accountId, { ...usage, resets: left > 0 ? { ...usage.resets, available: left } : null });
  }

  /**
   * A user-requested reset, optionally resuming the agent that was stopped by the limit. Renewing the
   * sign-in and the provider's answer can take longer than Paseo waits for an RPC, so after a while
   * this answers `pending` and the reset goes on: the account's usage, and the agent's timeline if it
   * carries on, show the result. A second request meanwhile is answered `pending` too, and one just
   * after a reset `already_used`; neither spends another.
   */
  async redeem(paseo: PaseoApi, accountId: string, agentId?: string): Promise<RedeemResult> {
    const replyBy = Date.now() + REPLY_WAIT_MS;
    this.attach(paseo);
    const account = findAccount(await this.store.read(), accountId);
    if (!account) throw new Error("That account no longer exists.");
    if (!account.signedIn) throw new Error(`${account.label} is signed out. Sign it in first.`);
    const pending = (message: string): RedeemResult => ({ outcome: "pending", message, left: null, continued: false });
    if (this.redeeming.has(account.id)) {
      return pending(`A reset is already being used on ${account.label}. Its limits show here once it's done; don't use another.`);
    }
    const task = (async (): Promise<RedeemResult> => {
      const reply = await this.redeemOn(account, false);
      let continued = false;
      if (reply.outcome === "reset" && agentId) {
        continued = await this.continueAfterReset(paseo, agentId, account, reply.message).catch(() => false);
      }
      return { ...reply, continued };
    })();
    task.catch((error: unknown) => log(`using a reset on ${account.label} failed`, error));
    if (await settles(task, replyBy - Date.now())) return task;
    return pending(
      `Still using the reset on ${account.label}. Its limits show here once it's done${agentId ? ", and the agent carries on" : ""}; don't use another.`,
    );
  }

  private async continueAfterReset(paseo: PaseoApi, agentId: string, account: StoredAccount, detail: string): Promise<boolean> {
    if (!this.prefs.autoContinue) return false;
    const info = await agentInfo(paseo, agentId);
    if (!info || info.archived || !settled(info.status)) return false;
    if (this.runningOn(await this.store.read(), agentId, account.family) !== account.id) return false;
    // Only resume an agent that this limit is known to have stopped.
    if ((await this.lastTurnHitLimit(paseo, agentId, account.family)) !== true) return false;
    const elsewhere = this.adapters[account.family].portable ? null : await this.continuations.continuesElsewhere(paseo, agentId);
    if (elsewhere) {
      await this.noteElsewhere(paseo, agentId, account, "limit", null, elsewhere, "resume");
      return false;
    }
    const at = new Date().toISOString();
    await this.appendRow(paseo, agentId, {
      family: account.family,
      from: account.label,
      to: account.label,
      reason: "limit",
      resetsAt: null,
      continued: true,
      continuedIn: null,
      toFamily: null,
      outcome: "reset",
      detail,
      at,
    });
    await paseo.agents.ref(agentId).send(this.prefs.continuePrompt);
    return true;
  }

  /**
   * The account an agent's live session really runs on. ZeroSub records every session it routes; one
   * it never routed (opened before ZeroSub was installed, or while it was stopped) has no account
   * override, so it runs on the CLI login.
   */
  private runningOn(state: StoredState, agentId: string, family: Family): string | undefined {
    return state.sessions[agentId]?.accountId ?? mainAccount(state, family)?.id;
  }

  /**
   * The account a session opening now may stay on as a stand-in (see `RouteInput.current`): where a
   * live agent runs. A closed one runs on none, so only an account its last session is still recorded
   * on counts, never the CLI login it would fall back to.
   */
  private standingIn(state: StoredState, agentId: string, family: Family, live: boolean): string | undefined {
    return live ? this.runningOn(state, agentId, family) : state.sessions[agentId]?.accountId;
  }

  /** The reset time of the window that is full, from the freshest live usage reading. */
  private resetFromUsage(accountId: string): string | null {
    const usage = this.usage.get(accountId);
    if (!usage || usage.cached) return null;
    const full = usage.windows.filter((window) => window.usedPercent >= 99 && window.resetsAt);
    // A full window of one model's only is what the turn hit when none of the account's own is full,
    // so a later-resetting model window doesn't stretch a 5-hour limit to days.
    const hit = full.some(capsAccount) ? full.filter(capsAccount) : full;
    hit.sort((a, b) => Date.parse(b.resetsAt ?? "") - Date.parse(a.resetsAt ?? ""));
    return hit[0]?.resetsAt ?? null;
  }

  /**
   * Did this agent's own last turn end on a limit? Then its own failover (with a follow-up) handles
   * it. Null when its timeline can't be read.
   */
  private async lastTurnHitLimit(paseo: PaseoApi, agentId: string, family: Family): Promise<boolean | null> {
    try {
      const page = await paseo.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 40 });
      const timeline = page.entries.map((entry) => entry.item);
      return this.adapters[family].detectLimit({ outcome: { kind: "completed" }, timeline }) !== null;
    } catch {
      return null;
    }
  }

  /**
   * Sends the continue prompt to an agent whose turn ended at `endedAt` on a limit. Paseo's send
   * cancels a turn that's running and unarchives an archived agent, so an agent someone has written
   * to since, or put away, is left as it is.
   */
  private async carryOn(paseo: PaseoApi, agentId: string, endedAt: number): Promise<void> {
    if (!(await this.untouchedSince(paseo, agentId, endedAt))) {
      console.log(`[ZeroSub] not continuing ${agentId}: it was used or put away since its limit`);
      return;
    }
    await paseo.agents
      .ref(agentId)
      .send(this.prefs.continuePrompt)
      .catch((error: unknown) => log(`could not continue ${agentId}`, error));
  }

  /** No turn has started or ended on the agent since `endedAt`, and it's still open. */
  private async untouchedSince(paseo: PaseoApi, agentId: string, endedAt: number): Promise<boolean> {
    if (this.turnAt.get(agentId) !== endedAt) return false;
    const info = await agentInfo(paseo, agentId);
    return info !== null && !info.archived && info.status !== "closed";
  }

  /**
   * Where an agent moves off an `exhausted` account: where it's routed now when that's another
   * account as chosen (one picked for it, perhaps while its turn ran, or the default it follows),
   * else the roomiest other one, which it's then pinned to. Undefined when there's none.
   */
  private nextAccount(state: StoredState, agentId: string, family: Family, exhausted: string): { account: StoredAccount; pin: boolean } | undefined {
    const routed = this.routeFor(state, agentId, family, exhausted);
    if (routed && routed.account.id !== exhausted && !routed.skipped) return { account: routed.account, pin: false };
    const roomiest = mostAvailable(state, family, (id) => this.usage.get(id), Date.now(), new Set([exhausted]));
    return roomiest && { account: roomiest, pin: true };
  }

  /** Pins an agent to the account an automatic switch moved it to, unless the user picked one since `seen`. */
  private async pin(agentId: string, accountId: string, seen: Binding | undefined): Promise<void> {
    await this.store.update((draft) => {
      if (sameBinding(draft.bindings[agentId], seen)) draft.bindings[agentId] = { accountId, source: "auto", at: new Date().toISOString() };
    });
  }

  /** Idle agents still on an exhausted account would fail on their next turn; move them now. */
  private async moveIdleAgentsOff(
    paseo: PaseoApi,
    accountId: string,
    family: Family,
    except: string,
    reason: "limit" | "signed_out",
  ): Promise<void> {
    const state = await this.store.read();
    const from = findAccount(state, accountId);
    // One a reset refilled just before this turn's limit came in still has room (see `failover`).
    if (!from || isUsable(from, Date.now())) return;
    const families = await this.families.resolve(paseo);
    const candidates = (await this.cachedAgents(paseo))
      .filter(
        (agent) =>
          agent.id !== except &&
          !agent.archived &&
          families[agent.provider] === family &&
          this.runningOn(state, agent.id, family) === accountId,
      )
      .map((agent) => agent.id);
    for (const agentId of candidates) {
      if (!this.switchGuard.allows(agentId, Date.now())) continue;
      const info = await agentInfo(paseo, agentId);
      // One the user is using right now is left for alignment to move once it's quiet.
      if (!info || info.archived || !settled(info.status) || busy(info) || hasBackgroundWork(info) || this.recentlyActive(info, Date.now())) continue;
      // Left for its own failover, or alone when that can't be told.
      if ((await this.lastTurnHitLimit(paseo, agentId, family)) !== false) continue;
      const release = this.tryClaim(agentId);
      if (!release) continue;
      try {
        const now = Date.now();
        const latest = await this.store.read();
        if (this.runningOn(latest, agentId, family) !== accountId) continue;
        const move = this.nextAccount(latest, agentId, family, accountId);
        if (!move) return;
        const next = move.account;
        if (move.pin) await this.pin(agentId, next.id, latest.bindings[agentId]);
        this.switchGuard.note(agentId, now);
        const row: SwitchRow = {
          family,
          from: from?.label ?? null,
          to: next.label,
          reason,
          resetsAt: findAccount(latest, accountId)?.limitedUntil ?? null,
          continued: false,
          continuedIn: null,
          toFamily: null,
          outcome: "switched",
          detail: null,
          at: new Date(now).toISOString(),
        };
        await this.noteOutcome(paseo, agentId, row, await this.reopenAgent(paseo, agentId, { row, background: true }));
      } finally {
        release();
      }
    }
  }

  /**
   * Carries an agent's work on in a new agent on the other provider (Claude ↔ ChatGPT), for when
   * every account of its own provider is out. The new agent gets the conversation so far and a mode
   * no more permissive than the original's; the original stays as it was.
   */
  private async forkToOtherProvider(
    paseo: PaseoApi,
    agentId: string,
    family: Family,
    timeline: readonly AgentTimelineItem[] | undefined,
    source: "auto" | "user",
  ): Promise<{ fork: Continuation; account: StoredAccount; family: Family } | { skipped: string }> {
    const other = OTHER_FAMILY[family];
    if (!other) return { skipped: `${FAMILY_LABEL[family]} agents don't carry on with another provider.` };
    const name = FAMILY_LABEL[other];
    const families = await this.families.resolve(paseo);
    const state = await this.store.read();
    // Prompting the original again while it's still out mustn't start a second copy of the work.
    const earlier = (await listAgents(paseo, false)).agents.find(
      (agent) => agent.continuedFrom === agentId && families[agent.provider] === other,
    );
    const earlierAccount = earlier && (findAccount(state, state.bindings[earlier.id]?.accountId) ?? mainAccount(state, other));
    if (earlier && earlierAccount) {
      return { fork: { agentId: earlier.id, title: earlier.title ?? `${name} agent` }, account: earlierAccount, family: other };
    }

    if (this.availability.get(other)?.ok === false) return { skipped: `${PROVIDER_NAME[other]} isn't installed where the daemon runs.` };
    const provider = families[other] === other ? other : Object.keys(families).find((id) => families[id] === other);
    const available = provider
      ? (await paseo.providers.listAvailable()).providers?.some((entry) => entry.provider === provider && entry.available)
      : false;
    if (!provider || !available) return { skipped: `${name} isn't available in Paseo on this host.` };
    const account = mostAvailable(state, other, (id) => this.usage.get(id), Date.now(), new Set());
    if (!account) return { skipped: `Every ${name} account is at its limit too.` };

    const original = (await paseo.agents.ref(agentId).refresh())?.agent;
    if (!original) throw new Error("That agent is no longer available.");
    const [sourceModes, targetModes] = await Promise.all([
      paseo.providers.listModes(original.provider).then((result) => result.modes ?? []),
      paseo.providers.listModes(provider).then((result) => result.modes ?? []),
    ]);
    const modeId = equivalentMode(sourceModes, original.currentModeId, targetModes);
    if (!modeId) {
      const current = sourceModes.find((mode) => mode.id === original.currentModeId)?.label;
      return {
        skipped: `${name} has no mode as careful as this agent's${current ? ` (“${current}”)` : ""}, so ZeroSub didn't continue it there.`,
      };
    }

    const fork = await continueInNewAgent({
      paseo,
      sourceAgentId: agentId,
      timeline,
      why: source === "auto" ? `every ${FAMILY_LABEL[family]} account reached its usage limit` : `the work was moved to ${name}`,
      previous: PROVIDER_NAME[family],
      target: { provider, label: name, modeId },
      parentId: await this.continuations.parentFor(paseo, agentId),
      bind: async (newAgentId) => {
        await this.store.update((draft) => {
          draft.bindings[newAgentId] = {
            accountId: account.id,
            source: source === "user" ? "user" : this.adapters[other].portable ? "auto" : "thread",
            at: new Date().toISOString(),
          };
        });
      },
    });
    console.log(`[ZeroSub] ${agentId} continues on ${name} (${account.label}) in ${fork.agentId}`);
    return { fork, account, family: other };
  }

  /** "Continue on …" from an agent's account button: the same fork, asked for by the user. */
  async forkAgent(paseo: PaseoApi, agentId: string): Promise<Continuation> {
    return this.withSwitch(agentId, () => this.forkAgentNow(paseo, agentId));
  }

  /** Manual continuations share the automatic failover guard, including cross-provider forks. */
  private async withSwitch<T>(agentId: string, action: () => Promise<T>): Promise<T> {
    const release = this.tryClaim(agentId);
    if (!release) throw new Error("This agent is already switching accounts. Wait for its handoff to finish.");
    try {
      return await action();
    } finally {
      release();
    }
  }

  /** Claims an agent for a move, or returns null while another move has it. */
  private tryClaim(agentId: string): (() => void) | null {
    if (this.switching.has(agentId)) return null;
    let done = () => {};
    this.switching.set(agentId, new Promise<void>((resolve) => (done = resolve)));
    return () => {
      this.switching.delete(agentId);
      done();
    };
  }

  /** Claims an agent for a move once any move it's in has finished. */
  private async claim(agentId: string): Promise<() => void> {
    for (;;) {
      const release = this.tryClaim(agentId);
      if (release) return release;
      await this.switching.get(agentId);
    }
  }

  private async forkAgentNow(paseo: PaseoApi, agentId: string): Promise<Continuation> {
    this.attach(paseo);
    const info = await lookUpAgent(paseo, agentId);
    if (!info || info.archived) throw new Error("That agent is no longer available.");
    const family = (await this.families.resolve(paseo))[info.provider];
    if (!family) throw new Error(`${info.provider} agents don't use Claude or ChatGPT subscription accounts.`);
    if (info.status === "running" || info.status === "initializing") {
      throw new Error("This agent is working right now. Wait for its turn to finish, then continue it elsewhere.");
    }
    const result = await this.forkToOtherProvider(paseo, agentId, family, undefined, "user");
    if ("skipped" in result) throw new Error(result.skipped);
    const state = await this.store.read();
    await this.appendRow(paseo, agentId, {
      family,
      from: findAccount(state, this.runningOn(state, agentId, family))?.label ?? null,
      to: result.account.label,
      reason: "manual",
      resetsAt: null,
      continued: true,
      continuedIn: result.fork,
      toFamily: result.family,
      outcome: "continued",
      detail: null,
      at: new Date().toISOString(),
    });
    return result.fork;
  }

  private async continueElsewhere(
    paseo: PaseoApi,
    agentId: string,
    target: StoredAccount,
    why: string,
    timeline: readonly AgentTimelineItem[] | undefined,
    source: "auto" | "user",
  ): Promise<Continuation> {
    if (target.family === "codex") return this.continuations.continue(paseo, agentId, target, why, source);
    return continueInNewAgent({
      paseo,
      sourceAgentId: agentId,
      timeline,
      why,
      parentId: await this.continuations.parentFor(paseo, agentId),
      bind: async (newAgentId) => {
        await this.store.update((draft) => {
          draft.bindings[newAgentId] = {
            accountId: target.id,
            source: source === "user" ? "user" : "thread",
            at: new Date().toISOString(),
          };
        });
      },
    });
  }

  // ------------------------------------------------------------------ reopening sessions

  /**
   * How routing would open this agent's next session now, including skipping exhausted accounts.
   * `current` is the account its session runs on, which it keeps while that can stand in.
   */
  private routeFor(state: StoredState, agentId: string, family: Family, current?: string): RouteDecision | null {
    return chooseAccount(state, {
      agentId,
      family,
      reason: "refresh",
      now: Date.now(),
      autoSwitch: this.prefs.autoSwitch,
      balanceNewAgents: false,
      portable: this.adapters[family].portable,
      usageOf: (id) => this.usage.get(id),
      current,
    });
  }

  /**
   * Where this agent's session belongs now. One on a usable stand-in, `current` (see `standingIn`),
   * belongs where it is.
   */
  private targetFor(state: StoredState, agentId: string, family: Family, current: string | undefined): string | undefined {
    return this.routeFor(state, agentId, family, current)?.account.id;
  }

  /** Names the account the agent actually reopened on in its timeline note. */
  private async landed(row: SwitchRow, agentId: string): Promise<SwitchRow> {
    const state = await this.store.read();
    const label = findAccount(state, state.sessions[agentId]?.accountId)?.label;
    return label && row.outcome === "switched" ? { ...row, to: label } : row;
  }

  /** The user was using the agent a moment ago: a turn started or ended, or they sent a message. */
  private recentlyActive(agent: AgentInfo, now: number): boolean {
    return now - Math.max(this.turnAt.get(agent.id) ?? 0, agent.lastMessageAt) < TURN_SETTLE_MS;
  }

  /**
   * Reopens an idle agent now, or defers a busy one until its turn ends. `settle` waits a moment for
   * an agent whose turn just ended to report idle, since nothing else would reopen it later. A reload
   * cancels a running turn, so the agent is looked at again right before it; a `background` move
   * (alignment's pass) then also waits for the turn of an agent that was in use a moment ago, and an
   * `unattended` one (nobody asked for it; alignment's by default) for background work to stop.
   * Alignment carries either out once it's quiet.
   */
  private async reopenAgent(
    paseo: PaseoApi,
    agentId: string,
    options: { row?: SwitchRow | null; settle?: boolean; background?: boolean; unattended?: boolean } = {},
  ): Promise<ReopenResult> {
    const { row = null, settle = false, background = false, unattended = background } = options;
    let info: AgentInfo | null;
    try {
      info = await lookUpAgent(paseo, agentId);
      for (let attempt = 0; settle && info && attempt < 20 && busy(info); attempt += 1) {
        await delay(300);
        info = await lookUpAgent(paseo, agentId);
      }
    } catch (error) {
      return unchecked(error);
    }
    if (!info) return { outcome: "closed" };
    if (busy(info)) return this.defer(agentId, row, unattended);
    // Reloading an archived agent would unarchive it; a closed one routes itself when it next opens.
    if (info.archived || info.status === "closed") return { outcome: "closed" };
    const family = (await this.families.resolve(paseo))[info.provider];
    const state = await this.store.read();
    // A thread whose session opened without ZeroSub (on the CLI login) belongs to the account it's
    // pinned to, which holds its history, so it reopens there.
    if (family && !this.adapters[family].portable && info.hasHistory && (state.sessions[agentId] || !state.bindings[agentId])) {
      // The thread gained history while waiting, so it can no longer change accounts: keep it put.
      const current = this.runningOn(state, agentId, family);
      if (current && findAccount(state, current)) {
        await this.store.update((draft) => {
          draft.bindings[agentId] = { accountId: current, source: "thread", at: new Date().toISOString() };
        });
      }
      return { outcome: "closed" };
    }
    // Look once more right before reloading: a turn that started meanwhile would be cancelled.
    let latest: AgentInfo | null;
    try {
      latest = await lookUpAgent(paseo, agentId);
    } catch (error) {
      return unchecked(error);
    }
    if (!latest || latest.archived || latest.status === "closed") return { outcome: "closed" };
    if (busy(latest) || (unattended && hasBackgroundWork(latest)) || (background && this.recentlyActive(latest, Date.now()))) {
      return this.defer(agentId, row, unattended);
    }
    const reload: Reload = { opens: 0 };
    this.reloads.set(agentId, reload);
    let result: Awaited<ReturnType<Reopener["reopen"]>>;
    try {
      result = await this.reopener.reopen(agentId, paseo);
    } finally {
      this.reloads.delete(agentId);
    }
    if (result.ok && reload.opens === 0) {
      result = { ok: false, error: "Paseo reported a reload but did not open a new provider session", timedOut: false };
    }
    if (result.ok && this.unrouted.has(agentId)) {
      // Paseo stopped waiting for routing and reopened the session as it was (see `onSessionOpen`).
      result = { ok: false, error: "ZeroSub couldn't pick its account in time, so it reopened on your CLI login", timedOut: false };
    }
    if (!result.ok) {
      console.warn(`[ZeroSub] could not reopen ${agentId}: ${result.error}`);
      // Paseo asks for the new session's environment before it closes the old one, so a failed reload
      // has still recorded a session that never opened. One that ran out of time may yet open. Only
      // this reload's own record is undone: a session opened since (another reload) stands.
      const { opened } = reload;
      if (!result.timedOut && opened && reload.opens === 1) {
        await this.store.update((draft) => {
          const recorded = draft.sessions[agentId];
          if (recorded?.openedAt !== opened.wrote.openedAt || recorded.accountId !== opened.wrote.accountId) return;
          if (opened.replaced) draft.sessions[agentId] = opened.replaced;
          else delete draft.sessions[agentId];
        });
      }
      if (!result.timedOut && family) {
        const latest = await this.store.read();
        const target = this.targetFor(latest, agentId, family, this.runningOn(latest, agentId, family));
        if (target) this.failedMoves.set(agentId, target);
      }
      return { outcome: "failed", error: result.error, timedOut: result.timedOut };
    }
    // A move alignment asked for has landed, so a later one to the same account isn't held back.
    if (this.alignedAt.get(agentId)?.accountId === (await this.store.read()).sessions[agentId]?.accountId) this.alignedAt.delete(agentId);
    return { outcome: "reopened" };
  }

  /**
   * Leaves the move for the end of the agent's turn, keeping the note of a move already waiting. One
   * the user asked for stays theirs when alignment defers it again.
   */
  private defer(agentId: string, row: SwitchRow | null, unattended: boolean): ReopenResult {
    const waiting = this.deferred.get(agentId);
    this.deferred.set(agentId, { row: row ?? waiting?.row ?? null, unattended: unattended && (waiting?.unattended ?? true) });
    return { outcome: "deferred" };
  }

  /** Notes how a move came out: where the agent landed, or that it moves when its session next starts. */
  private async noteOutcome(paseo: PaseoApi, agentId: string, row: SwitchRow, result: ReopenResult): Promise<void> {
    if (result.outcome === "reopened") await this.appendRow(paseo, agentId, await this.landed(row, agentId));
    else if (result.outcome === "failed") {
      await this.appendRow(paseo, agentId, { ...row, outcome: "pending", detail: failureDetail(result), at: new Date().toISOString() });
    }
  }

  /**
   * Reopens every live agent whose session runs on a different account than it is routed to now,
   * and notes in its timeline how that went. Busy agents switch (and get their note) after their
   * turn. With no `reason`, each agent's note says why its account no longer fits.
   *
   * Each agent is claimed while it moves, so two moves never reload it twice. A move the user asked
   * for waits for one already under way, then looks again. A `background` pass (alignment) skips
   * agents another move has and leaves ones in use a moment ago for later; with `expected`, it only
   * makes the moves it decided on, since whatever changed under it is for its next pass. `summary`
   * fills in as agents move, with the ones still to go in `pending`, for an answer that can't wait.
   */
  private async reconcile(
    paseo: PaseoApi,
    reason: SwitchRow["reason"] | null,
    agentIds?: readonly string[],
    fromLabels: ReadonlyMap<string, string> = new Map(),
    options: { summary?: ReopenSummary; background?: boolean; expected?: ReadonlyMap<string, string> } = {},
  ): Promise<ReopenSummary> {
    const summary = options.summary ?? emptySummary();
    const families = await this.families.resolve(paseo);
    const initial = await this.store.read();
    const due: Array<{ agentId: string; family: Family }> = [];
    for (const agent of await this.liveAgents(paseo, agentIds)) {
      const family = families[agent.provider];
      if (!family) continue;
      const current = this.runningOn(initial, agent.id, family);
      const target = this.targetFor(initial, agent.id, family, current);
      if (current && target && target !== current) due.push({ agentId: agent.id, family });
    }
    summary.pending.push(...due.map(({ agentId }) => agentId));
    for (const { agentId, family } of due) {
      const release = options.background ? this.tryClaim(agentId) : await this.claim(agentId);
      try {
        if (!release) continue;
        const state = await this.store.read();
        const current = this.runningOn(state, agentId, family);
        const target = this.targetFor(state, agentId, family, current);
        if (!current || !target || target === current) continue; // Moved, or no longer wanted, meanwhile.
        if (options.expected && options.expected.get(agentId) !== target) continue;
        const why = reason ?? this.driftReason(state, agentId, current, target, Date.now());
        const row: SwitchRow = {
          family,
          from: findAccount(state, current)?.label ?? fromLabels.get(current) ?? null,
          to: findAccount(state, target)?.label ?? target,
          reason: why,
          resetsAt: why === "limit" ? (findAccount(state, current)?.limitedUntil ?? null) : null,
          continued: false,
          continuedIn: null,
          toFamily: null,
          outcome: "switched",
          detail: null,
          at: new Date().toISOString(),
        };
        const result = await this.reopenAgent(paseo, agentId, { row, background: options.background });
        if (result.outcome === "reopened") summary.reopened.push(agentId);
        else if (result.outcome === "deferred") summary.deferred.push(agentId);
        else if (result.outcome === "failed") summary.failed.push({ agentId, error: result.error });
        if (options.background && result.outcome === "failed") {
          // A reload alignment tried that didn't land is tried again after a while, and noted once. One
          // that never got as far as a reload is tried again next pass, without a note.
          if (result.unchecked) continue;
          const tried = this.alignedAt.get(agentId);
          const noted = tried?.accountId === target && tried.noted === true;
          this.alignedAt.set(agentId, { accountId: target, at: Date.now(), noted: true });
          if (noted) continue;
        }
        await this.noteOutcome(paseo, agentId, row, result);
      } finally {
        release?.();
        const index = summary.pending.indexOf(agentId);
        if (index >= 0) summary.pending.splice(index, 1);
      }
    }
    return summary;
  }

  /**
   * Answers an RPC that moves agents by `replyBy` with what's known: agents still moving are in
   * `pending`, and the move carries on, its outcome in each agent's timeline and the next state.
   */
  private async answerBy(replyBy: number, moves: Promise<ReopenSummary>, summary: ReopenSummary): Promise<ReopenSummary> {
    // What the moves follow from (a new default, a disabled account) is saved already, so a move that
    // throws doesn't fail the answer: the agents it didn't get to stay in `pending`, for alignment.
    const answer = moves.catch((error: unknown) => {
      log("moving agents failed", error);
      return structuredClone(summary);
    });
    if (await settles(answer, replyBy - Date.now())) return answer;
    return structuredClone(summary);
  }

  /**
   * Moves live agents off an account they can't work on (at its limit, signed out, turned off or
   * removed) to the one they're routed to, when nothing else did: a limit read from usage, say, or a
   * session that opened before routing answered. Also carries out a switch that was waiting for a
   * turn that never came. A reload cancels what the agent is doing, so one whose account still works
   * isn't moved unattended: the account button shows the move still to come, and it happens when the
   * session next opens. Idle agents move now; busy ones after their turn, ones with background work
   * still running once it stops, and ones the user was just using once they've been quiet a while. A move that
   * doesn't land isn't tried again for a while.
   */
  async alignSessions(paseo: PaseoApi): Promise<ReopenSummary> {
    if (this.aligning || this.stopped || this.pinning > 0) return emptySummary();
    this.aligning = true;
    try {
      // Without the host's own reopen or the CLI nothing can be reopened; agents move when their sessions next start.
      if (!(await this.canReopen(paseo))) return emptySummary();
      const state = await this.store.read();
      const families = await this.families.resolve(paseo);
      const routing = new Set(this.routing.values());
      const now = Date.now();
      const due = new Map<string, string>();
      const waiting: Array<{ agentId: string; family: Family }> = [];
      for (const agent of await this.liveAgents(paseo)) {
        const agentId = agent.id;
        const family = families[agent.provider];
        if (!family || routing.has(agentId) || this.switching.has(agentId) || this.recentlyActive(agent, now)) continue;
        if (this.deferred.has(agentId)) {
          // Its switch waited for a turn that never came (it was only starting), or ended without it.
          if (settled(agent.status)) waiting.push({ agentId, family });
          continue;
        }
        const current = this.runningOn(state, agentId, family);
        const target = this.targetFor(state, agentId, family, current);
        if (!current || !target || target === current) continue;
        // A reload cancels what the agent is doing, so nobody having asked, it only leaves an account
        // it can't work on. One whose account still works moves when its session next opens. A
        // ChatGPT thread with history can't work anywhere but the account holding it (see `reopenAgent`).
        if (!this.alignmentTries(state, agent, family, current, target, now)) continue;
        due.set(agentId, target);
      }
      for (const { agentId, family } of waiting) await this.finishDeferred(paseo, agentId, family, true);
      if (due.size === 0) return emptySummary();
      const summary = await this.reconcile(paseo, null, [...due.keys()], undefined, { background: true, expected: due });
      for (const agentId of summary.reopened) this.switchGuard.note(agentId, Date.now());
      if (summary.reopened.length + summary.deferred.length + summary.failed.length > 0) {
        console.log(
          `[ZeroSub] aligned agents with their accounts: ${summary.reopened.length} moved, ${summary.deferred.length} after their turn, ${summary.failed.length} failed`,
        );
      }
      return summary;
    } finally {
      this.aligning = false;
    }
  }

  /**
   * When an agent whose session runs on `current` moves to `target`: after its turn, once its
   * background work stops, once it's idle (alignment), or only when its session next starts.
   */
  private movesWhen(
    state: StoredState,
    agent: AgentInfo,
    family: Family,
    current: string,
    target: string,
    canReopen: boolean,
    now: number,
  ): NonNullable<AgentRoute["waiting"]> {
    if (!canReopen || this.failedMoves.get(agent.id) === target) return "restart";
    const deferred = this.deferred.get(agent.id);
    // Only a move left for its turn, or one alignment tries, happens before the session next starts.
    // One left for its turn goes ahead as `finishDeferred` checks: always when asked for, and when
    // nobody asked, only while alignment would still make it.
    const happens = deferred ? !deferred.unattended || this.movesUnattended(state, agent, family, current, target, now) : this.alignmentTries(state, agent, family, current, target, now);
    if (!happens) return "restart";
    if (busy(agent)) return "turn";
    if (hasBackgroundWork(agent) && (deferred?.unattended ?? true)) return "background";
    return "idle";
  }

  /**
   * Whether alignment's next passes try to move the agent from `current` to `target`: a move it makes
   * (see `movesUnattended`), not tried just now without landing, and not held back by the switch guard.
   */
  private alignmentTries(state: StoredState, agent: AgentInfo, family: Family, current: string, target: string, now: number): boolean {
    if (!this.movesUnattended(state, agent, family, current, target, now)) return false;
    const tried = this.alignedAt.get(agent.id);
    if (tried?.accountId === target && now - tried.at < ALIGN_RETRY_MS) return false;
    return this.switchGuard.allows(agent.id, now);
  }

  /**
   * Whether alignment moves the agent by itself: only off an account it can't work on, or a ChatGPT
   * thread with history away from the account holding it.
   */
  private movesUnattended(state: StoredState, agent: AgentInfo, family: Family, current: string, target: string, now: number): boolean {
    const reason = this.driftReason(state, agent.id, current, target, now);
    const stranded = !this.adapters[family].portable && agent.hasHistory;
    return stranded || (reason !== "manual" && reason !== "default");
  }

  /** Why an agent's session no longer runs on the account it's routed to, for its timeline note. */
  private driftReason(state: StoredState, agentId: string, current: string, target: string, now: number): SwitchRow["reason"] {
    const from = findAccount(state, current);
    if (!from) return "removed";
    if (!from.signedIn) return "signed_out";
    if (from.disabled) return "disabled";
    if (isLimited(from, now)) return "limit";
    return state.bindings[agentId]?.accountId === target ? "manual" : "default";
  }

  private async appendRow(paseo: PaseoApi, agentId: string, row: SwitchRow): Promise<void> {
    try {
      await paseo.agents.ref(agentId).timeline.append({
        type: "plugin",
        id: `switch-${Date.parse(row.at) || Date.now()}`,
        kind: SWITCH_ROW_KIND,
        version: SWITCH_ROW_VERSION,
        data: row,
      });
    } catch (error) {
      log(`could not add a timeline note to ${agentId}`, error);
    }
  }

  // ------------------------------------------------------------------ usage

  /**
   * `renewLogin` lets the CLI refresh an expired sign-in first (explicit refreshes: it's slow). Other
   * reads may renew it too, at most every RENEW_LOGIN_MS (see `renewsInBackground`).
   */
  refreshUsage(accountId: string, force = false, renewLogin = false): Promise<void> {
    const pending = this.usageInFlight.get(accountId);
    if (pending) return pending;
    const now = Date.now();
    // The provider asked us to wait; asking sooner would only be refused again.
    if (now < (this.usageRetryAt.get(accountId) ?? 0)) return Promise.resolve();
    const since = now - (this.usageAttemptAt.get(accountId) ?? 0);
    const task = (async () => {
      const account = findAccount(await this.store.read(), accountId);
      // An API account (an added Pi account) has no subscription windows to read.
      if (!account || account.auth === "api") return;
      const spacing = this.adapters[account.family].usageSpacingMs;
      if (since < (force ? spacing : Math.max(spacing, 60_000))) return;
      this.usageAttemptAt.set(accountId, Date.now());
      const renew = renewLogin || this.renewsInBackground(account, Date.now());
      if (renew) this.renewAttemptAt.set(accountId, Date.now());
      const { retryAt, ...read } = await this.adapters[account.family]
        .usage(account.home, { renewLogin: renew })
        .catch(
          (error: unknown): UsageRead => ({ fetchedAt: new Date().toISOString(), windows: [], error: describe(error), cached: false, resets: null }),
        );
      if (retryAt) this.usageRetryAt.set(accountId, retryAt);
      else this.usageRetryAt.delete(accountId);
      const usage: Usage = { ...read, credits: read.credits ?? null };
      this.setUsage(accountId, mergeUsage(this.usage.get(accountId), usage));
      // Only a live reading may change an account's limit state.
      if (usage.windows.length === 0 || usage.error || usage.cached) {
        this.usageLive.delete(accountId);
        return;
      }
      this.usageLive.add(accountId);
      const now = Date.now();
      // With "Use ChatGPT credits when a limit is reached" on, credits keep an account going past a
      // full window, so a full window alone isn't a limit then.
      const creditsCover = this.prefs.useCredits && usage.credits != null;
      const full = creditsCover ? undefined : usage.windows.find((window) => window.usedPercent >= 100 && window.resetsAt);
      // One model's own full window (Claude's "Weekly · Opus") leaves the account usable for the rest.
      // A turn that hits it still marks the account (see `failover`), and while it's full that limit
      // doesn't clear here.
      const cutOff = full && usage.windows.find((window) => window.usedPercent >= 100 && window.resetsAt && capsAccount(window));
      if (cutOff && !isLimited(account, now)) {
        await this.markLimited(accountId, cutOff.resetsAt ?? new Date(now + WINDOW_LIMIT_MS).toISOString(), "window", "reading");
        return;
      }
      // A window limit clears once usage shows room again, or once credits cover it if a reading set
      // it: a limit a turn ran into stands, credits or not. Budget limits never appear in usage
      // windows, and a fresh limit is trusted for a while (it may be on a window we can't see).
      const settled = account.limitedAt ? now - Date.parse(account.limitedAt) > LIMIT_TRUST_MS : true;
      const roomy = (creditsCover && account.limitSource === "reading") || Math.max(...usage.windows.map((window) => window.usedPercent)) < 90;
      if (!full && account.limitedUntil && account.limitKind === "window" && settled && roomy) {
        await this.store.update((draft) => {
          const target = findAccount(draft, accountId);
          if (!target) return;
          target.limitedUntil = null;
          target.limitKind = null;
        });
      }
    })().finally(() => this.usageInFlight.delete(accountId));
    this.usageInFlight.set(accountId, task);
    return task;
  }

  /**
   * A read nobody asked to renew the sign-in for still renews it when the reading is past a reset
   * (its old numbers would stay up until the account is next used), or when a window limit has no
   * live reading (a reset used on another machine, or an early one, wouldn't lift it). At most
   * every RENEW_LOGIN_MS, and not for a disabled account.
   */
  private renewsInBackground(account: StoredAccount, now: number): boolean {
    if (account.disabled || now - (this.renewAttemptAt.get(account.id) ?? 0) < RENEW_LOGIN_MS) return false;
    const windowLimited = account.limitKind === "window" && isLimited(account, now);
    return pastReset(this.usage.get(account.id), now) || (windowLimited && !this.usageLive.has(account.id));
  }

  /** Records a reading and saves the readings shortly after, so a restart shows them straight away. */
  private setUsage(accountId: string, usage: Usage | null): void {
    if (usage) this.usage.set(accountId, usage);
    else this.usage.delete(accountId);
    if (this.usageSave) return;
    this.usageSave = setTimeout(() => {
      this.usageSave = null;
      void saveReadings(this.usage).catch((error: unknown) => log("could not save usage", error));
    }, 3_000);
    this.usageSave.unref?.();
  }

  // ------------------------------------------------------------------ RPC: state

  async view(paseo: PaseoApi, refreshUsage = false): Promise<StateView> {
    this.attach(paseo);
    if (refreshUsage) {
      const state = await this.store.read();
      // Renewing a sign-in can take longer than Paseo waits for an answer; later readings show at the next poll.
      await settles(Promise.allSettled(state.accounts.map((account) => this.refreshUsage(account.id, true, true))), USAGE_REPLY_MS);
    }
    void this.prune(paseo).catch(() => undefined);
    const state = await this.store.read();
    const families = await this.families.resolve(paseo);
    const agents = await this.cachedAgents(paseo);
    const canReopen = await this.canReopen(paseo);
    const now = Date.now();

    const routes: AgentRoute[] = [];
    const counts = new Map<string, number>();
    for (const agent of agents) {
      const family = families[agent.provider];
      if (!family || agent.archived) continue;
      const live = isLive(agent.status);
      const accountId = this.targetFor(state, agent.id, family, this.standingIn(state, agent.id, family, live));
      if (!accountId) continue;
      counts.set(accountId, (counts.get(accountId) ?? 0) + 1);
      const current = live ? this.runningOn(state, agent.id, family) : undefined;
      const binding = state.bindings[agent.id];
      const pending = current && current !== accountId ? current : null;
      routes.push({
        agentId: agent.id,
        family,
        accountId,
        pinned: Boolean(binding && binding.source !== "thread"),
        // Only while the agent is still on the account that was picked for it.
        selectionReason:
          binding?.source === "balance" && binding.selectionReason === "weekly_reset" && binding.accountId === accountId
            ? "weekly_reset"
            : undefined,
        pendingAccountId: pending,
        waiting: !pending ? null : this.movesWhen(state, agent, family, pending, accountId, canReopen, now),
        movable: this.adapters[family].portable || !agent.hasHistory,
      });
    }

    const piScripts = this.launcherAccounts(state);
    const launcherOf = this.launcherFiles ?? launcherNames(piScripts);
    const proxies = new Map<string, ProxyState>();
    const apis = new Map<string, ApiSummary | null>();
    const external = new Set<string>();
    await Promise.all(
      state.accounts.map(async (account) => {
        const adapter = this.adapters[account.family];
        // A home of null is the CLI's own login; its files are only read here.
        if (adapter.proxyState && (account.kind === "main" || account.home)) {
          proxies.set(account.id, await adapter.proxyState(account.home).catch((): ProxyState => ({ own: null, file: null, inherited: null })));
        }
        if (account.kind === "main" && adapter.mainApi && adapter.api) apis.set(account.id, await adapter.api(null).catch(() => null));
        if (account.kind !== "managed" || !account.home) return;
        if (adapter.homesInUse && !(await isOwnHome(account.home))) external.add(account.id);
        if (account.auth === "api" && adapter.api) apis.set(account.id, await adapter.api(account.home).catch(() => null));
      }),
    );
    // A proxy kept in the user's file (Pi's own login's in its settings) is also the one every added
    // account without its own goes through.
    const followers = (family: Family) =>
      state.accounts.filter((other) => other.family === family && other.kind === "managed" && proxies.get(other.id)?.own === null).map((other) => other.label);
    const piHomesNow = piHomesDir(state.piHomes);
    const due = new Set((await this.dueMoves(state)).map((account) => account.id));
    const moving = (account: StoredAccount): AccountView["moving"] => {
      const move = state.moves[account.id];
      if (!move && !due.has(account.id)) return null;
      const note = this.moveNotes.get(account.id);
      return { to: shownPath(move?.to ?? piHomesNow), waiting: note?.waiting ?? null, error: note?.error ?? null };
    };
    const accounts: AccountView[] = state.accounts.map((account) => {
      const limited = isLimited(account, now);
      const proxy = proxies.get(account.id);
      return {
        id: account.id,
        family: account.family,
        label: account.label,
        kind: account.kind,
        email: account.email,
        plan: account.plan,
        organization: account.organization,
        status: !account.signedIn ? "signed_out" : account.disabled ? "disabled" : limited ? "limited" : "ready",
        isDefault: defaultAccount(state, account.family)?.id === account.id,
        nextAgentUntil: nextPickUntil(state, account.id, account.family, now),
        limitedUntil: limited ? account.limitedUntil : null,
        usage: this.usage.get(account.id) ?? null,
        agentCount: counts.get(account.id) ?? 0,
        home: account.home,
        auth: account.auth,
        api: apis.get(account.id) ?? null,
        apiEditable: account.auth === "api" || (account.kind === "main" && this.adapters[account.family].mainApi === true),
        proxy: proxy?.own ? maskProxy(proxy.own) : null,
        proxyEditable: proxy !== undefined,
        inheritedProxy: proxy?.inherited ? { ...proxy.inherited, proxy: maskProxy(proxy.inherited.proxy) } : null,
        proxyFile: proxy?.file ?? null,
        proxyFollowers: proxy?.file ? followers(account.family) : [],
        launcher: launcherOf.get(account.id) ?? null,
        egress: this.egress.get(account.id) ?? null,
        externalHome: external.has(account.id),
        moving: moving(account),
      };
    });

    return {
      accounts,
      agents: routes,
      logins: [...this.logins.values()].map((login) => login.view),
      providers: families,
      canReopen,
      browserSignIn: this.browserSignIn,
      showComposerPill: this.prefs.showComposerPill,
      autoSwitch: this.prefs.autoSwitch,
      warnings: await this.warnings(),
      piLaunchers: piScripts.length > 0 ? piLauncherDir() : null,
      piHomes: this.adapters.pi.homesInUse ? { dir: shownPath(piHomesNow), isDefault: state.piHomes.dir === null } : null,
    };
  }

  /** Whether running agents can change accounts right away: through the host's own reopen, or the CLI. */
  private async canReopen(paseo: PaseoApi | null): Promise<boolean> {
    return hostCanReload(paseo) || (await this.reopener.locate()) !== null;
  }

  /** Agents with a live session: the given ones (looked up fresh), or every one. */
  private async liveAgents(paseo: PaseoApi, agentIds?: readonly string[]): Promise<AgentInfo[]> {
    const agents = agentIds
      ? (await Promise.all(agentIds.map((agentId) => agentInfo(paseo, agentId)))).filter((agent): agent is AgentInfo => agent !== null)
      : await this.cachedAgents(paseo);
    return agents.filter((agent) => !agent.archived && isLive(agent.status));
  }

  private cachedAgents(paseo: PaseoApi): Promise<AgentInfo[]> {
    if (this.agentCache && Date.now() - this.agentCache.at < AGENT_LIST_MS) return this.agentCache.agents;
    const agents = listAgents(paseo, false).then((result) => result.agents);
    this.agentCache = { at: Date.now(), agents };
    agents.catch(() => {
      this.agentCache = null;
    });
    return agents;
  }

  private async warnings(): Promise<string[]> {
    const warnings: string[] = [];
    const state = await this.store.read();
    for (const family of FAMILIES) {
      const availability = this.availability.get(family);
      // Pi is optional: it's only missed once an account of it was added.
      if (family === "pi" && !state.accounts.some((account) => account.family === "pi" && account.kind === "managed")) continue;
      if (availability && !availability.ok) {
        warnings.push(
          `${PROVIDER_NAME[family]} isn't installed where the daemon can run it${availability.detail ? ` (${availability.detail})` : ""}. Install it to add ${FAMILY_LABEL[family]} accounts.`,
        );
      }
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
      warnings.push(
        "The daemon's environment sets a Claude API key or token. Agents on your CLI login use it; agents on added accounts use their own sign-in.",
      );
    }
    if (process.env.CODEX_ACCESS_TOKEN) {
      warnings.push("The daemon's environment sets CODEX_ACCESS_TOKEN. Codex agents on your CLI login use it instead of a ChatGPT sign-in.");
    }
    if (!(await this.canReopen(this.paseo))) {
      warnings.push(
        "Paseo's command-line tool wasn't found, so running agents change accounts the next time their session starts instead of right away.",
      );
    }
    return warnings;
  }

  // ------------------------------------------------------------------ RPC: accounts

  /** Picks (or clears) the account the next new agent of its family starts on, for NEXT_PICK_MS. */
  async setNextAgent(accountId: string, enabled: boolean): Promise<{ until: string | null }> {
    const account = findAccount(await this.store.read(), accountId);
    if (!account) throw new Error("That account no longer exists.");
    if (enabled && !account.signedIn) throw new Error(`${account.label} is signed out. Sign it in first.`);
    if (enabled && account.disabled) throw new Error(`${account.label} is disabled. Enable it first.`);
    const until = enabled ? new Date(Date.now() + NEXT_PICK_MS).toISOString() : null;
    await this.store.update((draft) => {
      draft.nextAgent ??= { claude: null, codex: null, pi: null };
      if (enabled) draft.nextAgent[account.family] = { accountId: account.id, until: until! };
      else if (draft.nextAgent[account.family]?.accountId === account.id) draft.nextAgent[account.family] = null;
    });
    console.log(`[ZeroSub] next new ${account.family} agent: ${enabled ? account.label : "back to the default"}`);
    return { until };
  }

  /** Makes an account the default. Moving agents can outlast the RPC: see `answerBy`. */
  async setDefault(paseo: PaseoApi, accountId: string): Promise<ReopenSummary> {
    const replyBy = Date.now() + REPLY_WAIT_MS;
    this.attach(paseo);
    const account = findAccount(await this.store.read(), accountId);
    if (!account) throw new Error("That account no longer exists.");
    if (!account.signedIn) throw new Error(`${account.label} is signed out. Sign it in first.`);
    if (account.disabled) throw new Error(`${account.label} is disabled. Enable it before making it the default.`);
    const portable = this.adapters[account.family].portable;
    if (!portable) await this.pinThreads(paseo, account.family);
    // Conversations that can't move (Codex threads) are pinned, so this only moves portable ones.
    let agentIds: string[] | undefined;
    let previous: string | null = null;
    this.pinning += 1;
    try {
      await this.store.update((draft) => {
        previous = draft.defaults[account.family];
        draft.defaults[account.family] = account.id;
      });
      if (portable && !this.prefs.moveAgentsOnDefaultChange) {
        // The new default is for what comes next: open agents stay on the account they run on. If they
        // can't be kept, the old default comes back, or alignment would move them all to the new one.
        const { kept, moving } = await this.keepOpenAgents(paseo, account.family, account.id).catch(async (error: unknown) => {
          await this.store.update((draft) => {
            if (draft.defaults[account.family] === account.id) draft.defaults[account.family] = previous;
          });
          throw error;
        });
        console.log(`[ZeroSub] ${account.label} is the default now; ${kept} open agent(s) stay on their account`);
        // Agents that can't stay where they are move as they would with the switch on; nothing else does.
        agentIds = moving;
      }
    } finally {
      this.pinning -= 1;
    }
    if (agentIds?.length === 0) return emptySummary();
    const summary = emptySummary();
    return this.answerBy(replyBy, this.reconcile(paseo, "default", agentIds, undefined, { summary }), summary);
  }

  /**
   * Sets an account aside for a while, or brings it back. A disabled account stays signed in, but
   * nothing is routed to it: its agents move to the next account now (busy ones after their turn)
   * and return when it's enabled again. ChatGPT conversations can't change accounts, so the ones
   * already on it stay there; `stayed` counts them.
   */
  async setAccountEnabled(paseo: PaseoApi, accountId: string, enabled: boolean): Promise<ReopenSummary & { stayed: number }> {
    const replyBy = Date.now() + REPLY_WAIT_MS;
    this.attach(paseo);
    const state = await this.store.read();
    const account = findAccount(state, accountId);
    if (!account) throw new Error("That account no longer exists.");
    if (account.disabled === !enabled) return { ...emptySummary(), stayed: 0 };
    if (!enabled && account.family === "pi") {
      // No Pi account stands in for another (each may be billed), so a disabled one would still be used.
      throw new Error("Pi accounts can't be disabled. Make another one the default, or pick another for its agents, or remove it.");
    }
    if (!enabled && !mostAvailable(state, account.family, (id) => this.usage.get(id), Date.now(), new Set([account.id]))) {
      // Routing only stands in a usable account for a disabled one. Without one, its
      // agents and new ones would stay on it, or quietly fall back to the CLI login.
      const others = accountsOf(state, account.family).some((other) => other.id !== account.id && other.signedIn && !other.disabled);
      throw new Error(
        others
          ? `${account.label}'s agents would have nowhere to go: your other ${FAMILY_LABEL[account.family]} accounts are at their limit. Wait for one to reset, or add or enable another account first.`
          : `${account.label} is the only ${FAMILY_LABEL[account.family]} account in use. Add or enable another one first.`,
      );
    }
    await this.store.update((draft) => {
      const target = findAccount(draft, accountId);
      if (target) target.disabled = !enabled;
      if (target && !enabled) dropNextPick(draft, target);
    });
    console.log(`[ZeroSub] ${account.label} is ${enabled ? "enabled" : "disabled"}`);
    let stayed = 0;
    if (!enabled && !this.adapters[account.family].portable) {
      // Threads with history can't move, so they stay whatever reconciling does.
      const families = await this.families.resolve(paseo);
      const latest = await this.store.read();
      const agents = await listAgents(paseo, false).then(
        (result) => result.agents,
        (error: unknown) => {
          log(`could not count the ChatGPT conversations that stay on ${account.label}`, error);
          return [];
        },
      );
      stayed = agents.filter(
        (agent) =>
          families[agent.provider] === account.family &&
          agent.hasHistory &&
          this.targetFor(latest, agent.id, account.family, this.runningOn(latest, agent.id, account.family)) === accountId,
      ).length;
    }
    const summary = emptySummary();
    const moved = await this.answerBy(replyBy, this.reconcile(paseo, enabled ? "enabled" : "disabled", undefined, undefined, { summary }), summary);
    return { ...moved, stayed };
  }

  /**
   * Pins every existing agent of a non-portable provider to the account it runs on now, before the
   * default changes. Agents that haven't opened a session since ZeroSub was installed have no pin yet.
   */
  private async pinThreads(paseo: PaseoApi, family: Family): Promise<void> {
    const families = await this.families.resolve(paseo);
    const { agents } = await listAgents(paseo, true);
    const state = await this.store.read();
    const current = defaultAccount(state, family);
    const unpinned = agents.filter((agent) => families[agent.provider] === family && !state.bindings[agent.id]);
    if (!current || unpinned.length === 0) return;
    const at = new Date().toISOString();
    await this.store.update((draft) => {
      for (const agent of unpinned) {
        if (draft.bindings[agent.id]) continue;
        // A thread lives where its session ran: the CLI login when ZeroSub never routed it.
        draft.bindings[agent.id] = { accountId: this.runningOn(draft, agent.id, family) ?? current.id, source: "thread", at };
      }
    });
  }

  /**
   * Pins each open agent that follows the default to the account it runs on, so the new default
   * doesn't move it, now or when it next opens. Runs once the new default is in place, so an agent
   * that opened under the old one just before is kept too, even if its session was still being
   * routed. Agents already on the new default keep following it. An account that's gone, signed
   * out, disabled or at its limit is no place to keep work, so those agents come back in `moving`.
   */
  private async keepOpenAgents(
    paseo: PaseoApi,
    family: Family,
    newDefault: string,
  ): Promise<{ kept: number; moving: string[] }> {
    // A session being routed may have gone by the old default: let it record where it opens first.
    if (this.routing.size > 0) await withTimeout(Promise.allSettled(this.routing.keys()), ROUTING_WAIT_MS);
    const families = await this.families.resolve(paseo);
    const open = (await listAgents(paseo, false)).agents.filter(
      (agent) => families[agent.provider] === family && !agent.archived && isLive(agent.status),
    );
    let kept = 0;
    const moving: string[] = [];
    if (open.length === 0) return { kept, moving };
    const now = Date.now();
    const at = new Date(now).toISOString();
    await this.store.update((draft) => {
      // Where these open isn't recorded yet, and a session routed now goes by the new default.
      const routing = new Set(this.routing.values());
      for (const agent of open) {
        if (routing.has(agent.id)) continue;
        // An agent with an account of its own never followed the default.
        if (findAccount(draft, draft.bindings[agent.id]?.accountId)?.family === family) continue;
        // Still starting, and not routed yet: it will be, by the new default.
        if (agent.status === "initializing" && !draft.sessions[agent.id]) continue;
        const current = findAccount(draft, this.runningOn(draft, agent.id, family));
        if (!current || current.family !== family || !isUsable(current, now)) moving.push(agent.id);
        else if (current.id !== newDefault) {
          // "auto", like a limit switch, so the account button still offers "Follow default".
          draft.bindings[agent.id] = { accountId: current.id, source: "auto", at };
          kept += 1;
        }
      }
    });
    return { kept, moving };
  }

  async clearLimit(accountId: string): Promise<void> {
    const state = await this.store.update((draft) => {
      const account = findAccount(draft, accountId);
      if (!account) return;
      for (const slot of [account, ...sameSubscription(draft, account)]) {
        slot.limitedUntil = null;
        slot.limitKind = null;
      }
    });
    if (!findAccount(state, accountId)) throw new Error("That account no longer exists.");
    void this.refreshUsage(accountId, true).catch(() => undefined);
  }

  /**
   * Moves one agent to an account, or back to following the default. With automatic switching on,
   * an account at its limit is refused, since the agent would be moved straight off it. A failover
   * under way finishes first; the agent then moves to the account picked here.
   */
  async setAgentAccount(paseo: PaseoApi, agentId: string, accountId: string | null): Promise<ReopenSummary> {
    const replyBy = Date.now() + REPLY_WAIT_MS;
    this.attach(paseo);
    const info = await lookUpAgent(paseo, agentId);
    if (!info) throw new Error("That agent is no longer available.");
    const family = (await this.families.resolve(paseo))[info.provider];
    if (!family) throw new Error(`${info.provider} agents don't use Claude or ChatGPT subscription accounts.`);
    const adapter = this.adapters[family];
    const state = await this.store.read();
    const target = accountId ? findAccount(state, accountId) : defaultAccount(state, family);
    if (!target || target.family !== family) throw new Error("That account can't be used with this agent.");
    if (!target.signedIn) throw new Error(`${target.label} is signed out. Sign it in first.`);
    if (accountId && target.disabled) throw new Error(`${target.label} is disabled. Enable it in Accounts first.`);
    if (accountId && this.prefs.autoSwitch && isLimited(target, Date.now())) throw new Error(limitedPick(target.label));

    if (!adapter.portable) {
      if (info.status === "running" || info.status === "initializing") {
        throw new Error("This agent is working right now. Wait for its turn to finish, then switch.");
      }
      if (info.hasHistory) {
        const binding = state.bindings[agentId];
        const current = binding?.source === "thread" ? binding.accountId : this.runningOn(state, agentId, family);
        if (current === target.id) return emptySummary();
        const from = findAccount(state, current)?.label ?? null;
        const handoff = (async (): Promise<ReopenSummary> => {
          const continuation = await this.withSwitch(agentId, () => this.continueElsewhere(
            paseo,
            agentId,
            target,
            `you moved the work to your ChatGPT account "${target.label}"`,
            undefined,
            "user",
          ));
          await this.appendRow(paseo, agentId, {
            family,
            from,
            to: target.label,
            reason: "manual",
            resetsAt: null,
            continued: true,
            continuedIn: continuation,
            toFamily: null,
            outcome: "continued",
            detail: null,
            at: new Date().toISOString(),
          });
          return { ...emptySummary(), continuedIn: continuation };
        })();
        if (await settles(handoff, replyBy - Date.now())) return handoff;
        // Creating the other tab outlasts the RPC: it finishes in the background, and says if it can't.
        handoff.catch(async (error: unknown) => {
          log(`could not continue ${agentId} on ${target.label}`, error);
          await this.appendRow(paseo, agentId, {
            family,
            from,
            to: target.label,
            reason: "manual",
            resetsAt: null,
            continued: false,
            continuedIn: null,
            toFamily: null,
            outcome: "stayed",
            detail: `Couldn't continue on ${target.label}: ${describe(error)}`,
            at: new Date().toISOString(),
          });
        });
        return { ...emptySummary(), pending: [agentId] };
      }
    }

    await this.store.update((draft) => {
      if (accountId) draft.bindings[agentId] = { accountId, source: adapter.portable ? "user" : "thread", at: new Date().toISOString() };
      else delete draft.bindings[agentId];
    });
    const summary = emptySummary();
    return this.answerBy(replyBy, this.reconcile(paseo, "manual", [agentId], undefined, { summary }), summary);
  }

  async rename(accountId: string, label: string): Promise<void> {
    const state = await this.store.update((draft) => {
      const account = findAccount(draft, accountId);
      if (!account) return;
      account.label = label;
      account.autoLabel = false;
    });
    if (!findAccount(state, accountId)) throw new Error("That account no longer exists.");
    // A Pi account's script is named after it.
    await this.refreshLaunchers().catch((error: unknown) => log("could not write the Pi scripts", error));
  }

  /** Removes an account. Moving its agents can outlast the RPC: see `answerBy`. */
  async remove(paseo: PaseoApi, accountId: string): Promise<{ affected: number; moves: ReopenSummary }> {
    const replyBy = Date.now() + REPLY_WAIT_MS;
    this.attach(paseo);
    const state = await this.store.read();
    const account = findAccount(state, accountId);
    if (!account) throw new Error("That account no longer exists.");
    if (account.kind === "main") {
      throw new Error("Your CLI login can't be removed here. Sign out with `claude auth logout`, `codex logout` or Pi's /logout instead.");
    }
    if (!this.adapters[account.family].portable) {
      // These conversations can't move to another ChatGPT account, so removing theirs would strand them.
      const families = await this.families.resolve(paseo);
      const stranded = (await listAgents(paseo, false)).agents.filter(
        (agent) =>
          families[agent.provider] === account.family &&
          agent.hasHistory &&
          (state.bindings[agent.id]?.accountId ?? state.sessions[agent.id]?.accountId) === accountId,
      );
      if (stranded.length > 0) {
        const one = stranded.length === 1;
        throw new Error(
          `${stranded.length} ChatGPT conversation${one ? "" : "s"} still ${one ? "runs" : "run"} on ${account.label} and can't move to another account. Archive ${
            one ? "it" : "them"
          } (the work stays in your files) or continue ${one ? "it" : "them"} on another account from the account button, then remove ${account.label}.`,
        );
      }
    }
    const affected = Object.entries(state.sessions)
      .filter(([, session]) => session.accountId === accountId)
      .map(([agentId]) => agentId);
    // A home kept outside ZeroSub's own `homes/` (where added Pi accounts are kept) is the user's:
    // removing its account only takes it out of ZeroSub, and its folder, key and script stay.
    const kept = account.home !== null && account.family === "pi" && !(await isOwnHome(account.home));
    await this.store.update((draft) => {
      draft.accounts = draft.accounts.filter((entry) => entry.id !== accountId);
      if (account.home && !kept) draft.cleanup[account.home] = { family: account.family, accountId, why: "removed", at: new Date().toISOString() };
      for (const [agentId, binding] of Object.entries(draft.bindings)) {
        if (binding.accountId === accountId) delete draft.bindings[agentId];
      }
      if (draft.defaults[account.family] === accountId) draft.defaults[account.family] = null;
      dropNextPick(draft, account);
    });
    this.setUsage(accountId, null);
    this.egress.delete(accountId);
    if (account.home && kept) console.log(`[ZeroSub] removed ${account.label} from ZeroSub only: ${account.home} isn't in ${homesDir()}, so its files and script stay`);
    // Its script is released rather than deleted when its home stays (see writeLaunchers).
    await this.refreshLaunchers(account.home && !kept ? [account.home] : []).catch((error: unknown) => log("could not write the Pi scripts", error));
    // Idle agents move now and busy ones after their turn. The home is signed out and deleted by the
    // cleanup pass only once nothing runs on it any more.
    const summary = emptySummary();
    const moves = await this.answerBy(replyBy, this.reconcile(paseo, "removed", affected, new Map([[account.id, account.label]]), { summary }), summary);
    void this.cleanUpHomes(paseo).catch((error: unknown) => log("cleanup failed", error));
    return { affected: affected.length, moves };
  }

  // ------------------------------------------------------------------ Pi accounts

  /**
   * Whether `account` is still registered, asked with its home's lock held before anything is
   * written to it: a home whose account was removed meanwhile is never written to (or made again).
   */
  private stillHas(account: StoredAccount): () => Promise<boolean> {
    return async () => {
      const current = findAccount(await this.store.read(), account.id);
      return current !== undefined && current.home === account.home;
    };
  }

  /**
   * Where an account's home is right now. A move of it that's saved is followed (the registry read
   * may be from before it); one that isn't yet is left to give way to whatever asked.
   */
  private homeNow(account: StoredAccount): string | null {
    const run = this.moving.get(account.id);
    if (run?.committed && account.home === run.from) return run.to;
    const done = this.moved.get(account.id);
    if (done && account.home === done.from) return done.to;
    return account.home;
  }

  /**
   * Runs `work` on an account as it is now (see `homeNow`), counting it as a call on that home so
   * no move of it is saved under it (see `moveAccountHome`). Never waits for a move.
   */
  private async onAccount<T>(accountId: string, work: (account: StoredAccount | undefined) => Promise<T>): Promise<T> {
    const stored = findAccount(await this.store.read(), accountId);
    const home = stored ? this.homeNow(stored) : null;
    const account = stored && home !== stored.home ? { ...stored, home } : stored;
    if (home) this.homeCalls.set(home, (this.homeCalls.get(home) ?? 0) + 1);
    try {
      return await work(account);
    } finally {
      if (home) {
        const left = (this.homeCalls.get(home) ?? 1) - 1;
        if (left > 0) this.homeCalls.set(home, left);
        else this.homeCalls.delete(home);
      }
    }
  }

  /** Added Pi accounts, which each get a `pi-<account>.sh` script. */
  private launcherAccounts(state: StoredState): LauncherAccount[] {
    return state.accounts.flatMap((account) =>
      account.family === "pi" && account.kind === "managed" && account.home ? [{ id: account.id, label: account.label, home: account.home }] : [],
    );
  }

  /**
   * Rewrites the account scripts when the accounts or their names changed. A removed account's
   * script goes when its home does (`leaving`, or gone); one whose home stays is released to the user.
   * Nothing is written while no Pi account is added.
   */
  private async refreshLaunchers(leaving: readonly string[] = []): Promise<void> {
    // Only where Pi accounts are kept outside `homes/` (the real adapter; not test doubles).
    if (!this.adapters.pi.homesInUse) return;
    const state = await this.store.read();
    // A home that's moving keeps its account's script, rewritten for where it's gone.
    const moved = new Map(Object.values(state.moves).map((move) => [resolve(move.from), move.to]));
    this.launcherFiles = await writeLaunchers(this.launcherAccounts(state), piLauncherDir(), leaving, moved);
  }

  /**
   * Sets an account's proxy; an empty value clears it. Processes started afterwards use it. Pi's own
   * login's is kept in Pi's own settings, changed there only when asked to here.
   */
  async setProxy(accountId: string, input: string): Promise<string | null> {
    const { account, proxy } = await this.onAccount(accountId, async (account) => {
      if (!account) throw new Error("That account no longer exists.");
      const adapter = this.adapters[account.family];
      const main = account.kind === "main" && adapter.mainApi === true;
      if (!adapter.setProxy || !(main || (account.kind === "managed" && account.home))) throw new Error("A proxy can only be set for Pi accounts.");
      const proxy = input.trim() ? normalizeProxy(input) : null;
      if (main && proxy && proxy !== (await adapter.proxyState?.(null))?.own) await this.refuseClearTextFollowers(account.family);
      await adapter.setProxy(main ? null : account.home, proxy, this.stillHas(account));
      return { account, proxy };
    });
    if (account.kind === "main") await this.followMainSettings(account.family);
    else void this.checkEgress(account);
    return proxy ? maskProxy(proxy) : null;
  }

  /**
   * A new proxy on the CLI login is also every added account's without one of its own, so it's
   * refused while one of those sends its key over plain http:// through it: to this machine too,
   * unless the no-proxy list keeps it direct, since Pi adds nothing to that list for the login's
   * proxy (see `crossesInheritedProxy`).
   */
  private async refuseClearTextFollowers(family: Family): Promise<void> {
    const adapter = this.adapters[family];
    for (const account of accountsOf(await this.store.read(), family)) {
      const home = this.homeNow(account);
      if (account.kind !== "managed" || !home) continue;
      // Read as for an agent: while its folder is being moved its settings can't be read, and an
      // account read as having no key or proxy would pass unchecked.
      const settings = await readPiAccountForAgents(home).catch(() => null);
      if (!settings) throw new Error(`${account.label}'s folder is being moved just now. Try again in a moment.`);
      const { key, baseUrl, proxy } = settings;
      if (proxy) continue;
      if (key && crossesInheritedProxy(baseUrl)) {
        throw new Error(
          `${account.label} has no proxy of its own and sends its key over plain http:// to ${baseUrl}, so this proxy could read it. Give ${account.label} its key again with an https:// base URL, or a proxy of its own, first.`,
        );
      }
    }
  }

  /**
   * Remakes the added homes' files from the CLI login's, which just changed (its proxy goes to every
   * added account without one of its own), and checks where those accounts' requests come from now.
   */
  private async followMainSettings(family: Family): Promise<void> {
    const adapter = this.adapters[family];
    for (const account of accountsOf(await this.store.read(), family)) {
      if (account.kind !== "managed" || !account.home || this.moving.has(account.id)) continue;
      await adapter.prepareHome(account.home, this.stillHas(account)).catch((error: unknown) => log(`could not refresh the home of ${account.label}`, error));
      const proxy = await adapter.proxyState?.(account.home).catch(() => null);
      if (proxy?.own === null) void this.checkEgress(account);
    }
  }

  /**
   * Checks where an added account's requests come from; a failed check keeps the last address it
   * saw. The CLI login is never checked, so nothing is sent while no account is added.
   */
  private async checkEgress(account: StoredAccount): Promise<void> {
    const adapter = this.adapters[account.family];
    if (!adapter.egress || account.kind !== "managed" || !account.home || !account.signedIn) return;
    this.egressCheckedAt.set(account.id, Date.now());
    const checkedAt = new Date().toISOString();
    try {
      const seen = await this.onAccount(account.id, async (current) => (current?.home ? adapter.egress!(current.home) : null));
      if (seen) this.egress.set(account.id, { ...seen, checkedAt, error: null });
      else this.egress.delete(account.id);
    } catch (error) {
      const last = this.egress.get(account.id);
      this.egress.set(account.id, {
        ip: last?.ip ?? null,
        country: last?.country ?? null,
        checkedAt: last?.checkedAt ?? null,
        error: describe(error),
      });
    }
  }

  /**
   * Adds a Pi account: an Anthropic API key, optionally sent to another base URL, with an optional
   * proxy. Set up in `homes/`, then moved to where Pi accounts are kept (see `placeHomes`).
   */
  async addApiAccount(input: { label: string; key: string; baseUrl?: string; proxy?: string }): Promise<string> {
    const adapter = this.adapters.pi;
    if (!adapter.setApi) throw new Error("API accounts aren't supported here.");
    const baseUrl = input.baseUrl?.trim() ? normalizeBaseUrl(input.baseUrl) : null;
    const proxy = input.proxy?.trim() ? normalizeProxy(input.proxy) : null;
    const key = input.key.trim();
    if (!key) throw new Error("Enter the API key.");
    const identity = apiIdentity(baseUrl, keyDigest(key));
    const duplicate = accountsOf(await this.store.read(), "pi").find((account) => account.identity === identity);
    if (duplicate) throw new Error(`That key is already added as "${duplicate.label}".`);

    // A managed account's ID matches its home's folder name, as its cleanup entry does.
    const id = `pi-${randomBytes(6).toString("hex")}`;
    const home = join(homesDir(), id);
    this.creatingHomes.add(home);
    try {
      // On the cleanup list until the account is saved, so a home left half made is cleaned up even
      // after a restart. While it's being made, cleanup leaves it alone.
      await this.store.update((draft) => {
        draft.cleanup[home] = { family: "pi", accountId: id, why: "unfinished", at: new Date().toISOString() };
      });
      if (proxy) await adapter.setProxy?.(home, proxy);
      await adapter.setApi(home, { key, baseUrl });
      await adapter.prepareHome(home);
      await this.store.update((draft) => {
        // Checked again here too: another add of the same key may have finished meanwhile.
        const twin = accountsOf(draft, "pi").find((entry) => entry.identity === identity);
        if (twin) throw new Error(`That key is already added as "${twin.label}".`);
        const account = newAccount({ id, family: "pi", kind: "managed", home, auth: "api" });
        account.label = input.label.trim();
        account.autoLabel = false;
        account.identity = identity;
        draft.accounts.push(account);
        delete draft.cleanup[home];
      });
    } catch (error) {
      // Gone now, or left on the cleanup list for a later pass.
      const removed = await removeHome(home).then(
        () => true,
        () => false,
      );
      if (removed) await this.store.update((draft) => void delete draft.cleanup[home]).catch(() => undefined);
      throw error;
    } finally {
      this.creatingHomes.delete(home);
    }
    await this.placeHomes().catch((error: unknown) => log("moving accounts' homes failed", error));
    await this.refreshLaunchers().catch((error: unknown) => log("could not write the Pi scripts", error));
    const added = findAccount(await this.store.read(), id);
    if (added) void this.checkEgress(added);
    return id;
  }

  /** Changes a Pi account's key (empty keeps it) or base URL; Pi's own login's too, when asked to here. */
  async updateApiAccount(accountId: string, input: { key?: string; baseUrl?: string }): Promise<void> {
    await this.onAccount(accountId, async (account) => {
      if (!account) throw new Error("That account no longer exists.");
      const adapter = this.adapters[account.family];
      const key = input.key?.trim() || null;
      const baseUrl = input.baseUrl?.trim() ? normalizeBaseUrl(input.baseUrl) : null;
      // Pi's own login keeps its key in Pi's own files, which the adapter changes in place.
      if (account.kind === "main" && adapter.mainApi && adapter.setApi) {
        await adapter.setApi(null, { key, baseUrl });
        await this.followMainSettings(account.family);
        return;
      }
      if (account.auth !== "api" || !account.home || !adapter.setApi) throw new Error(`${account.label} signs in with a subscription, not an API key.`);
      // A kept key stays on its base URL (the adapter refuses to move it), so its identity holds.
      const identity = key ? apiIdentity(baseUrl, keyDigest(key)) : null;
      if (identity) {
        const duplicate = accountsOf(await this.store.read(), account.family).find((entry) => entry.id !== account.id && entry.identity === identity);
        if (duplicate) throw new Error(`That key is already added as "${duplicate.label}".`);
      }
      await adapter.setApi(account.home, { key, baseUrl }, this.stillHas(account));
      await this.store.update((draft) => {
        const target = findAccount(draft, accountId);
        if (!target) return;
        if (!identity) return;
        target.identity = identity;
        // A new key is worth trying again even if the old one had been refused.
        target.signedIn = true;
      });
    });
    const account = findAccount(await this.store.read(), accountId);
    if (account) void this.checkEgress(account);
  }

  /**
   * Adds back a Pi account from its folder, which ZeroSub set up and kept when the account was
   * removed (outside `homes/`, removing one only unregisters it): its key, base URL and proxy are
   * still in its `zerosub.json`. The folder stays where it is, unless it's in `homes/` or a folder
   * picked before, which it moves out of like any account's. Its name is the folder's.
   */
  async importPiAccount(input: string): Promise<string> {
    const home = await chooseImportedPiHome(input, (await this.store.read()).accounts);
    const shown = shownPath(home);
    const { key, baseUrl, proxy } = await readPiAccount(home);
    if (!key) throw new Error(`${shown} has no API key in its zerosub.json. Add a new account with its API key instead.`);
    // As for a new proxy on the CLI login (see `refuseClearTextFollowers`): without a proxy of its own it
    // would go through the one it inherits, which could read a key sent over plain http://, to this
    // machine too (`inherited` is null where the no-proxy list keeps the base URL direct).
    if (!proxy && plainHttp(baseUrl)) {
      const inherited = (await this.adapters.pi.proxyState?.(home))?.inherited;
      if (inherited) {
        throw new Error(
          `${shown} sends its key over plain http:// to ${baseUrl} and has no proxy of its own, so it would go through ${maskProxy(inherited.proxy)} (${inherited.from}), which could read it. Add it as a new account with its key instead.`,
        );
      }
    }
    const identity = apiIdentity(baseUrl, keyDigest(key));
    let account: StoredAccount | undefined;
    await this.store.update((draft) => {
      if (draft.accounts.some((entry) => entry.home && resolve(entry.home) === home)) throw new Error(`${shown} is already added.`);
      const duplicate = accountsOf(draft, "pi").find((entry) => entry.identity === identity);
      if (duplicate) throw new Error(`That key is already added as "${duplicate.label}".`);
      const name = basename(home);
      const id = inHomesDir(home) && /^pi-[0-9a-f]{12}$/.test(name) && !findAccount(draft, name) ? name : `pi-${randomBytes(6).toString("hex")}`;
      account = newAccount({ id, family: "pi", kind: "managed", home, auth: "api" });
      account.label = name.slice(0, 40);
      account.autoLabel = false;
      account.identity = identity;
      draft.accounts.push(account);
      // A folder in `homes/` waiting to be cleaned up is an account's again.
      delete draft.cleanup[home];
    });
    const added = account!;
    await this.adapters.pi.prepareHome(home, this.stillHas(added)).catch((error: unknown) => log(`could not refresh the home of ${added.label}`, error));
    console.log(`[ZeroSub] added the Pi account in ${home} back as ${added.label}`);
    await this.placeHomes().catch((error: unknown) => log("moving accounts' homes failed", error));
    await this.refreshLaunchers().catch((error: unknown) => log("could not write the Pi scripts", error));
    void this.checkEgress(added);
    return added.id;
  }

  /**
   * Changes the folder added Pi accounts' homes are kept in (empty: the default, `~/.pi-config`).
   * New accounts go there, and the accounts in the folder it replaces, or still in ZeroSub's
   * `homes/`, move there one at a time as nothing runs on them (see `placeHomes`). Returns the
   * folder as shown, and how many accounts are due to move.
   */
  async setPiHomesDir(input: string): Promise<{ dir: string; moving: number }> {
    const state = await this.store.read();
    const chosen = await choosePiHomesDir(input, state.accounts);
    const previous = resolve(piHomesDir(state.piHomes));
    const updated = await this.store.update((draft) => {
      const from = new Set(draft.piHomes.from.map((folder) => resolve(folder)));
      from.add(previous);
      from.delete(resolve(piHomesDir({ dir: chosen, from: [] })));
      draft.piHomes = { dir: chosen, from: [...from] };
    });
    this.moveNotes.clear();
    const dir = piHomesDir(updated.piHomes);
    console.log(`[ZeroSub] added Pi accounts' homes are kept in ${dir} now`);
    void this.placeHomes().catch((error: unknown) => log("moving accounts' homes failed", error));
    return { dir: shownPath(dir), moving: (await this.dueMoves(updated)).length };
  }

  /**
   * Moves added Pi accounts' homes to the folder they're kept in (see `piHomesDir`): a new account's
   * from ZeroSub's own `homes/`, where it was set up, and every account's from a folder picked
   * before. Moves cut short (the plugin stopped halfway) are finished first. Each home moves only
   * while nothing runs on it (see `moveAccountHome`); one in use waits for a later pass, and the app
   * says why. One pass at a time; a call during one gets that one.
   */

  /**
   * Moves added Pi accounts' homes to the folder they're kept in (see `piHomesDir`): a new account's
   * from ZeroSub's own `homes/`, where it was set up, and every account's from a folder picked
   * before. Moves cut short (the plugin stopped halfway) are finished first. Each home moves only
   * while nothing runs on it (see `moveAccountHome`); one in use waits for a later pass, and the app
   * says why. One pass at a time; a call during one gets that one.
   */
  placeHomes(): Promise<void> {
    this.placing ??= this.placePass().finally(() => {
      this.placing = null;
    });
    return this.placing;
  }

  private async placePass(): Promise<void> {
    const adapter = this.adapters.pi;
    if (!adapter.homesInUse) return;
    for (const [accountId, move] of Object.entries((await this.store.read()).moves)) {
      await this.finishMove(accountId, move).catch((error: unknown) => {
        this.moveNotes.set(accountId, { waiting: null, error: describe(error) });
        log(`could not finish moving ${move.from} to ${move.to}`, error);
      });
    }
    const state = await this.store.read();
    const due = await this.dueMoves(state);
    for (const accountId of this.moveNotes.keys()) {
      if (!due.some((account) => account.id === accountId) && !state.moves[accountId]) this.moveNotes.delete(accountId);
    }
    if (due.length === 0) return this.forgetEmptiedFolders(state);
    let inUse: Set<string>;
    try {
      inUse = await adapter.homesInUse(due.map((account) => account.home));
    } catch (error) {
      for (const account of due) this.moveNotes.set(account.id, { waiting: null, error: `ZeroSub couldn't tell whether anything runs on it: ${describe(error)}` });
      return;
    }
    const dir = piHomesDir(state.piHomes);
    const taken = new Set(state.accounts.flatMap((account) => (account.home ? [resolve(account.home)] : [])));
    let moved = false;
    for (const account of due) {
      const waiting = this.moveBlocker(account, inUse);
      if (waiting) {
        this.moveNotes.set(account.id, { waiting, error: null });
        continue;
      }
      const to = await placeFor(account, dir, taken);
      taken.add(resolve(to));
      try {
        if (await this.moveAccountHome(account, to)) moved = true;
      } catch (error) {
        this.moveNotes.set(account.id, { waiting: null, error: describe(error) });
        log(`could not move the home of ${account.label} to ${to}`, error);
      }
    }
    if (moved) await this.refreshLaunchers().catch((error: unknown) => log("could not write the Pi scripts", error));
  }

  /**
   * Added Pi accounts whose homes are due to move: a folder of their own (a link stays where it
   * points) in ZeroSub's `homes/` or a folder picked before, and no move of theirs under way.
   */
  private async dueMoves(state: StoredState): Promise<Array<StoredAccount & { home: string }>> {
    if (!this.adapters.pi.homesInUse) return [];
    const dir = resolve(piHomesDir(state.piHomes));
    const sources = new Set([homesDir(), ...state.piHomes.from].map((folder) => resolve(folder)));
    const due: Array<StoredAccount & { home: string }> = [];
    for (const account of accountsOf(state, "pi")) {
      const home = account.home;
      if (account.kind !== "managed" || !home || state.moves[account.id]) continue;
      const folder = dirname(resolve(home));
      if (folder === dir || !sources.has(folder)) continue;
      if ((await lstat(home).catch(() => null))?.isDirectory()) due.push({ ...account, home });
    }
    return due;
  }

  /** Why an account's home can't move just now, or null when it can. */
  private moveBlocker(account: StoredAccount & { home: string }, inUse: ReadonlySet<string>): string | null {
    const { home } = account;
    if (this.creatingHomes.has(home)) return "it's being set up";
    if (inUse.has(home)) return "Pi runs on it (an agent or a terminal); it moves once that stops";
    if ((this.homeCalls.get(home) ?? 0) > 0) return "ZeroSub is working on it";
    if (Date.now() - (this.routedAt.get(account.id) ?? 0) < ROUTED_SETTLE_MS) return "an agent has just started on it";
    return null;
  }

  /**
   * Moves an account's home to `to`, once nothing runs on it. Nothing waits for the move: a session
   * routed to the home, or a call of ZeroSub's on it, while the folder is being moved makes the move
   * give way (the folder goes back, and it's tried at a later pass), and once the move is saved
   * they're given the new folder (see `homeNow`). The move is written down first (`moves`), so one
   * cut short is finished or undone at the next pass (see `finishMove`). Everything a Pi account has
   * is in its folder, so the folder is all that moves. False when it had to wait after all.
   */
  private async moveAccountHome(account: StoredAccount & { home: string }, to: string): Promise<boolean> {
    const from = account.home;
    const homesInUse = (homes: readonly string[]) => this.adapters.pi.homesInUse!(homes);
    const waiting = this.moveBlocker(account, await homesInUse([from]));
    if (waiting) {
      this.moveNotes.set(account.id, { waiting, error: null });
      return false;
    }
    const startedAt = Date.now();
    const move: Move = { from, to, at: new Date(startedAt).toISOString() };
    const run: HomeMove = { from, to, committed: false };
    this.moving.set(account.id, run);
    try {
      await this.store.update((draft) => void (draft.moves[account.id] = move));
      try {
        await moveHome(from, to, async () => {
          // Checked again once the folder is there: anything that started on it meanwhile keeps it.
          const started = (await homesInUse([from])).has(from)
            ? "Pi started on it (an agent or a terminal); it moves once that stops"
            : (this.homeCalls.get(from) ?? 0) > 0
              ? "ZeroSub is working on it"
              : (this.routedAt.get(account.id) ?? 0) >= startedAt
                ? "an agent has just started on it"
                : null;
          if (started) throw new MoveGaveWay(started);
          run.committed = true;
          try {
            await this.store.update((draft) => {
              const target = findAccount(draft, account.id);
              if (target?.home !== from) throw new Error(`${account.label} was removed or changed while its home was moving`);
              target.home = to;
            });
          } catch (error) {
            run.committed = false;
            throw error;
          }
        });
      } catch (error) {
        // Still where it was: the record goes. Otherwise it stays, for `finishMove` to sort out.
        const back = (await lstat(from).catch(() => null))?.isDirectory() && !(await lstat(to).catch(() => null));
        if (back) await this.store.update((draft) => void delete draft.moves[account.id]).catch(() => undefined);
        if (!(error instanceof MoveGaveWay)) throw error;
        this.moveNotes.set(account.id, { waiting: error.message, error: null });
        return false;
      }
      this.moved.set(account.id, { from, to });
    } finally {
      this.moving.delete(account.id);
    }
    await this.finishMove(account.id, move);
    return true;
  }

  /**
   * Finishes a recorded move of an account's home. Cut short before the folder moved: the move is
   * tried again. After the folder moved but before the account's new home was saved: it's saved now.
   * Both folders there before it's saved: the account goes with the one that has its key
   * (`zerosub.json`). Only the new one has it when Pi made the old folder again while the move was
   * checking for Pi (a terminal with the old script, say), so the folder couldn't go back: the move is
   * finished, and the old folder left alone. Otherwise, and when neither folder is there, it's left as
   * it is for the user, and the app says so, never asking to delete the folder with the key. The old
   * folder still there after (a copy onto another disk not cleaned up) is left alone, and logged. The
   * account's script is rewritten for the new home before the record goes.
   */
  private async finishMove(accountId: string, move: Move): Promise<void> {
    const forget = () => this.store.update((draft) => void delete draft.moves[accountId]);
    let account = findAccount(await this.store.read(), accountId);
    const folder = async (path: string) => (await lstat(path).catch(() => null))?.isDirectory() === true;
    const [atFrom, atTo] = [await folder(move.from), await folder(move.to)];
    if (account?.home === move.from) {
      if (atFrom && !atTo) {
        await forget();
        return;
      }
      const keyed = async (path: string) => (await lstat(join(path, PI_ACCOUNT_FILE)).catch(() => null))?.isFile() === true;
      const [keyFrom, keyTo] = atFrom && atTo ? [await keyed(move.from), await keyed(move.to)] : [false, false];
      if (atFrom && atTo && keyTo && !keyFrom) {
        console.log(`[ZeroSub] ${move.from} was made again while ${account.label} moved to ${move.to}, which has its key; finishing the move and leaving ${move.from} alone (delete it yourself)`);
      } else if (atFrom || !atTo) {
        throw new Error(
          !atFrom
            ? `ZeroSub stopped while moving ${shownPath(move.from)} to ${shownPath(move.to)}, and neither is there now.`
            : keyFrom
              ? `ZeroSub stopped while copying ${shownPath(move.from)} to ${shownPath(move.to)} on another disk, and both are there now. The account still uses ${shownPath(move.from)}: delete ${shownPath(move.to)}, and the move starts again at ZeroSub's next check.`
              : `Both ${shownPath(move.from)} and ${shownPath(move.to)} are there, and neither has the account's key (${PI_ACCOUNT_FILE}). Enter its key again from its card.`,
        );
      }
      await this.store.update((draft) => {
        const target = findAccount(draft, accountId);
        if (target?.home === move.from) target.home = move.to;
      });
      account = findAccount(await this.store.read(), accountId);
    }
    // While the move is still on record, so the account's script is rewritten, not released.
    if (account?.home === move.to) await this.refreshLaunchers();
    await forget();
    this.moveNotes.delete(accountId);
    if (account?.home === move.to && atFrom) {
      console.log(`[ZeroSub] ${move.from} is still there after ${account.label} moved to ${move.to}; it's an old copy, left alone (delete it yourself)`);
    }
    if (account?.home === move.to) console.log(`[ZeroSub] moved the home of ${account.label} from ${move.from} to ${move.to}`);
  }

  /** Stops moving accounts out of folders picked before once none of theirs is left there. */
  private async forgetEmptiedFolders(state: StoredState): Promise<void> {
    const used = (folder: string) =>
      state.accounts.some((account) => account.home && dirname(resolve(account.home)) === resolve(folder)) ||
      Object.values(state.moves).some((move) => dirname(resolve(move.from)) === resolve(folder));
    if (state.piHomes.from.every(used)) return;
    await this.store.update((draft) => {
      draft.piHomes.from = draft.piHomes.from.filter(used);
    });
  }

  // ------------------------------------------------------------------ RPC: sign-in

  startLogin(family: Family, method: LoginMethod, accountId?: string): Promise<LoginView> {
    return this.loginLocks[family].run(() => this.beginLogin(family, method, accountId));
  }

  private async beginLogin(family: Family, method: LoginMethod, accountId?: string): Promise<LoginView> {
    // Pi's added accounts are API keys, and its own login signs in inside Pi.
    if (family === "pi") throw new Error("Pi accounts use an Anthropic API key: add one with Add account, or change its key from its card. Sign Pi's own login in with /login inside Pi.");
    let availability = this.availability.get(family);
    if (!availability?.ok) {
      await this.ensureFamily(family);
      availability = this.availability.get(family);
    }
    if (!availability?.ok) throw new Error(`${PROVIDER_NAME[family]} isn't installed on the daemon machine.`);
    // One flow per provider at a time (Codex's browser sign-in uses a fixed local port).
    for (const login of this.logins.values()) {
      if (login.family === family && !login.finishedAt) await this.cancelLogin(login.id);
    }
    const state = await this.store.read();
    const existing = accountId ? findAccount(state, accountId) : undefined;
    if (accountId && (!existing || existing.family !== family)) throw new Error("That account no longer exists.");

    const id = randomBytes(6).toString("hex");
    const home = existing ? existing.home : join(homesDir(), `${family}-${id}`);
    const session: LoginSession = {
      id,
      family,
      accountId: existing?.id ?? null,
      home,
      handle: null,
      finishedAt: null,
      saving: false,
      view: {
        id,
        family,
        method,
        accountId: existing?.id ?? null,
        step: "starting",
        url: null,
        codeUrl: null,
        userCode: null,
        message: null,
        startedAt: new Date().toISOString(),
      },
    };
    this.logins.set(id, session);
    try {
      if (!existing && home) {
        // On the cleanup list until the account is saved, so an abandoned sign-in is cleaned up even
        // after a restart. While this run tracks the sign-in, cleanup leaves it alone.
        await this.store.update((draft) => {
          draft.cleanup[home] = { family, accountId: `${family}-${id}`, why: "unfinished", at: new Date().toISOString() };
        });
      }
      if (home) await this.adapters[family].prepareHome(home);
      const handle = await this.adapters[family].login(home, method);
      if (session.finishedAt) {
        handle.cancel();
        return session.view;
      }
      session.handle = handle;
      const sync = () => {
        if (!session.finishedAt) session.view = { ...session.view, ...handle.progress };
      };
      handle.onProgress(sync);
      sync();
      void handle.finished
        .then((result) => this.finishLogin(session, result))
        .catch((error: unknown) => this.failLogin(session, describe(error)));
    } catch (error) {
      this.failLogin(session, describe(error));
    }
    return session.view;
  }

  async submitCode(loginId: string, code: string): Promise<LoginView> {
    const session = this.logins.get(loginId);
    if (!session?.handle) throw new Error("This sign-in has expired. Start again.");
    if (!session.finishedAt) await session.handle.submitCode(code);
    return session.view;
  }

  async cancelLogin(loginId: string): Promise<LoginView | null> {
    const session = this.logins.get(loginId);
    if (!session) return null;
    if (!session.finishedAt) {
      session.finishedAt = Date.now();
      session.handle?.cancel();
      session.view = { ...session.view, step: "canceled", message: "Sign-in was canceled." };
      this.scheduleCleanup();
    }
    return session.view;
  }

  private async finishLogin(session: LoginSession, result: { ok: boolean; message: string | null }): Promise<void> {
    if (session.finishedAt) return;
    if (!result.ok) return this.failLogin(session, result.message ?? "Sign-in did not finish.");
    session.view = { ...session.view, step: "verifying", message: null };
    const adapter = this.adapters[session.family];
    const identity = await adapter.identity(session.home).catch(() => null);
    if (session.finishedAt) return; // Canceled while verifying.
    if (!identity?.signedIn) return this.failLogin(session, "Sign-in finished, but the account isn't signed in. Try again.");

    const state = await this.store.read();
    const existing = findAccount(state, session.accountId);
    if (existing?.kind === "managed" && existing.identity && identity.identity && !sameAccountIdentity(session.family, existing, identity)) {
      // Signing an account back in must not quietly turn it into a different login.
      if (session.home) await adapter.logout(session.home).catch(() => undefined);
      const expected = existing.email ?? existing.label;
      // Only a Codex key can come without the email, and then it doesn't say which member signed in.
      return this.failLogin(
        session,
        identity.email
          ? `You signed in as ${identity.email}, but this is ${expected}. Sign in as ${expected}, or use Add account for the other one.`
          : `Couldn't tell which workspace member signed in, because Codex didn't return an email. Sign in again as ${expected}.`,
      );
    }
    // The CLI's own login is whatever the user signs it into; only added accounts must be distinct.
    const duplicate =
      identity.identity && existing?.kind !== "main"
        ? accountsOf(state, session.family).find(
            (account) => account.id !== session.accountId && sameAccountIdentity(session.family, account, identity, true),
          )
        : undefined;
    if (duplicate) {
      if (!existing && session.home) await adapter.logout(session.home).catch(() => undefined);
      return this.failLogin(
        session,
        `${identity.email ?? "That account"} is already added as "${duplicate.label}". Sign in with a different account.`,
      );
    }
    if (session.finishedAt) return;
    session.finishedAt = Date.now(); // Claim completion before writing, so a late cancel can't race it.

    let accountId = session.accountId;
    let handedOver = false;
    session.saving = true;
    try {
      await this.store.update((draft) => {
        let account = findAccount(draft, accountId);
        if (!account) {
          // A managed account's ID matches its home's folder name, as its cleanup entry does.
          accountId = `${session.family}-${session.id}`;
          account = newAccount({ id: accountId, family: session.family, kind: "managed", home: session.home });
          draft.accounts.push(account);
          if (session.home) delete draft.cleanup[session.home];
        }
        // Cleared first, so a limit the account brings from another slot (see applyIdentity) stands.
        account.limitedUntil = null;
        account.limitKind = null;
        handedOver = applyIdentity(account, identity, draft);
      });
    } catch (error) {
      // A new account's home is then cleaned up as an unfinished sign-in, like any that failed.
      log("could not save the account just signed in", error);
      session.view = { ...session.view, step: "failed", message: `Signed in, but ZeroSub couldn't save the account: ${describe(error)}` };
      this.scheduleCleanup();
      return;
    } finally {
      session.saving = false;
    }
    if (accountId) this.identityCheckedAt.set(accountId, Date.now());
    if (accountId && handedOver) this.forgetReading(accountId);
    session.accountId = accountId;
    session.view = { ...session.view, step: "done", accountId, message: null };
    if (accountId) void this.refreshUsage(accountId, true).catch(() => undefined);
  }

  private failLogin(session: LoginSession, message: string): void {
    if (session.finishedAt) return;
    session.finishedAt = Date.now();
    session.handle?.cancel();
    session.view = { ...session.view, step: "failed", message };
    this.scheduleCleanup();
  }
}

// -------------------------------------------------------------------- helpers

/** What tells an API key's account from another: where the key goes, and a short hash of the key. */
function apiIdentity(baseUrl: string | null, digest: string): string {
  return `api|${baseUrl ?? "anthropic"}|${digest}`;
}

function keyDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function newAccount(fields: Pick<StoredAccount, "id" | "family" | "kind" | "home"> & Partial<Pick<StoredAccount, "auth">>): StoredAccount {
  return {
    auth: "subscription",
    ...fields,
    label: "",
    autoLabel: true,
    email: null,
    plan: null,
    organization: null,
    identity: null,
    signedIn: true,
    disabled: false,
    limitedUntil: null,
    limitKind: null,
    limitedAt: null,
    createdAt: new Date().toISOString(),
  };
}

type Limit = Pick<StoredAccount, "limitedUntil" | "limitKind" | "limitedAt" | "limitSource">;

/** The other accounts signed into the same subscription (and so sharing its quota). */
function sameSubscription(state: StoredState, account: StoredAccount): StoredAccount[] {
  return accountsOf(state, account.family).filter((other) => other.id !== account.id && sameAccountIdentity(account.family, other, account));
}

/** Returns true when the CLI login's account was replaced by a different one, which drops what the slot knew of the old one's limit. */
function applyIdentity(account: StoredAccount, identity: Identity, state: StoredState): boolean {
  const handedOver = account.kind === "main" && identity.signedIn && !!account.identity && !!identity.identity && !sameAccountIdentity(account.family, account, identity);
  applyIdentityFields(account, identity, state);
  if (!handedOver) return false;
  account.limitedUntil = null;
  account.limitKind = null;
  account.limitedAt = null;
  account.limitSource = undefined;
  const now = Date.now();
  const limited = sameSubscription(state, account).find((other) => isLimited(other, now));
  if (limited) {
    const { limitedUntil, limitKind, limitedAt, limitSource } = limited;
    Object.assign(account, { limitedUntil, limitKind, limitedAt, limitSource });
  }
  return true;
}

function applyIdentityFields(account: StoredAccount, identity: Identity, state: StoredState): void {
  account.signedIn = identity.signedIn;
  if (!identity.signedIn) {
    dropNextPick(state, account);
    return;
  }
  // A key read without its workspace says less than the one stored for the same person, which stays.
  const vaguer = withoutWorkspace(identity.identity) && !withoutWorkspace(account.identity) && sameAccountIdentity(account.family, account, identity);
  account.email = identity.email ?? account.email;
  account.plan = identity.plan ?? account.plan;
  account.organization = identity.organization ?? account.organization;
  if (!vaguer) account.identity = identity.identity ?? account.identity;
  // An identity without an email (Pi's) has nothing better to call an account that has a name.
  if ((account.autoLabel && (identity.email || !account.label)) || !account.label) {
    account.label = suggestLabel(account, state);
    account.autoLabel = true;
  }
}

/** "work" for work@acme.com, or the full address when another account would read the same. */
export function suggestLabel(account: StoredAccount, state: StoredState): string {
  const others = accountsOf(state, account.family).filter((entry) => entry.id !== account.id);
  if (account.email) {
    const local = account.email.split("@")[0] ?? account.email;
    const clash = others.some(
      (entry) => entry.label.toLowerCase() === local.toLowerCase() || entry.email?.split("@")[0]?.toLowerCase() === local.toLowerCase(),
    );
    return clash ? account.email : local;
  }
  const base = FAMILY_LABEL[account.family];
  let index = others.length + 1;
  while (others.some((entry) => entry.label === `${base} ${index}`)) index += 1;
  return `${base} ${index}`;
}

type AgentSnapshot = Awaited<ReturnType<PaseoApi["agents"]["list"]>>["entries"][number]["agent"];

function toAgentInfo(agent: AgentSnapshot): AgentInfo {
  return {
    id: agent.id,
    provider: agent.provider,
    status: agent.status,
    archived: Boolean(agent.archivedAt),
    hasHistory: Boolean(agent.lastUserMessageAt),
    title: agent.title ?? null,
    continuedFrom: agent.labels?.[CONTINUED_FROM_LABEL] ?? null,
    lastMessageAt: Date.parse(agent.lastUserMessageAt ?? "") || 0,
    backgroundWork: (agent as { backgroundWork?: { count?: number } }).backgroundWork?.count ?? 0,
  };
}

/** The agent, or null once Paseo says it doesn't know it. A lookup that fails throws. */
async function lookUpAgent(paseo: PaseoApi, agentId: string): Promise<AgentInfo | null> {
  const agent = (await paseo.agents.ref(agentId).refresh())?.agent;
  return agent ? toAgentInfo(agent) : null;
}

/** The agent, or null when it's gone or can't be looked up: for callers that then leave it alone. */
async function agentInfo(paseo: PaseoApi, agentId: string): Promise<AgentInfo | null> {
  return lookUpAgent(paseo, agentId).catch(() => null);
}

function unchecked(error: unknown): ReopenResult {
  return { outcome: "failed", error: `Paseo couldn't say what the agent is doing (${describe(error)})`, timedOut: false, unchecked: true };
}

const MAX_PAGES = 100;

async function listAgents(paseo: PaseoApi, includeArchived: boolean): Promise<{ agents: AgentInfo[]; complete: boolean }> {
  const agents: AgentInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await paseo.agents.list({
      ...(includeArchived ? { filter: { includeArchived: true } } : {}),
      page: { limit: 200, ...(cursor ? { cursor } : {}) },
    });
    for (const { agent } of result.entries) agents.push(toAgentInfo(agent));
    if (!result.pageInfo.hasMore || !result.pageInfo.nextCursor) return { agents, complete: true };
    cursor = result.pageInfo.nextCursor;
  }
  return { agents, complete: false };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(task: Promise<unknown>, ms: number): Promise<void> {
  await Promise.race([task.catch(() => undefined), delay(ms)]);
}

/** Whether `task` settles within `ms`. A rejection then is the caller's to read from `task`. */
async function settles(task: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, ms));
  });
  try {
    return await Promise.race([task.then(() => true, () => true), late]);
  } finally {
    clearTimeout(timer);
  }
}

/** What a reload that didn't work means for the agent, for its timeline note. */
function failureDetail(result: { error: string; timedOut: boolean; unchecked?: boolean }): string {
  if (result.unchecked) return `It wasn't reloaded, since ${result.error.replace(/\.$/, "")}. It moves on a later try.`;
  return result.timedOut
    ? "Paseo didn't confirm the reload in time, so it may have moved already."
    : `Reloading it didn't work: ${result.error.replace(/\.$/, "")}.`;
}

/** `task`, or a rejection with `message` once `ms` pass without it settling. */
function deadline<T>(task: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([task, expired]).finally(() => clearTimeout(timer));
}

function log(message: string, error: unknown): void {
  console.error(`[ZeroSub] ${message}`, describe(error));
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
