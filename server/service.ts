import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import type {
  PluginHookContext,
  PluginLifecycleEvents,
  PluginSessionOpenRequest,
} from "@getpaseo/plugin/server";
import {
  ACCOUNT_METADATA_KEY,
  FAMILIES,
  FAMILY_LABEL,
  HAND_OFF,
  OPENCODE_LABEL,
  OPENCODE_PROVIDER,
  OPTIONAL,
  OTHER_FAMILY,
  type AccountView,
  type ApiPrice,
  type ApiSummary,
  ApiSummarySchema,
  type AzureSummary,
  type BedrockModels,
  type BedrockSource,
  type BedrockSummary,
  isAzureAccount,
  isBedrockAccount,
  type AgentRoute,
  type ApiKeyKind,
  type Egress,
  type Family,
  type LoginMethod,
  type LoginView,
  type StateView,
  type TrafficSwitches,
  type Usage,
} from "../shared/model";
import { capsAccount, limitedPick } from "../shared/format";
import { DEFAULT_CONTINUE_PROMPT, type Preferences } from "../shared/preferences";
import type { RedeemResult, ReopenSummary } from "../shared/rpc";
import { SWITCH_ROW_KIND, SWITCH_ROW_VERSION, type SwitchRow } from "../shared/timeline";
import {
  applyEnv,
  missingAdapter,
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
import { ApiUsageStore, currentMonth, type ApiUsageFile } from "./api-usage";
import {
  azureIdentity,
  azureSummary,
  checkAzureKey,
  findRollout,
  isAzureHome,
  normalizeAzureEndpoint,
  parseRollout,
  readAzureAccount,
  writeAzureAccount,
} from "./azure";
import {
  HOST_AWS,
  bedrockIdentity,
  bedrockSummary,
  findClaudeSession,
  isBedrockHome,
  normalizeRegion,
  parseClaudeSession,
  readBedrockAccount,
  writeBedrockAccount,
  type BedrockAccount,
  type BedrockCheck,
  type BedrockHost,
  type RegionSource,
} from "./bedrock";
import { codexHandoffMode, encryptedResumeFailure, sameWorkspace, turnFailedText } from "./codex-same-conversation";
import { CodexContinuations, MESSAGE_PREFIX, UnresolvableEpochError, fitInstructions, matchesTransfer, readUpdates, ready, sentDigestOf, snapshot, transferMarker, waitForCreated, waitForSource, type Agent } from "./continuations";
import { CONTINUED_FROM_LABEL, PARENT_LABEL, buildTranscript, continueInNewAgent, continuationPrompt, promptInstruction, updatePrompt, type Continuation } from "./handoff";
import { launcherDir, launcherNames, piLauncherDir, writeLaunchers, type LauncherAccount, type LauncherKind } from "./launchers";
import { PI_ACCOUNT_FILE, codexSessionsShared, prepareClaudeHome, crossesInheritedProxy, isAccountHome, moveHome, normalizeBaseUrl, plainHttp, readPiAccount, readPiAccountForAgents, removeHome, sentInTheClear } from "./homes";
import { Mutex } from "./json-file";
import { detectAzureLimit, detectAzureSignOut, detectBedrockAutoModeRefusal, detectBedrockLimit, detectBedrockModelUnavailable, detectBedrockRefusal, turnRows } from "./limits";
import { canSignInWithBrowser } from "./machine";
import { equivalentMode, withinMode } from "./modes";
import { homesDir, inHomesDir, isOwnHome, shownPath } from "./paths";
import { chooseHomesDir, chooseImportedHome, chooseImportedPiHome, homesDirFor, PLACED, placeFor, type PlacedFamily } from "./placement";
import { maskProxy, normalizeProxy } from "./proxy";
import { Reopener, hostCanReload } from "./reopen";
import { SwitchGuard } from "./switch-guard";
import { loadReadings, mergeUsage, pastReset, saveReadings, showLimit } from "./usage";
import { chooseAccount, isLastResort, isLimited, isUsable, mostAvailable, withBankedReset, type RouteDecision, type RouteInput } from "./routing";
import {
  ALL_SOURCES,
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
  type OpenCodeFork,
  type LiveSession,
  type NextAgentPick,
  type StoredAccount,
  type StoredState,
  type TimelineMark,
} from "./state";

type PaseoApi = PluginHookContext["paseo"];
type TurnEnded = PluginLifecycleEvents["agent.turn_ended"];

const PROVIDER_NAME: Record<Family, string> = { claude: "Claude Code", codex: "Codex", pi: "Pi", grok: "Grok", cursor: "Cursor" };
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
/** Paseo answers an availability read by probing every provider, so the state view reuses one for this long. */
const OPENCODE_AVAILABLE_MS = 60_000;
/** How long a default change waits for sessions already being routed to record their account. */
const ROUTING_WAIT_MS = 5_000;
/** How long the end of a turn waits for Paseo to page the agent's timeline. The SDK itself waits 60 s. */
const TURN_READ_MS = 10_000;
/** How long routing waits for Paseo to say an agent's mode before taking it for Auto (see `paidFor`). */
const MODE_READ_MS = 3_000;
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
  claudeForkDestination: "codex",
  forkOpenCodeModel: "",
  forkOpenCodeThinking: "",
  codexSameConversation: false,
  paidApiFallback: false,
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

/** Where the registry keeps the folder each family's added accounts' homes are kept in. */
const HOMES_KEY = { claude: "claudeHomes", pi: "piHomes" } as const satisfies Record<PlacedFamily, keyof StoredState>;

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
  /** Its permission mode now, as Paseo names it (Claude's `auto`, say), or null when Paseo gives none. */
  modeId: string | null;
}

/**
 * Whether a fork's conversation was delivered: `sent` and confirmed on the fork's timeline,
 * `up-to-date` (nothing new to send), or `found` (an existing fork without a provable checkpoint, so
 * nothing was sent). `detail` says why nothing was sent.
 */
type ForkDelivery = "sent" | "up-to-date" | "found" | "uncertain";
type OpenCodeCreateConfig = NonNullable<NonNullable<OpenCodeFork["pending"]>["config"]>;

/** What a fork attempt settles on: the new (or found) continuation and where the row says it went, or `skipped` with the reason nothing was started. */
type ForkOutcome =
  | {
      fork: Continuation;
      to: string;
      toFamily: Family | null;
      toProvider: string | null;
      delivery: ForkDelivery;
      detail?: string;
    }
  | { skipped: string };

const UP_TO_DATE_DETAIL = "No update was sent: the OpenCode continuation already has everything from this agent.";
/** Canonical pages one receipt search may read before it stops, uncertain. */
const RECEIPT_PAGES = 10;
const FOUND_DETAIL =
  "Found the existing OpenCode continuation, but couldn't tell what it has already received. Nothing was sent; open that chat to inspect it against this agent's latest instructions.";
const HISTORY_GAP_DETAIL =
  "ZeroSub couldn't read this agent's handoff history, so it can't prove what the continuation has. Nothing was sent; check both chats.";
const uncertainDetail = (title: string, messageId: string): string =>
  `The last handoff to “${title}” couldn't be confirmed (transfer ${messageId}). Open that chat before retrying; ZeroSub won't send it a second copy. To continue in a new chat instead, archive that one.`;
const alreadyContinued = (title: string): string =>
  `This agent was already continued in “${title}”. Nothing was started; carry on in that chat.`;
const MOVED_REFUSAL = "The existing OpenCode continuation moved, is working or is waiting for permission. Check that chat before retrying.";
const MODE_REFUSAL =
  "This agent's mode changed since the OpenCode continuation was set up. Nothing was sent; check both chats before retrying.";
const HOLD_REFUSAL =
  "ZeroSub's record of what it sent to OpenCode for this agent is damaged or incomplete, so it can't tell whether a continuation already has this work. Nothing was sent. Check this agent's OpenCode chats; to start a new continuation anyway, choose Continue on OpenCode again.";
const OPENCODE_IN_FLIGHT = "A continuation of this agent on OpenCode is being set up. Wait for it to finish, then check that chat.";
const SOURCE_BUSY_REFUSAL = "This agent is working or waiting for permission. Wait for it to stop, then continue it on OpenCode.";
const NEWER_REFUSAL = "This agent received a newer message while ZeroSub prepared the handoff. Nothing was sent; try again.";

/** The conversation a handoff carries: no plugin rows, and none of our own handoff prompts. */
function meaningful<T extends { item: AgentTimelineItem }>(entries: readonly T[]): T[] {
  return entries
    .filter((entry) => ["user_message", "assistant_message", "tool_call", "todo"].includes(entry.item.type))
    .filter((entry) => !(entry.item.type === "user_message" && entry.item.clientMessageId?.startsWith(MESSAGE_PREFIX)));
}

/** A reference a person can find: the fork's title, or its known agent ID when it has none. */
const forkRef = (fork: { id: string; title?: string | null }): string =>
  fork.title?.trim() ? fork.title : `${OPENCODE_LABEL} agent ${fork.id}`;

/** Whether two OpenCode creates send Paseo the same request: everything but the prompt's reason. */
function sameCreate(reserved: OpenCodeCreateConfig | undefined, next: OpenCodeCreateConfig): boolean {
  const keys = ["provider", "modeId", "thinkingOptionId", "workspaceId", "cwd", "parentId", "title"] as const;
  return reserved !== undefined && keys.every((key) => (reserved[key] ?? null) === (next[key] ?? null));
}

/**
 * The same place for a fork on another provider: the same workspace, or the same directory when
 * neither sits in one. (`samePlace` also demands the same provider, which a fork never shares.)
 */
function sameForkPlace(left: Agent, right: Agent): boolean {
  if (left.workspaceId !== right.workspaceId) return false;
  return Boolean(left.workspaceId) || left.cwd === right.cwd;
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
  /** Routing left the session alone: its family isn't available here (see `route`). */
  unavailable?: boolean;
}
type Problem = { kind: "limit"; hit: LimitHit } | { kind: "signed_out" };

/** Why a conversation of a provider without hand-off (Grok's, Cursor's) can't be given another account. */
function stays(family: Family, on: string | null): string {
  return `${FAMILY_LABEL[family]} conversations stay on the account they started on${on ? ` (${on})` : ""}. Start a new agent to use another account; new agents follow your pick and the default.`;
}

/** What a same-conversation reload has to put back if the other account cannot read the thread. */
interface ConversationMemberPin {
  chainId: string;
  accountId: string;
  identity: string | null;
  email: string | null;
}

interface SameConversationProbe {
  fromAccountId: string;
  toAccountId: string;
  previousBinding: Binding | undefined;
  members: ConversationMemberPin[];
}

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

/** Whether this host's Paseo keeps agent metadata (0.16 and later): its SDK can then write it. */
function takesAgentMetadata(paseo: PaseoApi): boolean {
  try {
    return typeof (paseo.agents.ref("zerosub") as unknown as { setMetadata?: unknown }).setMetadata === "function";
  } catch {
    return false;
  }
}

/**
 * The account named in a new agent's metadata: the one its composer's account control was set to
 * before the agent existed. A Paseo before 0.16 sends no metadata.
 */
function requestedAccount(request: PluginSessionOpenRequest): string | undefined {
  const { metadata } = request as { metadata?: Readonly<Record<string, unknown>> | null };
  const value = metadata?.[ACCOUNT_METADATA_KEY];
  return typeof value === "string" && value ? value : undefined;
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
  private readonly loginLocks: Record<Family, Mutex> = { claude: new Mutex(), codex: new Mutex(), pi: new Mutex(), grok: new Mutex(), cursor: new Mutex() };
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
  /** When each agent's current or last turn started, to count a Bedrock turn's messages (see `countBedrockTurn`). */
  private readonly turnStartedAt = new Map<string, number>();
  /**
   * The account a Codex agent reloaded off, until the first turn after that reload ends. A decrypt
   * or resume failure pins it back and opens today's new tab. Any other ending drops the record.
   */
  private readonly sameConversationProbe = new Map<string, SameConversationProbe>();
  /** This agent already failed to resume on the other account, so the next limit uses a new tab. */
  private readonly sameConversationBlocked = new Set<string>();
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
  /** Recorded moves being finished, by account (see `finishOne`). */
  private readonly finishing = new Map<string, Promise<void>>();
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
  /** OpenCode fork handoffs in flight, by source agent; duplicate requests join the first call. */
  private readonly openCodeForkInFlight = new Map<string, Promise<ForkOutcome>>();
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
  /** Each agent's permission mode as last seen, for routing that can't take some modes (Bedrock and Claude's Auto mode). */
  private readonly agentModes = new Map<string, string | null>();
  private openCodeCache: { at: number; available: boolean } | null = null;
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

  private readonly adapters: Record<Family, FamilyAdapter>;

  /** A family left out of `adapters` is never available here (see `missingAdapter`). */
  constructor(
    adapters: Partial<Record<Family, FamilyAdapter>> & Record<"claude" | "codex", FamilyAdapter>,
    private readonly store = new StateStore(),
    private readonly families = new FamilyResolver(),
    private readonly reopener = new Reopener(),
    private readonly apiUsage = new ApiUsageStore(),
    /** The host's AWS setup, for Bedrock accounts: its region and the credential check. */
    private readonly aws: BedrockHost = HOST_AWS,
  ) {
    this.adapters = Object.fromEntries(FAMILIES.map((family) => [family, adapters[family] ?? missingAdapter(family)])) as Record<Family, FamilyAdapter>;
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
    // Moves a stop cut short are finished first: the checks below read an account's folder, and the
    // sync further down would make the old one again.
    if (this.hasRecordedMoves(await this.store.read())) await this.finishRecordedMoves();
    const state = await this.store.read();
    for (const account of state.accounts) {
      // One still on record (both folders there, say) waits: its folder isn't settled.
      if (state.moves[account.id]) continue;
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
      if (account.signedIn && now - (this.egressCheckedAt.get(account.id) ?? 0) >= EGRESS_MS) void this.checkEgress(account);
    }
    for (const [id, login] of this.logins) {
      if (login.finishedAt && now - login.finishedAt > LOGIN_TTL_MS) this.logins.delete(id);
      else if (!login.finishedAt && now - Date.parse(login.view.startedAt) > LOGIN_TTL_MS) void this.cancelLogin(id);
    }
    // Keep added Claude and Pi homes in step with main (shared entries, generated settings; a Pi home's
    // sign-ins too) even when they're only used from a terminal, which ZeroSub never sees start.
    for (const account of (await this.store.read()).accounts) {
      if ((account.family === "claude" || account.family === "pi") && account.kind === "managed" && account.home && !this.moving.has(account.id)) {
        await this.adapters[account.family]
          .prepareHome(account.home, this.stillHas(account))
          .catch((error: unknown) => log(`could not refresh the home of ${account.label}`, error));
      }
    }
    await this.placeHomes().catch((error: unknown) => log("moving accounts' homes failed", error));
    await this.refreshLaunchers().catch((error: unknown) => log("could not write the shell launchers", error));
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
    // The registry this pass read may be out of date by now (Paseo took a while to answer, say).
    if (!(await this.stillToCleanUp(home))) return;
    // A sign-in this run saw end without an account is its own to undo. One left by an earlier run
    // only goes if it isn't signed in: a registry restored from an older copy can still list a
    // sign-in that has since become an account the registry no longer knows.
    // An API account (every Pi one) is saved, and its entry dropped, in one write (see `addApiAccount`):
    // an entry left means it never became an account, so its home goes, key and all, though Claude
    // Code calls a home with a key signed in.
    // So is an Azure OpenAI or AWS Bedrock account's (its home holds azure.json or bedrock.json):
    // nothing in it signs in.
    const apiHome =
      entry.family === "pi" ||
      (entry.family === "codex" && isAzureHome(home)) ||
      (entry.family === "claude" && isBedrockHome(home)) ||
      (await this.adapters[entry.family].api?.(home).catch(() => null)) != null;
    const earlier = entry.why === "unfinished" && !apiHome && !this.endedHere(home);
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
        outcome = entry.why === "unfinished" && apiHome ? `deleted ${home}, left by an API account that was never saved` : `signed out and deleted ${home}`;
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
    // Checked again just before the folder goes: signing out can take a while too.
    if (deleteFolder && !(await this.stillToCleanUp(home))) return;
    if (deleteFolder) await removeHome(home);
    await this.store.update((draft) => {
      delete draft.cleanup[home];
      for (const agentId of users) if (draft.sessions[agentId]?.accountId === entry.accountId) delete draft.sessions[agentId];
    });
    console.log(`[ZeroSub] ${outcome}`);
  }

  /**
   * Whether `home` is still listed for cleanup with no account using it, read from the registry as it
   * is now. One an account uses again comes off the list, as in `cleanUpPass`.
   */
  private async stillToCleanUp(home: string): Promise<boolean> {
    const state = await this.store.read();
    if (!state.cleanup[home]) return false;
    if (!state.accounts.some((account) => account.home === home)) return true;
    await this.store.update((draft) => {
      if (draft.accounts.some((account) => account.home === home)) delete draft.cleanup[home];
    });
    return false;
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
      if (opening.unavailable) {
        await this.openedUnavailable(request, opening);
        return result;
      }
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

  /**
   * A session of a family that isn't available here runs on the CLI login, like any session ZeroSub
   * didn't route: so the account recorded for the session before goes, unless a session opened since
   * replaced it, and a reload of ours counts as not landed. Bindings stay, so the agent goes back to
   * its account once the family is available again.
   */
  private async openedUnavailable(request: PluginSessionOpenRequest, opening: Opening): Promise<void> {
    const { agentId } = request;
    this.unrouted.add(agentId);
    const ended = (session: LiveSession | undefined) => session !== undefined && Date.parse(session.openedAt) < opening.startedAt;
    if (!ended((await this.store.read()).sessions[agentId])) return;
    await this.store.update((draft) => {
      if (ended(draft.sessions[agentId])) delete draft.sessions[agentId];
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
    // A family known not to work here (Cursor off Linux, with a registry made on Linux, say) gives an
    // added account no env of its own: the session runs on the CLI login, so it isn't routed or
    // recorded. Until availability is first checked, sessions are routed as usual.
    if (this.availability.get(family)?.ok === false) {
      if (opening) opening.unavailable = true;
      console.log(`[ZeroSub] ${request.provider} agent ${request.agentId} not routed: ${PROVIDER_NAME[family]} isn't available here (${request.reason})`);
      return undefined;
    }
    const adapter = this.adapters[family];
    // A move a stop cut short is finished first, so no session opens on a folder that has moved.
    if (this.hasRecordedMoves(await this.store.read())) await this.finishRecordedMoves();
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
      paidFallback: this.prefs.paidApiFallback,
      autoRedeem: this.prefs.autoRedeem,
      portable: adapter.portable,
      usageOf: (id) => this.usage.get(id),
      // Alignment and the account button decide with the same stand-in rule, so a reopen lands where they expect.
      current: request.reason === "create" ? undefined : this.standingIn(state, request.agentId, family, request.reason === "refresh"),
      requested: request.reason === "create" ? requestedAccount(request) : undefined,
      allowNextPick: takesNextPick(request),
    };
    let first = chooseAccount(state, input);
    // Paid fallback would put a Claude agent on Bedrock by itself: not one in Auto mode, which Bedrock
    // can't run (see `paidFor`). Its mode is asked for only then.
    if (first && family === "claude" && input.paidFallback && isBedrockAccount(first.account)) {
      const unpaid = chooseAccount(state, { ...input, paidFallback: false });
      if (unpaid?.account.id !== first.account.id && runsAutoMode(await this.modeOf(context.paseo, request.agentId))) {
        console.log(`[ZeroSub] ${request.agentId} not routed to ${first.account.label}: it's in Claude's Auto mode, which Bedrock can't run`);
        input.paidFallback = false;
        first = unpaid;
      }
    }
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
    if (input.requested && seenBinding === undefined && !(decision.bind?.source === "user" && account.id === input.requested)) {
      console.log(`[ZeroSub] the account chosen for ${request.agentId} before it started can't take it now, so it starts as any new agent would`);
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
    this.turnStartedAt.set(agent.id, this.noteTurn(agent.id));
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
    const ranOn = await this.store.read();
    const accountId = this.runningOn(ranOn, agentId, family) ?? null;
    if (accountId) this.activeAt.set(accountId, Date.now());
    // An Azure OpenAI or AWS Bedrock account fails on the API's errors, not the subscription's
    // notices, and only a failed turn's (see `detectAzureLimit` and `detectBedrockLimit`).
    const ranAccount = findAccount(ranOn, accountId);
    const azure = ranAccount !== undefined && isAzureAccount(ranAccount);
    const bedrock = ranAccount !== undefined && isBedrockAccount(ranAccount);
    if (azure && accountId) void this.countAzureTurn(context.paseo, agentId, accountId).catch((error: unknown) => log(`could not count the tokens of ${agentId}'s turn`, error));
    if (bedrock && accountId) {
      const startedAt = this.turnStartedAt.get(agentId) ?? endedAt - 60 * 60_000;
      void this.countBedrockTurn(context.paseo, agentId, accountId, startedAt).catch((error: unknown) => log(`could not count the tokens of ${agentId}'s turn`, error));
    }
    if (event.outcome.kind === "completed") this.sameConversationBlocked.delete(agentId);
    const probe = this.sameConversationProbe.get(agentId);
    if (event.outcome.kind !== "canceled") {
      const turn = await this.turnWithTimeline(context.paseo, event);
      if (probe && encryptedResumeFailure(turnFailedText(turn))) {
        this.sameConversationProbe.delete(agentId);
        this.sameConversationBlocked.add(agentId);
        await this.revertSameConversation(context.paseo, agentId, family, probe, turn.timeline);
        if (this.deferred.has(agentId)) await this.finishDeferred(context.paseo, agentId, family);
        return;
      }
      if (probe) this.sameConversationProbe.delete(agentId);
      // A hand-off quotes the whole conversation, not just this turn. Paseo 0.13 sends none, so the hand-off pages it.
      const conversation = event.timeline.length > 0 ? event.timeline : undefined;
      // A model the account's region doesn't offer is that model's problem, not the account's: the
      // agent stays, and its timeline says how to fix it (see `detectBedrockModelUnavailable`).
      // Paseo refuses Claude's Auto mode on Bedrock. The account is fine: the agent's mode isn't.
      const autoRefused = bedrock ? detectBedrockAutoModeRefusal(turn) : null;
      if (autoRefused && ranAccount) {
        console.log(`[ZeroSub] ${agentId} can't run in Auto mode on ${ranAccount.label}: ${autoRefused}`);
        this.agentModes.set(agentId, CLAUDE_AUTO_MODE);
        await this.noteBedrockTurn(context.paseo, agentId, ranAccount, autoModeRefusedNote(ranAccount.label));
        if (this.deferred.has(agentId)) await this.finishDeferred(context.paseo, agentId, family);
        return;
      }
      const unavailable = bedrock ? detectBedrockModelUnavailable(turn) : null;
      if (unavailable && ranAccount) {
        console.log(`[ZeroSub] ${agentId}'s model isn't available on ${ranAccount.label}: ${unavailable.message}`);
        await this.noteBedrockTurn(context.paseo, agentId, ranAccount, bedrockModelNote(ranAccount.label, unavailable.model));
        if (this.deferred.has(agentId)) await this.finishDeferred(context.paseo, agentId, family);
        return;
      }
      const hit = azure ? detectAzureLimit(turn) : bedrock ? detectBedrockLimit(turn) : adapter.detectLimit(turn);
      const bedrockRefusal = bedrock ? detectBedrockRefusal(turn) : null;
      const refusal = azure ? detectAzureSignOut(turn) : bedrock ? (bedrockRefusal?.message ?? null) : adapter.detectSignOut(turn);
      const problem: Problem | null = hit
        ? { kind: "limit", hit }
        : refusal && (await this.confirmSignedOut(accountId, refusal, bedrockRefusal?.model === true))
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
    if (probe && event.outcome.kind === "canceled") this.sameConversationProbe.delete(agentId);
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
    this.sameConversationProbe.delete(agentId);
    this.sameConversationBlocked.delete(agentId);
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
    this.turnStartedAt.delete(agentId);
    this.sameConversationProbe.delete(agentId);
    this.sameConversationBlocked.delete(agentId);
    this.switchGuard.forget(agentId);
    this.guardNoticeAt.delete(agentId);
    this.guardNoticeAt.delete(`${agentId}:elsewhere`);
    if (!(await this.store.read()).sessions[agentId]) return;
    await this.store.update((draft) => {
      delete draft.sessions[agentId];
    });
  }

  /** A note in the agent's timeline about a turn its Bedrock account couldn't run, which leaves the account as it is. */
  private async noteBedrockTurn(paseo: PaseoApi, agentId: string, account: StoredAccount, detail: string): Promise<void> {
    await this.appendRow(paseo, agentId, {
      family: "claude",
      from: account.label,
      to: account.label,
      reason: "manual",
      resetsAt: null,
      continued: false,
      continuedIn: null,
      toFamily: null,
      toProvider: null,
      outcome: "stayed",
      detail,
      at: new Date().toISOString(),
    });
  }

  /** Re-checks the account an agent was using; true when it really is signed out now. */
  private async confirmSignedOut(accountId: string | null, refusal?: string | boolean, checked = false): Promise<boolean> {
    if (!accountId) return false;
    const state = await this.store.read();
    const account = findAccount(state, accountId);
    if (account?.auth === "api") {
      // An Azure key or AWS credentials are asked about first: the 401 or 403 (or AccessDenied) in the
      // turn may be another service's (an MCP server's, say). Only Azure or AWS refusing them now signs
      // the account out; a check that can't get an answer (the network, no aws command, another
      // status) leaves it as it is. A model Bedrock names as not enabled or invalid needs no check
      // (`checked`, see `detectBedrockRefusal`). Other keys have nothing to re-check against: the
      // refusal itself is the answer.
      if (isAzureAccount(account) && !(await this.azureRefusesKey(account))) return false;
      if (isBedrockAccount(account) && !checked) {
        const refused = await this.bedrockRefusesCredentials(account);
        if (refused === null) return false;
        refusal = refused;
      }
      await this.store.update((draft) => {
        const target = findAccount(draft, accountId);
        if (target) {
          target.signedIn = false;
          if (typeof refusal === "string" && isLastResort(target)) target.apiError = refusal.slice(0, 300);
          dropNextPick(draft, target);
        }
      });
      return true;
    }
    await this.refreshIdentity(accountId);
    return findAccount(await this.store.read(), accountId)?.signedIn === false;
  }

  /** Whether Azure refuses the account's key now (401/403), or its home no longer holds one. */
  private async azureRefusesKey(account: StoredAccount): Promise<boolean> {
    const settings = account.home ? await readAzureAccount(account.home).catch(() => null) : null;
    if (!settings) return true;
    const check = await checkAzureKey(settings.endpoint, settings.key);
    if (check.ok) return false;
    if (!check.fatal) console.log(`[ZeroSub] ${account.label}'s turn failed on what looked like a refused key, but it couldn't be checked: ${check.message} It stays signed in.`);
    return check.fatal;
  }

  /**
   * What AWS says about a Bedrock account's credentials now (see `checkBedrock`): its refusal when it
   * refuses them, or null when they work or the check couldn't get an answer (no aws command, the
   * network, a role that can't list inference profiles), which leaves the account as it is.
   */
  private async bedrockRefusesCredentials(account: StoredAccount): Promise<string | null> {
    const settings = account.home ? await readBedrockAccount(account.home).catch(() => null) : null;
    if (!settings) return "Its AWS settings (bedrock.json) are missing.";
    const check = await this.aws.check(settings).catch((error: unknown): BedrockCheck => ({ ok: false, fatal: false, message: error instanceof Error ? error.message : String(error) }));
    if (check.ok) return null;
    if (!check.fatal) {
      console.log(`[ZeroSub] ${account.label}'s turn failed on what looked like refused AWS credentials, but they couldn't be checked: ${check.message} It stays usable.`);
      return null;
    }
    return check.message;
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
      toProvider: null,
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
    // Another subscription account comes first, then a banked reset (free), and a paid Azure or
    // Bedrock account (with `paidApiFallback` on) only once neither is to be had.
    let move = adapter.portable ? this.nextAccount(latest, agentId, family, account.id, false) : null;
    let autoModeSkip: string | null = null;
    let next = adapter.portable ? move?.account : mostAvailable(latest, family, (id) => this.usage.get(id), now, new Set([account.id]));
    if (!next) {
      if (problem.kind === "limit" && problem.hit.kind === "window" && this.prefs.autoRedeem && !account.disabled && account.auth !== "api") {
        // Opt-in: every subscription account is out, so spend a banked reset rather than stop (or pay).
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
      if (adapter.portable && this.prefs.paidApiFallback) {
        move = this.nextAccount(await this.store.read(), agentId, family, account.id, true);
        next = move?.account;
        // Bedrock can't run Claude's Auto mode: an agent in it would fail every turn there.
        if (next && isBedrockAccount(next) && runsAutoMode(await this.modeOf(paseo, agentId))) {
          console.log(`[ZeroSub] not moving ${agentId} onto ${next.label}: it's in Claude's Auto mode, which Bedrock can't run`);
          autoModeSkip = autoModeSkipNote(next.label);
          move = undefined;
          next = undefined;
        }
      } else if (this.prefs.paidApiFallback) {
        next = mostAvailable(await this.store.read(), family, (id) => this.usage.get(id), Date.now(), new Set([account.id]), true);
      }
    }
    if (!next) {
      if (reason !== "limit") return;
      let detail: string | null = null;
      const otherFamily = OTHER_FAMILY[family];
      // Opt-in: every account of this provider is out, so carry on with the other provider, or on
      // the host's OpenCode when a stopped Claude chat was pointed there in the settings.
      const toOpenCode = family === "claude" && this.prefs.claudeForkDestination === "opencode";
      if (this.prefs.forkOtherProvider && (toOpenCode || otherFamily)) {
        const result = await (toOpenCode
          ? this.forkToOpenCode(paseo, agentId, "auto")
          : this.forkToOtherProvider(paseo, agentId, family, timeline, "auto")
        ).catch((error: unknown) => ({
          skipped: `Couldn't continue on ${toOpenCode ? OPENCODE_LABEL : FAMILY_LABEL[otherFamily!]}: ${describe(error)}`,
        }));
        if ("fork" in result) {
          this.switchGuard.note(agentId, now);
          await this.appendRow(paseo, agentId, {
            ...base,
            to: result.to,
            toFamily: result.toFamily,
            toProvider: result.toProvider,
            reason: "exhausted",
            continued: result.delivery === "sent",
            continuedIn: result.fork,
            outcome: result.delivery === "sent" ? "continued" : "stayed",
            delivery: result.delivery,
            detail: joinDetails(autoModeSkip, result.detail ?? null),
          });
          return;
        }
        console.log(`[ZeroSub] not continuing ${agentId}: ${result.skipped}`);
        detail = result.skipped;
      } else if (otherFamily && mostAvailable(latest, otherFamily, (id) => this.usage.get(id), now, new Set(), this.prefs.paidApiFallback)) {
        detail = `Or continue on ${FAMILY_LABEL[otherFamily]} in a new agent from the account button.`;
      }
      await this.appendRow(paseo, agentId, { ...base, to: account.label, reason: "exhausted", outcome: "stayed", detail: joinDetails(autoModeSkip, detail) });
      return;
    }

    if (!adapter.portable && (await this.keptSameConversation(paseo, agentId, account, next, problem, base, reason, endedAt))) return;

    if (adapter.portable) {
      // Never pinned to a paid stand-in (Bedrock): it's only there until a subscription account has
      // room, and routing and alignment take the agent back then.
      if (move?.pin && !isLastResort(next)) await this.pin(agentId, next.id, latest.bindings[agentId]);
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
          detail: result.outcome === "failed" ? failureDetail(result) : isLastResort(next) ? paidFallbackNote(next) : null,
        },
        agentId,
      );
      await this.appendRow(paseo, agentId, row);
      if (continued) await this.carryOn(paseo, agentId, endedAt);
      return;
    }

    // A ChatGPT thread can't move to another account; carry the work on in a new agent there.
    if (!this.prefs.autoContinue || !HAND_OFF[family]) {
      await this.appendRow(paseo, agentId, {
        ...base,
        to: next.label,
        reason,
        outcome: "stayed",
        detail: `New ${FAMILY_LABEL[family]} agents will use ${next.label}.`,
      });
      return;
    }
    const paid = isLastResort(next);
    const why =
      (reason === "limit"
        ? `its ChatGPT account (${account.label}) reached its usage limit`
        : `its ChatGPT account (${account.label}) was signed out`) +
      (paid ? ` and every other ChatGPT account is out too, so it moved to Azure OpenAI (${next.label}, a paid API billed per token)` : "");
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
        detail: paid ? paidFallbackNote(next) : null,
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
      toProvider: null,
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
    if (account.auth === "api") throw new Error(`${account.label} uses an API key, which has no banked resets.`);
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
      toProvider: null,
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
   * Whether a paid stand-in may take this agent by itself (`paidApiFallback`). Bedrock can't run
   * Claude's Auto mode (Paseo refuses to start the turn: "Claude Auto mode requires the Anthropic
   * API"), so a Claude agent in Auto mode never goes there by itself, nor one whose mode isn't known
   * yet: Auto is Paseo's default Claude mode. Picking Bedrock by hand, or as the default, still works.
   */
  private paidFor(family: Family, agentId: string): boolean {
    return this.prefs.paidApiFallback && !(family === "claude" && runsAutoMode(this.agentModes.get(agentId)));
  }

  /** The agent's permission mode now (null when it can't be told), noted for `paidFor`. */
  private async modeOf(paseo: PaseoApi, agentId: string): Promise<string | null> {
    const info = await deadline(agentInfo(paseo, agentId), MODE_READ_MS, "Paseo didn't say the agent's mode in time").catch(() => null);
    const modeId = info?.modeId ?? null;
    this.agentModes.set(agentId, modeId);
    return modeId;
  }

  /**
   * Where an agent moves off an `exhausted` account: where it's routed now when that's another
   * account as chosen (one picked for it, perhaps while its turn ran, or the default it follows),
   * else the roomiest other one, which it's then pinned to. Undefined when there's none. `paid`: a
   * paid stand-in (Bedrock) may be chosen by itself, as `paidApiFallback` allows; failover asks
   * without it first, so a banked reset comes before one (see `failover`).
   */
  private nextAccount(
    state: StoredState,
    agentId: string,
    family: Family,
    exhausted: string,
    paid = this.paidFor(family, agentId),
  ): { account: StoredAccount; pin: boolean } | undefined {
    const routed = this.routeFor(state, agentId, family, exhausted, paid);
    if (routed && routed.account.id !== exhausted && !routed.skipped) return { account: routed.account, pin: false };
    const roomiest = mostAvailable(state, family, (id) => this.usage.get(id), Date.now(), new Set([exhausted]), paid);
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
      this.agentModes.set(agentId, info.modeId);
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
        if (move.pin && !isLastResort(next)) await this.pin(agentId, next.id, latest.bindings[agentId]);
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
          toProvider: null,
          outcome: "switched",
          detail: isLastResort(next) ? paidFallbackNote(next) : null,
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
  ): Promise<ForkOutcome> {
    const other = OTHER_FAMILY[family];
    if (!other) return { skipped: `${FAMILY_LABEL[family]} agents don't carry on with another provider.` };
    const name = FAMILY_LABEL[other];
    const families = await this.families.resolve(paseo);
    const state = await this.store.read();
    // Prompting the original again while it's still out mustn't start a second copy of the work.
    const { agents } = await listAgents(paseo, false);
    const earlier = agents.find(
      (agent) => agent.continuedFrom === agentId && families[agent.provider] === other,
    );
    const earlierAccount = earlier && (findAccount(state, state.bindings[earlier.id]?.accountId) ?? mainAccount(state, other));
    if (earlier && earlierAccount) {
      return {
        fork: { agentId: earlier.id, title: earlier.title ?? `${name} agent` },
        to: earlierAccount.label,
        toFamily: other,
        toProvider: null,
        delivery: "sent",
        ...(isLastResort(earlierAccount) ? { detail: paidFallbackNote(earlierAccount) } : {}),
      };
    }

    const openCodeCopy = agents.find((agent) => agent.continuedFrom === agentId && agent.provider === OPENCODE_PROVIDER);
    if (openCodeCopy) return { skipped: alreadyContinued(openCodeCopy.title ?? `${OPENCODE_LABEL} agent ${openCodeCopy.id}`) };
    if (this.openCodeForkInFlight.has(agentId)) return { skipped: OPENCODE_IN_FLIGHT };
    // An OpenCode reservation is a continuation while its fork exists. One whose create never landed,
    // or whose fork was archived, is dropped here: nothing more is ever sent to it without its record.
    const reservation = state.opencodeForks[agentId]?.pending;
    if (reservation) {
      const target = await snapshot(paseo, reservation.targetId);
      if (target && !target.archivedAt) return { skipped: alreadyContinued(forkRef(target)) };
    }

    if (this.availability.get(other)?.ok === false) return { skipped: `${PROVIDER_NAME[other]} isn't installed where the daemon runs.` };
    const provider = families[other] === other ? other : Object.keys(families).find((id) => families[id] === other);
    const available = provider
      ? (await paseo.providers.listAvailable()).providers?.some((entry) => entry.provider === provider && entry.available)
      : false;
    if (!provider || !available) return { skipped: `${name} isn't available in Paseo on this host.` };
    const now = Date.now();
    let account = mostAvailable(state, other, (id) => this.usage.get(id), now, new Set(), this.prefs.paidApiFallback);
    // A fork is a new agent that can't change accounts later, so a free banked reset goes before a paid stand-in here too.
    if (account && isLastResort(account) && this.prefs.autoRedeem) {
      account = withBankedReset(state, other, (id) => this.usage.get(id), now) ?? account;
    }
    if (!account) {
      // API accounts are billed per use, so they never take work over by themselves; say so rather than "at its limit".
      const apiOnly = accountsOf(state, other).some((entry) => entry.auth === "api" && isUsable(entry, now));
      return {
        skipped: apiOnly
          ? `The only ${name} accounts with room use an API key, which ZeroSub never moves work onto by itself. To use one, start a ${name} agent and pick it from the agent's account button.`
          : `Every ${name} account is at its limit too.`,
      };
    }

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
    // A fork in Claude's Auto mode can't run on Bedrock (see `paidFor`): a subscription account, or none.
    if (other === "claude" && isBedrockAccount(account) && runsAutoMode(modeId)) {
      const subscription = mostAvailable(state, other, (id) => this.usage.get(id), now, new Set(), false);
      if (!subscription) return { skipped: autoModeSkipNote(account.label) };
      account = subscription;
    }

    // Every check that can refuse has passed, so the stale reservation goes now.
    if (reservation) {
      await this.store.update((draft) => {
        if (draft.opencodeForks[agentId]?.pending?.messageId === reservation.messageId) delete draft.opencodeForks[agentId];
      });
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
    return {
      fork,
      to: account.label,
      toFamily: other,
      toProvider: null,
      delivery: "sent",
      ...(isLastResort(account) ? { detail: paidFallbackNote(account) } : {}),
    };
  }

  /**
   * Carries a stopped Claude chat on in a new agent on this host's OpenCode, when that's the chosen
   * destination and every Claude account is out. OpenCode is a harness, not an account provider, so
   * the new agent gets no account binding. Its model, thinking option, and mode all come from this
   * host's catalog. The mode is Plan or Build under the host's own permission policy, which can
   * allow more than Claude does. Anything else refuses the fork.
   */
  private forkToOpenCode(paseo: PaseoApi, agentId: string, source: "auto" | "user" = "auto"): Promise<ForkOutcome> {
    // One handoff at a time per source; a concurrent duplicate gets the first call's result. There is
    // no atomic compare-and-send in the SDK: this guard plus the fresh checks below are the bounds.
    const existing = this.openCodeForkInFlight.get(agentId);
    if (existing) return existing;
    const task = this.forkToOpenCodeNow(paseo, agentId, source).finally(() => this.openCodeForkInFlight.delete(agentId));
    this.openCodeForkInFlight.set(agentId, task);
    return task;
  }

  private async forkToOpenCodeNow(paseo: PaseoApi, agentId: string, source: "auto" | "user"): Promise<ForkOutcome> {
    const available = (await paseo.providers.listAvailable()).providers?.some(
      (entry) => entry.provider === OPENCODE_PROVIDER && entry.available,
    );
    if (!available) return { skipped: `${OPENCODE_LABEL} isn't available in Paseo on this host.` };

    const first = await snapshot(paseo, agentId);
    if (!first) throw new Error("That agent is no longer available.");
    // turn_ended can arrive just before the source reports idle: an automatic fork waits a moment,
    // refusing if a newer message arrives meanwhile.
    const original = source === "auto" ? await waitForSource(paseo, first, "auto").catch(() => undefined) : first;
    if (!original || !ready(original)) return { skipped: SOURCE_BUSY_REFUSAL };

    await this.settleGlobalHold(paseo);
    const recordRead = await this.store.read();
    let record = recordRead.opencodeForks[agentId];
    // Recovery lost what was sent for this source. A missing, archived or unlisted fork proves
    // nothing, so nothing is forked or sent on its own; a person asked once may start a new one.
    if (!record && (recordRead.opencodeHolds[agentId] ?? recordRead.opencodeHolds[ALL_SOURCES])) {
      const refusal = await this.askBeforeUnproven(agentId, source);
      if (refusal) return refusal;
    }
    // Prompting the original again while it's still out must reuse its fork, not start a second one.
    const forkId =
      record?.forkAgentId ??
      (await listAgents(paseo, false)).agents.find((agent) => agent.continuedFrom === agentId && agent.provider === OPENCODE_PROVIDER)?.id;
    if (!forkId) return this.createOpenCodeFork(paseo, agentId, original, source);

    let fork = await snapshot(paseo, forkId);
    // Reconcile a reservation an earlier call left behind, before anything else happens.
    if (record?.pending) {
      const pending = record.pending;
      if (pending.stage === "creating") {
        if (fork && !fork.archivedAt && !fork.lastUserMessageAt) {
          // Created but never prompted: deliver the reserved initial handoff under its reserved ID.
          return this.deliverReservedOpenCode(paseo, agentId, fork);
        }
        if (!fork) {
          // The create never landed, so nothing was sent. A create seen to fail is built again from
          // today's settings and source; one whose outcome is unknown is sent again unchanged.
          return this.createOpenCodeFork(paseo, agentId, original, source, pending);
        }
        if (fork.archivedAt) {
          // Nothing was sent, so dropping the reservation cannot duplicate work.
          await this.store.update((draft) => { delete draft.opencodeForks[agentId]; });
          return this.createOpenCodeFork(paseo, agentId, original, source);
        }
        return {
          skipped: `The unstarted OpenCode fork “${fork.title ?? OPENCODE_LABEL}” received another message. Check it and archive it before retrying.`,
        };
      }
      if (!fork || fork.archivedAt) {
        // The fork of an unconfirmed send was archived or is gone: whatever it received stays there,
        // and nothing more can reach it, so the reservation goes and the work continues in a new fork.
        await this.store.update((draft) => {
          if (draft.opencodeForks[agentId]?.pending?.messageId === pending.messageId) delete draft.opencodeForks[agentId];
        });
        return this.createOpenCodeFork(paseo, agentId, original, source);
      }
      if (pending.sentDigest !== undefined && (await this.hasReceipt(paseo, forkId, pending.messageId, pending.sentDigest))) {
        await this.settleOpenCode(agentId, pending.messageId);
        fork = await snapshot(paseo, forkId);
        record = (await this.store.read()).opencodeForks[agentId];
      } else {
        return this.openCodeUncertain(forkId, fork.title, pending.messageId);
      }
    }

    if (!fork || fork.archivedAt) {
      // A settled fork that is gone or archived may be replaced by a new one. Without a checkpoint,
      // nothing proves what it received, so it is treated like a lost record.
      if (!record?.seen) {
        const refusal = await this.askBeforeUnproven(agentId, source);
        if (refusal) return refusal;
      }
      return this.createOpenCodeFork(paseo, agentId, original, source);
    }
    if (!record?.seen) {
      // A fork from an earlier release, or one without a checkpoint: what it has can't be proven,
      // so nothing is sent and nothing is adopted silently.
      return this.openCodeFound(fork);
    }
    // Fresh checks before sending: same place, same parent, not working, nobody waiting on it.
    const checked = await this.freshOpenCodeTarget(paseo, agentId, fork.id);
    if ("refused" in checked) return { skipped: checked.refused };
    return this.updateOpenCodeFork(paseo, agentId, checked.fork, record.seen, checked.original.lastUserMessageAt);
  }

  /**
   * Settles the hold recovery put on every source when it couldn't read the fork records at all.
   * Only a source with an OpenCode continuation (archived ones included) can have lost a record, so
   * each such source gets a hold of its own and the global hold goes: agents without one, and agents
   * created later, fork as before. It stays while Paseo's agent list can't be read whole.
   */
  private async settleGlobalHold(paseo: PaseoApi): Promise<void> {
    if (!(await this.store.read()).opencodeHolds[ALL_SOURCES]) return;
    const { agents, complete } = await listAgents(paseo, true);
    if (!complete) return;
    await this.store.update((draft) => {
      const hold = draft.opencodeHolds[ALL_SOURCES];
      if (!hold) return;
      for (const agent of agents) {
        const source = agent.continuedFrom;
        if (source && agent.provider === OPENCODE_PROVIDER && !draft.opencodeForks[source]) draft.opencodeHolds[source] ??= { at: hold.at };
      }
      delete draft.opencodeHolds[ALL_SOURCES];
    });
  }

  /**
   * Nothing proves what this source's OpenCode fork already received. An automatic fork never goes
   * ahead; a person is told once, and the next manual request may start a new fork. The hold is
   * cleared when that fork's reservation is written.
   */
  private async askBeforeUnproven(agentId: string, source: "auto" | "user"): Promise<ForkOutcome | undefined> {
    if (source === "user" && (await this.store.read()).opencodeHolds[agentId]?.told) return undefined;
    const at = new Date().toISOString();
    await this.store.update((draft) => {
      const hold = draft.opencodeHolds[agentId] ?? { at };
      draft.opencodeHolds[agentId] = source === "user" ? { at: hold.at, told: true } : hold;
    });
    return { skipped: HOLD_REFUSAL };
  }

  private async openCodeSource(
    paseo: PaseoApi,
    agentId: string,
    config?: OpenCodeCreateConfig,
  ): Promise<{ original: Agent; parentId: string | undefined } | undefined> {
    const original = await snapshot(paseo, agentId);
    if (!original || !ready(original)) return undefined;
    const parentId = await this.continuations.parentFor(paseo, agentId);
    if (config) {
      if (config.workspaceId === undefined || config.cwd === undefined || config.parentId === undefined || config.title === undefined) return undefined;
      if ((original.workspaceId ?? null) !== config.workspaceId || (original.cwd ?? null) !== config.cwd) return undefined;
      if ((parentId ?? null) !== config.parentId) return undefined;
      if (`${original.title?.trim() || "Task"} (continued on ${OPENCODE_LABEL})` !== config.title) return undefined;
    }
    return { original, parentId };
  }

  /**
   * The checks run before a reservation is written and again right before its send: the source has
   * nothing newer than `mark` and is ready and in place; the target is ready, in place, under the same
   * parent, and in a mode whose Paseo tier is no higher than the source's current one (tiers only, not
   * OpenCode's permission policy). A reserved creation first waits for its new target to finish
   * initializing, and the target must still be the promptless agent it reserved. The snapshots are
   * read last, after every timeline read, so the comparison sees the modes as of the send. The SDK has
   * no compare-and-send: a change after these reads and before the send is still possible.
   */
  private async freshOpenCodeTarget(
    paseo: PaseoApi,
    agentId: string,
    forkId: string,
    mark?: TimelineMark,
    config?: OpenCodeCreateConfig,
  ): Promise<{ original: Agent; fork: Agent } | { refused: string; unreadable?: true }> {
    if (config) await waitForCreated(paseo, forkId);
    if (mark) {
      const since = await this.sourceSince(paseo, agentId, mark);
      if (since === "newer") return { refused: NEWER_REFUSAL };
      // Unreadable history proves no newer message either: the caller reports it as an inspection.
      if (since !== "same") return { refused: since === "epoch" ? FOUND_DETAIL : HISTORY_GAP_DETAIL, unreadable: true };
    }
    const source = await this.openCodeSource(paseo, agentId, config);
    if (!source) return { refused: MOVED_REFUSAL };
    const [sourceModes, targetModes] = await Promise.all([
      paseo.providers.listModes(source.original.provider).then((result) => result.modes ?? []),
      paseo.providers.listModes(OPENCODE_PROVIDER).then((result) => result.modes ?? []),
    ]);
    // The parent is resolved again after the catalog reads, then the snapshots come last.
    const parentId = await this.continuations.parentFor(paseo, agentId);
    const [original, fork] = await Promise.all([
      snapshot(paseo, agentId),
      snapshot(paseo, forkId),
    ]);
    if (!original || !ready(original)) return { refused: MOVED_REFUSAL };
    if (original.lastUserMessageAt !== source.original.lastUserMessageAt) return { refused: NEWER_REFUSAL };
    const expectedParent = config ? config.parentId ?? undefined : source.parentId;
    if (parentId !== expectedParent || original.labels?.[PARENT_LABEL] !== source.original.labels?.[PARENT_LABEL]) return { refused: MOVED_REFUSAL };
    // A reserved creation's source must still be where it was reserved; the fork moving with it isn't enough.
    if (config && ((original.workspaceId ?? null) !== config.workspaceId || (original.cwd ?? null) !== config.cwd)) return { refused: MOVED_REFUSAL };
    if (!fork || !ready(fork) || fork.provider !== OPENCODE_PROVIDER || fork.labels?.[CONTINUED_FROM_LABEL] !== agentId ||
      !sameForkPlace(original, fork) || fork.labels?.[PARENT_LABEL]?.trim() !== expectedParent) return { refused: MOVED_REFUSAL };
    if (config && (fork.lastUserMessageAt || fork.title !== config.title)) return { refused: MOVED_REFUSAL };
    if (!withinMode(sourceModes, original.currentModeId, targetModes, fork.currentModeId)) return { refused: MODE_REFUSAL };
    return { original, fork };
  }

  /** What the source gained after `mark`: proven newer conversation, nothing, or unreadable history. */
  private async sourceSince(paseo: PaseoApi, agentId: string, mark: TimelineMark): Promise<"newer" | "same" | "epoch" | "gap"> {
    try {
      const { entries } = await readUpdates(paseo, agentId, mark, undefined, { onEpochReset: "unresolvable" });
      return meaningful(entries).length > 0 ? "newer" : "same";
    } catch (error) {
      return error instanceof UnresolvableEpochError ? "epoch" : "gap";
    }
  }

  /** A found fork with no provable checkpoint, or history that can't be read: link it, send nothing. */
  private openCodeFound(fork: { id: string; title?: string | null }, detail = FOUND_DETAIL): ForkOutcome {
    return {
      fork: { agentId: fork.id, title: forkRef(fork) },
      to: OPENCODE_LABEL,
      toFamily: null,
      toProvider: OPENCODE_PROVIDER,
      delivery: "found",
      detail,
    };
  }

  /** An unconfirmed handoff: the reservation stays, the row links the fork, nothing is claimed. */
  private openCodeUncertain(forkId: string, title: string | null | undefined, messageId: string): ForkOutcome {
    const ref = title?.trim() ? title : `${OPENCODE_LABEL} agent ${forkId}`;
    return {
      fork: { agentId: forkId, title: ref },
      to: OPENCODE_LABEL,
      toFamily: null,
      toProvider: OPENCODE_PROVIDER,
      delivery: "uncertain",
      detail: uncertainDetail(ref, messageId),
    };
  }

  /** Whether the fork's timeline proves this exact message arrived, by ID or by marker plus digest. */
  private async hasReceipt(paseo: PaseoApi, forkId: string, messageId: string, digest: string): Promise<boolean> {
    // An incomplete or failed scan proves nothing: the caller keeps the reservation, never resends.
    try {
      const timeline = paseo.agents.ref(forkId).timeline;
      let page = await timeline.refetch({ direction: "tail", limit: 500, projection: "canonical" });
      for (let pages = 1; ; pages += 1) {
        if (page.entries.some((entry) => matchesTransfer(entry, messageId, digest))) return true;
        if (!page.hasOlder || page.gap || page.staleCursor || pages >= RECEIPT_PAGES || !page.startCursor) return false;
        page = await timeline.refetch({ direction: "before", cursor: page.startCursor, limit: 500, projection: "canonical" });
        if (page.gap || page.staleCursor) return false;
      }
    } catch {
      return false;
    }
  }

  /** Records what the fork has seen once its receipt matched, clearing the reservation. */
  private async settleOpenCode(agentId: string, messageId: string): Promise<void> {
    await this.store.update((draft) => {
      const record = draft.opencodeForks[agentId];
      if (record?.pending?.messageId === messageId) {
        record.seen = record.pending.seen;
        delete record.pending;
      }
    });
  }

  /** Sends the source's newest instructions to an existing OpenCode fork, once, under one message ID. */
  /** `sourceAt` is the source's last user message time as checked before its history was read. */
  private async updateOpenCodeFork(
    paseo: PaseoApi,
    agentId: string,
    fork: Agent,
    seen: TimelineMark,
    sourceAt: string | null | undefined,
  ): Promise<ForkOutcome> {
    let delta: Awaited<ReturnType<typeof readUpdates>>;
    try {
      delta = await readUpdates(paseo, agentId, seen, undefined, { onEpochReset: "unresolvable" });
    } catch (error) {
      // A gap or new epoch means what the fork has can't be proven; refuse honestly instead of guessing.
      return this.openCodeFound(fork, error instanceof UnresolvableEpochError ? FOUND_DETAIL : HISTORY_GAP_DETAIL);
    }
    // Only meaningful conversation advances a turn. Plugin rows, including our own notes, do not.
    const items = meaningful(delta.entries).map((entry) => entry.item);
    if (!items.length) {
      await this.store.update((draft) => {
        const record = draft.opencodeForks[agentId];
        if (record) record.seen = delta.mark;
      });
      // Input can land while the watermark is saved. The mark stays where it was inspected, and
      // "up to date" holds only if the source still has nothing newer and is still stopped.
      const since = await this.sourceSince(paseo, agentId, delta.mark);
      if (since === "newer") return { skipped: NEWER_REFUSAL };
      if (since !== "same") return this.openCodeFound(fork, since === "epoch" ? FOUND_DETAIL : HISTORY_GAP_DETAIL);
      const now = await snapshot(paseo, agentId);
      if (!now || !ready(now)) return { skipped: SOURCE_BUSY_REFUSAL };
      // A message that landed after the history read shows only in the source's own timestamp.
      if (now.lastUserMessageAt !== sourceAt) return { skipped: NEWER_REFUSAL };
      return {
        fork: { agentId: fork.id, title: forkRef(fork) },
        to: OPENCODE_LABEL,
        toFamily: null,
        toProvider: OPENCODE_PROVIDER,
        delivery: "up-to-date",
        detail: UP_TO_DATE_DETAIL,
      };
    }
    // Instructions are prompts from a human, another agent or a schedule, as in a Codex continuation.
    const instructions = fitInstructions(items.flatMap((item) => {
      const text = promptInstruction(item);
      return text?.trim() ? [text] : [];
    }));
    const progress = buildTranscript(items.filter((item) => promptInstruction(item) === null));
    const messageId = `${MESSAGE_PREFIX}${randomUUID()}`;
    const prompt = updatePrompt(instructions, progress, PROVIDER_NAME.claude, transferMarker(messageId));
    const checked = await this.freshOpenCodeTarget(paseo, agentId, fork.id, delta.mark);
    if ("refused" in checked) return checked.unreadable ? this.openCodeFound(fork, checked.refused) : { skipped: checked.refused };
    // Reserved before any send: an uncertain dispatch must never send a second copy.
    await this.store.update((draft) => {
      const record = draft.opencodeForks[agentId] ?? { forkAgentId: fork.id };
      record.pending = { stage: "sending", targetId: fork.id, messageId, seen: delta.mark, sentDigest: sentDigestOf(prompt) };
      draft.opencodeForks[agentId] = record;
    });
    // Again after the write: input or modes can change while it commits. Nothing is sent yet, so a
    // refusal here drops the reservation instead of leaving it uncertain.
    const recheck = await this.freshOpenCodeTarget(paseo, agentId, fork.id, delta.mark);
    if ("refused" in recheck) {
      await this.store.update((draft) => {
        const record = draft.opencodeForks[agentId];
        if (record?.pending?.messageId === messageId) delete record.pending;
      });
      return recheck.unreadable ? this.openCodeFound(fork, recheck.refused) : { skipped: recheck.refused };
    }
    return this.sendReserved(paseo, agentId, recheck.fork, prompt, messageId);
  }

  /**
   * Starts a fresh OpenCode fork: reserve the target and its create request, create promptless, then
   * deliver the initial handoff under the reserved message ID. `retry` is a reservation whose create
   * never landed: its target ID, message ID and reason are kept, and the rest is read afresh.
   */
  private async createOpenCodeFork(
    paseo: PaseoApi,
    agentId: string,
    original: Agent,
    source: "auto" | "user",
    retry?: NonNullable<OpenCodeFork["pending"]>,
  ): Promise<ForkOutcome> {
    const chatGptCopy = (await listAgents(paseo, false)).agents.find((agent) => agent.continuedFrom === agentId && agent.provider !== OPENCODE_PROVIDER);
    if (chatGptCopy) return { skipped: alreadyContinued(chatGptCopy.title ?? `${PROVIDER_NAME["codex"]} agent ${chatGptCopy.id}`) };
    // A create whose outcome was never seen may be in Paseo under its key, which stays tied to its
    // first request: only that exact request may be sent again.
    if (retry && !retry.createFailed) {
      const reserved = retry.config;
      // A reservation saved before the request was frozen whole can't be repeated exactly.
      if (!reserved?.title || reserved.workspaceId === undefined || reserved.cwd === undefined || reserved.parentId === undefined) {
        return this.openCodeUncertain(retry.targetId, null, retry.messageId);
      }
      return this.sendReservedCreate(paseo, agentId, retry.targetId, retry.messageId, { ...reserved, title: reserved.title }, true);
    }
    const { models, error } = await paseo.providers.listModels(OPENCODE_PROVIDER);
    if (error) return { skipped: `Couldn't read this host's ${OPENCODE_LABEL} models: ${error}` };
    const savedModel = this.prefs.forkOpenCodeModel;
    const model = savedModel ? models?.find((entry) => entry.id === savedModel) : models?.find((entry) => entry.isDefault);
    if (savedModel && !model) {
      return { skipped: "The saved OpenCode model is no longer in this host's catalog. Pick one in ZeroSub's settings." };
    }
    if (!model) return { skipped: `No OpenCode model is marked default on this host. Pick one in ZeroSub's settings.` };
    // A "default" saved from Paseo 0.16's own Default option sends no variant, as the model default does.
    const thinking = this.prefs.forkOpenCodeThinking === "default" ? "" : this.prefs.forkOpenCodeThinking;
    if (thinking && !model.thinkingOptions?.some((option) => option.id === thinking)) {
      return { skipped: `“${model.label}” no longer offers the saved thinking option. Pick one in ZeroSub's settings.` };
    }

    const [sourceModes, targetModes] = await Promise.all([
      paseo.providers.listModes(original.provider).then((result) => result.modes ?? []),
      paseo.providers.listModes(OPENCODE_PROVIDER).then((result) => result.modes ?? []),
    ]);
    const modeId = equivalentMode(sourceModes, original.currentModeId, targetModes);
    if (!modeId) {
      const current = sourceModes.find((mode) => mode.id === original.currentModeId)?.label;
      return {
        skipped: `${OPENCODE_LABEL} has no mode as careful as this agent's${current ? ` (“${current}”)` : ""}, so ZeroSub didn't continue it there.`,
      };
    }

    let delta: Awaited<ReturnType<typeof readUpdates>>;
    try {
      delta = await readUpdates(paseo, agentId);
    } catch {
      return { skipped: HISTORY_GAP_DETAIL };
    }

    const parentId = await this.continuations.parentFor(paseo, agentId);
    const config = {
      provider: `${OPENCODE_PROVIDER}/${model.id}`,
      modeId,
      ...(thinking ? { thinkingOptionId: thinking } : {}),
      workspaceId: original.workspaceId ?? null,
      cwd: original.cwd ?? null,
      parentId: parentId ?? null,
      title: `${original.title?.trim() || "Task"} (continued on ${OPENCODE_LABEL})`,
    };
    // Paseo keeps a failed create's request under its key: the same request may use that key again,
    // and any other request needs new IDs. The failed one can't land later, so this can't double.
    // A key Paseo answers with outcome unknown stays failed for good, so it is never reused.
    const reuse = retry !== undefined && !retry.createOutcomeUnknown && sameCreate(retry.config, config);
    const targetId = reuse ? retry.targetId : randomUUID();
    const messageId = reuse ? retry.messageId : `${MESSAGE_PREFIX}${randomUUID()}`;
    const why = (reuse ? retry.config?.why : undefined) ?? (source === "auto" ? "every Claude account reached its usage limit" : "the work was moved to OpenCode");
    const prompt = [continuationPrompt(buildTranscript(delta.entries.map((entry) => entry.item)), why, PROVIDER_NAME.claude), transferMarker(messageId)].join("\n");
    await this.store.update((draft) => {
      // A new reservation is this source's journal again; a hold it was told about is spent.
      delete draft.opencodeHolds[agentId];
      draft.opencodeForks[agentId] = {
        forkAgentId: targetId,
        pending: { stage: "creating", targetId, messageId, seen: delta.mark, config: { ...config, why }, sentDigest: sentDigestOf(prompt) },
      };
    });
    return this.sendReservedCreate(paseo, agentId, targetId, messageId, config, false);
  }

  /**
   * Sends a reserved promptless create, then its reserved handoff once the fork exists.
   * `outcomeUnknown`: Paseo may hold this key's request with no answer seen, so a refusal keeps it.
   */
  private async sendReservedCreate(
    paseo: PaseoApi,
    agentId: string,
    targetId: string,
    messageId: string,
    config: OpenCodeCreateConfig & { title: string },
    outcomeUnknown: boolean,
  ): Promise<ForkOutcome> {
    const markFailed = (keyLost = false) =>
      this.store.update((draft) => {
        const pending = draft.opencodeForks[agentId]?.pending;
        if (pending?.messageId !== messageId) return;
        pending.createFailed = true;
        if (keyLost) pending.createOutcomeUnknown = true;
      });
    let sending = false;
    try {
      await continueInNewAgent({
        paseo,
        sourceAgentId: agentId,
        previous: PROVIDER_NAME.claude,
        agentId: targetId, // also the create's idempotency key, so a retried create can't double it
        deferPrompt: true,
        target: {
          provider: OPENCODE_PROVIDER,
          label: OPENCODE_LABEL,
          modeId: config.modeId,
          model: config.provider.slice(`${OPENCODE_PROVIDER}/`.length),
          ...(config.thinkingOptionId ? { thinkingOptionId: config.thinkingOptionId } : {}),
        },
        parentId: config.parentId ?? undefined,
        reserved: { title: config.title, workspaceId: config.workspaceId ?? null, cwd: config.cwd ?? null },
        // OpenCode is a harness, not an account provider: no binding to record. Binding is the
        // helper's last step before it sends the create.
        bind: async () => {
          sending = true;
        },
        onCreateRejected: markFailed,
      });
    } catch (error) {
      // Refused before the create was sent: Paseo has no record under this key, or only a failed one.
      if (!sending && !outcomeUnknown) await markFailed();
      throw error;
    }
    const fork = await waitForCreated(paseo, targetId);
    if (!fork) return this.openCodeUncertain(targetId, null, messageId);
    return this.deliverReservedOpenCode(paseo, agentId, fork);
  }

  /** Sends the reserved initial handoff to a created promptless fork, under its reserved message ID. */
  private async deliverReservedOpenCode(paseo: PaseoApi, agentId: string, fork: Agent): Promise<ForkOutcome> {
    const pending = (await this.store.read()).opencodeForks[agentId]?.pending;
    if (!pending || pending.stage !== "creating") {
      throw new Error("The OpenCode fork's reservation changed during the handoff. Check the fork's chat and retry.");
    }
    const config = pending.config;
    // The prompt is rebuilt from the reason frozen with the reservation: a retry's own trigger must
    // not change it, and a reservation old enough to lack the reason can't be reconstructed safely.
    if (!config?.why || !pending.sentDigest) return this.openCodeUncertain(fork.id, fork.title, pending.messageId);
    let delta: Awaited<ReturnType<typeof readUpdates>>;
    try {
      delta = await readUpdates(paseo, agentId, undefined, undefined, { onEpochReset: "unresolvable" });
    } catch {
      return this.openCodeUncertain(fork.id, fork.title, pending.messageId);
    }
    if (delta.mark.epoch !== pending.seen.epoch) return this.openCodeUncertain(fork.id, fork.title, pending.messageId);
    const why = config.why;
    const compose = (entries: typeof delta.entries) =>
      [continuationPrompt(buildTranscript(entries.map((entry) => entry.item)), why, PROVIDER_NAME.claude), transferMarker(pending.messageId)].join("\n");
    // The reserved prompt must still rebuild to its digest before anything is sent or rebuilt.
    const reserved = compose(delta.entries.filter((entry) => entry.seqEnd <= pending.seen.seq));
    if (sentDigestOf(reserved) !== pending.sentDigest) return this.openCodeUncertain(fork.id, fork.title, pending.messageId);
    // Nothing has been sent yet (the target is checked promptless below), so source instructions newer
    // than the reservation are folded in by rebuilding it, never left behind an older request.
    const newer = meaningful(delta.entries.filter((entry) => entry.seqEnd > pending.seen.seq)).length > 0;
    const prompt = newer ? compose(delta.entries) : reserved;
    const checked = await this.freshOpenCodeTarget(paseo, agentId, fork.id, delta.mark, config);
    if ("refused" in checked) return this.openCodeUncertain(fork.id, fork.title, pending.messageId);
    await this.store.update((draft) => {
      const record = draft.opencodeForks[agentId];
      if (record?.pending?.messageId === pending.messageId) {
        record.pending.stage = "sending";
        record.pending.seen = newer ? delta.mark : pending.seen;
        record.pending.sentDigest = sentDigestOf(prompt);
      }
    });
    // Again after the write. Nothing is sent yet, so a refusal returns the reservation to the
    // promptless state it was frozen in, for the next call to rebuild.
    const recheck = await this.freshOpenCodeTarget(paseo, agentId, fork.id, delta.mark, config);
    if ("refused" in recheck) {
      await this.store.update((draft) => {
        const record = draft.opencodeForks[agentId];
        if (record?.pending?.messageId === pending.messageId) record.pending = pending;
      });
      return recheck.unreadable ? this.openCodeUncertain(fork.id, fork.title, pending.messageId) : { skipped: recheck.refused };
    }
    return this.sendReserved(paseo, agentId, recheck.fork, prompt, pending.messageId);
  }

  /**
   * Sends a reserved prompt. A send can fail after the daemon took it, so a throw proves nothing:
   * the receipt decides, and without one the reservation stays and the result is uncertain.
   */
  private async sendReserved(paseo: PaseoApi, agentId: string, fork: Agent, prompt: string, messageId: string): Promise<ForkOutcome> {
    try {
      await paseo.agents.ref(fork.id).send(prompt, { messageId });
    } catch {
      // Possibly delivered: the receipt check below decides.
    }
    return this.confirmOpenCode(paseo, agentId, fork, messageId);
  }

  /** Checks the fork's timeline for the reserved message; a match settles, anything else stays reserved. */
  private async confirmOpenCode(paseo: PaseoApi, agentId: string, fork: { id: string; title?: string | null }, messageId: string): Promise<ForkOutcome> {
    const pending = (await this.store.read()).opencodeForks[agentId]?.pending;
    if (pending?.stage === "sending" && pending.messageId === messageId && pending.sentDigest !== undefined &&
      (await this.hasReceipt(paseo, fork.id, messageId, pending.sentDigest))) {
      await this.settleOpenCode(agentId, messageId);
      return {
        fork: { agentId: fork.id, title: forkRef(fork) },
        to: OPENCODE_LABEL,
        toFamily: null,
        toProvider: OPENCODE_PROVIDER,
        delivery: "sent",
      };
    }
    return this.openCodeUncertain(fork.id, fork.title, messageId);
  }

  /** "Continue on …" from an agent's account button: the same fork, asked for by the user. */
  async forkAgent(paseo: PaseoApi, agentId: string, destination: "other" | "opencode" = "other"): Promise<Continuation & { delivery: ForkDelivery }> {
    return this.withSwitch(agentId, () => this.forkAgentNow(paseo, agentId, destination));
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

  private async forkAgentNow(paseo: PaseoApi, agentId: string, destination: "other" | "opencode" = "other"): Promise<Continuation & { delivery: ForkDelivery }> {
    this.attach(paseo);
    const info = await lookUpAgent(paseo, agentId);
    if (!info || info.archived) throw new Error("That agent is no longer available.");
    const family = (await this.families.resolve(paseo))[info.provider];
    if (!family) throw new Error(`${info.provider} agents don't use Claude, ChatGPT, Grok or Cursor subscription accounts.`);
    if (info.status === "running" || info.status === "initializing") {
      throw new Error("This agent is working right now. Wait for its turn to finish, then continue it elsewhere.");
    }
    let result: ForkOutcome;
    if (destination === "opencode") {
      if (family !== "claude") throw new Error("Only Claude agents can continue on OpenCode.");
      result = await this.forkToOpenCode(paseo, agentId, "user");
    } else {
      result = await this.forkToOtherProvider(paseo, agentId, family, undefined, "user");
    }
    if ("skipped" in result) throw new Error(result.skipped);
    const state = await this.store.read();
    await this.appendRow(paseo, agentId, {
      family,
      from: findAccount(state, this.runningOn(state, agentId, family))?.label ?? null,
      to: result.to,
      reason: "manual",
      resetsAt: null,
      continued: result.delivery === "sent",
      continuedIn: result.fork,
      toFamily: result.toFamily,
      toProvider: result.toProvider,
      outcome: result.delivery === "sent" ? "continued" : "stayed",
      delivery: result.delivery,
      detail: result.detail ?? null,
      at: new Date().toISOString(),
    });
    return { ...result.fork, delivery: result.delivery };
  }

  /**
   * Reloads this Codex agent on `next` when both accounts are members of one workspace and `next`
   * really links `sessions/`. One write updates the binding and this agent's continuation record,
   * so a later handoff still sees one tab. A failed reload puts that write back and returns false,
   * and the caller opens today's new tab.
   */
  private async keptSameConversation(
    paseo: PaseoApi,
    agentId: string,
    account: StoredAccount,
    next: StoredAccount,
    problem: Problem,
    base: Omit<SwitchRow, "to" | "reason" | "outcome">,
    reason: SwitchRow["reason"],
    endedAt: number,
  ): Promise<boolean> {
    if (problem.kind !== "limit" || account.family !== "codex" || next.family !== "codex") return false;
    const eligible = codexHandoffMode({
      enabled: this.prefs.codexSameConversation && !this.sameConversationBlocked.has(agentId),
      sameWorkspace: sameWorkspace(account.identity, next.identity),
      // The link is checked below, after the other gates, so a disabled option does not touch homes.
      sessionsShared: true,
      limitMessage: problem.hit.message,
    });
    if (eligible === "new-tab") return false;
    await this.prepareSharedSessions(account);
    await this.prepareSharedSessions(next);
    if (!(await codexSessionsShared(next.home, account.home))) return false;

    const seen = await this.store.read();
    const previousBinding = seen.bindings[agentId];
    const members = this.conversationPins(seen, agentId);
    await this.store.update((draft) => {
      draft.bindings[agentId] = { accountId: next.id, source: "auto", at: new Date().toISOString() };
      for (const chain of Object.values(draft.continuations)) {
        const member = chain.members[agentId];
        if (!member) continue;
        member.accountId = next.id;
        member.identity = next.identity;
        member.email = next.email;
      }
    });
    const result = await this.reopenAgent(paseo, agentId, { settle: true, sameConversation: true });
    const landed = (await this.store.read()).sessions[agentId]?.accountId === next.id;
    if (result.outcome !== "reopened" || !landed) {
      this.deferred.delete(agentId);
      await this.restoreConversationPin(agentId, previousBinding, members);
      return false;
    }
    this.switchGuard.note(agentId, Date.now());
    this.sameConversationProbe.set(agentId, { fromAccountId: account.id, toAccountId: next.id, previousBinding, members });
    const continued = this.prefs.autoContinue && (await this.untouchedSince(paseo, agentId, endedAt));
    await this.appendRow(paseo, agentId, {
      ...base,
      to: next.label,
      reason,
      continued,
      outcome: "switched",
      sameConversation: true,
    });
    if (continued) await this.carryOn(paseo, agentId, endedAt);
    return true;
  }

  /**
   * Puts the agent back on the account that can read the thread, then hands off to the other as
   * today: a new tab there, or only a note while Keep going after a switch is off.
   */
  private async revertSameConversation(
    paseo: PaseoApi,
    agentId: string,
    family: Family,
    probe: SameConversationProbe,
    timeline: readonly AgentTimelineItem[] | undefined,
  ): Promise<void> {
    const release = await this.claim(agentId);
    try {
      await this.restoreConversationPin(agentId, probe.previousBinding, probe.members);
      await this.reopenAgent(paseo, agentId, { settle: true, sameConversation: true });
      const state = await this.store.read();
      const from = findAccount(state, probe.fromAccountId);
      const to = findAccount(state, probe.toAccountId);
      if (!from || !to || family !== "codex") return;
      if (!this.prefs.autoContinue) {
        await this.appendRow(paseo, agentId, {
          family,
          from: from.label,
          to: to.label,
          reason: "limit",
          resetsAt: from.limitedUntil,
          continued: false,
          continuedIn: null,
          toFamily: null,
          toProvider: null,
          outcome: "stayed",
          detail: `New ${FAMILY_LABEL[family]} agents will use ${to.label}.`,
          at: new Date().toISOString(),
        });
        return;
      }
      const why = `its ChatGPT account (${from.label}) reached its usage limit, and ${to.label} could not resume the thread`;
      try {
        const continuation = await this.continueElsewhere(paseo, agentId, to, why, timeline, "auto");
        await this.appendRow(paseo, agentId, {
          family,
          from: from.label,
          to: to.label,
          reason: "limit",
          resetsAt: from.limitedUntil,
          continued: true,
          continuedIn: continuation,
          toFamily: null,
          toProvider: null,
          outcome: "continued",
          detail: `${to.label} could not resume this thread.`,
          at: new Date().toISOString(),
        });
      } catch (error) {
        log(`could not continue ${agentId} on ${to.label}`, error);
        await this.appendRow(paseo, agentId, {
          family,
          from: from.label,
          to: to.label,
          reason: "limit",
          resetsAt: from.limitedUntil,
          continued: false,
          continuedIn: null,
          toFamily: null,
          toProvider: null,
          outcome: "stayed",
          detail: `Couldn't continue on ${to.label}: ${describe(error)}`,
          at: new Date().toISOString(),
        });
      }
    } finally {
      release();
    }
  }

  private conversationPins(state: StoredState, agentId: string): ConversationMemberPin[] {
    const pins: ConversationMemberPin[] = [];
    for (const [chainId, chain] of Object.entries(state.continuations)) {
      const member = chain.members[agentId];
      if (!member) continue;
      pins.push({ chainId, accountId: member.accountId, identity: member.identity, email: member.email });
    }
    return pins;
  }

  private async restoreConversationPin(agentId: string, binding: Binding | undefined, members: readonly ConversationMemberPin[]): Promise<void> {
    await this.store.update((draft) => {
      if (binding) draft.bindings[agentId] = binding;
      else delete draft.bindings[agentId];
      for (const pin of members) {
        const member = draft.continuations[pin.chainId]?.members[agentId];
        if (!member) continue;
        member.accountId = pin.accountId;
        member.identity = pin.identity;
        member.email = pin.email;
      }
    });
  }

  /** Makes the shared session link before a same-conversation reload. A failed link only warns. */
  private async prepareSharedSessions(account: StoredAccount): Promise<void> {
    if (account.kind !== "managed" || !account.home || account.family !== "codex") return;
    await this.adapters.codex.prepareHome(account.home, this.stillHas(account)).catch((error: unknown) =>
      log(`could not refresh the home of ${account.label}`, error),
    );
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
  private routeFor(state: StoredState, agentId: string, family: Family, current?: string, paid = this.paidFor(family, agentId)): RouteDecision | null {
    return chooseAccount(state, {
      agentId,
      family,
      reason: "refresh",
      now: Date.now(),
      autoSwitch: this.prefs.autoSwitch,
      balanceNewAgents: false,
      paidFallback: paid,
      autoRedeem: this.prefs.autoRedeem,
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
    options: { row?: SwitchRow | null; settle?: boolean; background?: boolean; unattended?: boolean; sameConversation?: boolean } = {},
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
    // A same-conversation reload already pinned this thread to the other account. This guard would
    // pin it back to the session it is leaving, so that one reload skips it.
    if (!options.sameConversation && family && !this.adapters[family].portable && info.hasHistory && (state.sessions[agentId] || !state.bindings[agentId])) {
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
          toProvider: null,
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
        // A reload can't move an agent of a family that isn't available here: its session opens on
        // the CLI login again (see `route`).
        if (!family || this.availability.get(family)?.ok === false || routing.has(agentId) || this.switching.has(agentId) || this.recentlyActive(agent, now)) continue;
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
    if (!canReopen || this.failedMoves.get(agent.id) === target || this.availability.get(family)?.ok === false) return "restart";
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
    if (this.leavesPaid(state, current, target)) return "room";
    return state.bindings[agentId]?.accountId === target ? "manual" : "default";
  }

  /**
   * Whether a move takes an agent off a paid stand-in (Bedrock) onto a subscription account: routing
   * sends it back once its own account, or the default it follows, has room again, and alignment makes
   * that move by itself, so the agent doesn't stay on the bill. One the user put on the stand-in
   * (picked for it, or made the default) is routed there anyway, so it never comes to this.
   */
  private leavesPaid(state: StoredState, current: string, target: string): boolean {
    const from = findAccount(state, current);
    const to = findAccount(state, target);
    return Boolean(from && to && isLastResort(from) && !isLastResort(to));
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
      // A reading only takes a limit from the account's own windows, so its limit clears on those:
      // one model's full window (Claude's "Weekly · Fable") doesn't hold it, nor one set by a
      // version that still took any full window for the account's.
      const settled = account.limitedAt ? now - Date.parse(account.limitedAt) > LIMIT_TRUST_MS : true;
      const fromReading = account.limitSource === "reading";
      const watched = fromReading ? usage.windows.filter(capsAccount) : usage.windows;
      const stillFull = fromReading ? cutOff : full;
      const roomy = (creditsCover && fromReading) || Math.max(...watched.map((window) => window.usedPercent)) < 90;
      if (!stillFull && account.limitedUntil && account.limitKind === "window" && settled && roomy) {
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

    const claudeScripts = this.launcherAccounts(state);
    const piScripts = this.launcherAccounts(state, "pi");
    const launcherOf = this.launcherFiles ?? new Map([...launcherNames(claudeScripts), ...launcherNames(piScripts, new Map(), "pi")]);
    const proxies = new Map<string, ProxyState>();
    const apis = new Map<string, ApiSummary | null>();
    const azures = new Map<string, AzureSummary>();
    const bedrocks = new Map<string, BedrockSummary>();
    const apiMonths: ApiUsageFile = await this.apiUsage.read().catch(() => ({ accounts: {}, threads: {} }));
    const external = new Set<string>();
    await Promise.all(
      state.accounts.map(async (account) => {
        const adapter = this.adapters[account.family];
        // A home of null is the CLI's own login; its files are only read here.
        if (adapter.proxyState && (account.kind === "main" || account.home)) {
          const unknown = (error: unknown): ProxyState => ({ own: null, file: null, inherited: null, blocked: describe(error) });
          proxies.set(account.id, await adapter.proxyState(account.home).catch(unknown));
        }
        if (account.kind === "main" && adapter.mainApi && adapter.api) apis.set(account.id, await adapter.api(null).catch(() => null));
        if (account.kind !== "managed" || !account.home) return;
        if (adapter.homesInUse && !(await isOwnHome(account.home))) external.add(account.id);
        if (account.auth === "api" && adapter.api) apis.set(account.id, await adapter.api(account.home).catch(() => null));
        if (isAzureAccount(account)) {
          // Only the key's hint goes to the app (see azureSummary).
          const settings = await readAzureAccount(account.home).catch(() => null);
          if (settings) azures.set(account.id, azureSummary(settings, currentMonth(apiMonths.accounts[account.id], now)));
        }
        if (isBedrockAccount(account)) {
          // Never the secret or session token, only the key ID's hint (see bedrockSummary).
          const settings = await readBedrockAccount(account.home).catch(() => null);
          if (settings) bedrocks.set(account.id, bedrockSummary(settings, currentMonth(apiMonths.accounts[account.id], now)));
        }
      }),
    );
    // A proxy kept in the user's file (Pi's own login's in its settings) is also the one every added
    // account without its own goes through.
    const followers = (family: Family) =>
      state.accounts.filter((other) => other.family === family && other.kind === "managed" && proxies.get(other.id)?.own === null).map((other) => other.label);
    const homesNow = (family: PlacedFamily) => homesDirFor(family, state[HOMES_KEY[family]]);
    const due = new Set((await this.dueMoves(state)).map((account) => account.id));
    const moving = (account: StoredAccount): AccountView["moving"] => {
      const move = state.moves[account.id];
      if (!move && !due.has(account.id)) return null;
      const note = this.moveNotes.get(account.id);
      return { to: shownPath(move?.to ?? homesNow(account.family === "pi" ? "pi" : "claude")), waiting: note?.waiting ?? null, error: note?.error ?? null };
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
        api: apiView(apis.get(account.id)),
        // Azure and Bedrock accounts have forms of their own (see `azure`, `bedrock`).
        apiEditable: (account.auth === "api" && !isLastResort(account)) || (account.kind === "main" && this.adapters[account.family].mainApi === true),
        proxy: proxy?.own ? maskProxy(proxy.own) : null,
        proxyEditable: proxy !== undefined,
        proxyBlocked: proxy?.blocked ?? null,
        inheritedProxy: proxy?.inherited ? { ...proxy.inherited, proxy: maskProxy(proxy.inherited.proxy) } : null,
        proxyFile: proxy?.file ?? null,
        proxyFollowers: proxy?.file ? followers(account.family) : [],
        launcher: launcherOf.get(account.id) ?? null,
        egress: this.egress.get(account.id) ?? null,
        externalHome: external.has(account.id),
        moving: moving(account),
        azure: azures.get(account.id) ?? null,
        bedrock: bedrocks.get(account.id) ?? null,
        apiError: !account.signedIn && isLastResort(account) ? (account.apiError ?? null) : null,
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
      openCodeAvailable: await this.openCodeAvailable(paseo),
      autoSwitch: this.prefs.autoSwitch,
      balanceNewAgents: this.prefs.balanceNewAgents,
      agentMetadata: takesAgentMetadata(paseo),
      paidApiFallback: this.prefs.paidApiFallback,
      warnings: await this.warnings(),
      launchers: claudeScripts.length > 0 ? launcherDir() : null,
      piLaunchers: piScripts.length > 0 ? piLauncherDir() : null,
      claudeHomes: this.adapters.claude.homesInUse ? { dir: shownPath(homesNow("claude")), isDefault: state.claudeHomes.dir === null } : null,
      piHomes: this.adapters.pi.homesInUse ? { dir: shownPath(homesNow("pi")), isDefault: state.piHomes.dir === null } : null,
    };
  }

  /**
   * Whether Paseo lists OpenCode as available, read at most once a minute. A failed read keeps the last good
   * answer and must not break the whole state view. Only the menu entry uses this; the fork checks again itself.
   */
  private async openCodeAvailable(paseo: PaseoApi): Promise<boolean> {
    if (this.openCodeCache && Date.now() - this.openCodeCache.at < OPENCODE_AVAILABLE_MS) return this.openCodeCache.available;
    try {
      const result = await paseo.providers.listAvailable();
      if (result.error) throw new Error(result.error);
      const available = Boolean(result.providers?.some((entry) => entry.provider === OPENCODE_PROVIDER && entry.available));
      this.openCodeCache = { at: Date.now(), available };
      return available;
    } catch {
      return this.openCodeCache?.available ?? false;
    }
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
    const agents = listAgents(paseo, false).then((result) => {
      for (const agent of result.agents) this.agentModes.set(agent.id, agent.modeId);
      return result.agents;
    });
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
      // An optional provider (Pi, Grok, Cursor) is only missed once an account of it was added.
      if (OPTIONAL[family] && !state.accounts.some((account) => account.family === family && account.kind === "managed")) continue;
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
    // Only once Grok is on the Accounts screen (its CLI login registered or an account of it added), like `shownFamilies`.
    const grokSignIn = process.env.GROK_AUTH_PROVIDER_COMMAND || (process.env.GROK_OIDC_ISSUER && process.env.GROK_OIDC_CLIENT_ID);
    if (grokSignIn && state.accounts.some((account) => account.family === "grok")) {
      warnings.push(
        "The daemon's environment sets a Grok sign-in (GROK_AUTH_PROVIDER_COMMAND, or GROK_OIDC_ISSUER and GROK_OIDC_CLIENT_ID). Grok agents on your CLI login use it; added Grok accounts don't, so one that can only sign in that way may fail to sign in or stay signed in.",
      );
    }
    // Only once Cursor is on the Accounts screen (its CLI login registered or an account of it added), like `shownFamilies`.
    const cursorLogin = ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"].filter((key) => process.env[key]);
    if (cursorLogin.length > 0 && state.accounts.some((account) => account.family === "cursor")) {
      const it = cursorLogin.length > 1 ? "them" : "it";
      warnings.push(
        `The daemon's environment sets ${cursorLogin.join(" and ")}. Cursor agents on your CLI login use ${it}, and cursor-agent saves ${it} as that login; added Cursor accounts don't.`,
      );
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
        previous = draft.defaults[account.family] ?? null;
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
    if (!enabled && !mostAvailable(state, account.family, (id) => this.usage.get(id), Date.now(), new Set([account.id]), this.prefs.paidApiFallback)) {
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
    if (!family) throw new Error(`${info.provider} agents don't use Claude, ChatGPT, Grok or Cursor subscription accounts.`);
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
        if (!HAND_OFF[family]) throw new Error(stays(family, findAccount(state, current)?.label ?? null));
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
            toProvider: null,
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
            toProvider: null,
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
    await this.refreshLaunchers().catch((error: unknown) => log("could not write the shell launchers", error));
  }

  /** Removes an account. Moving its agents can outlast the RPC: see `answerBy`. */
  async remove(paseo: PaseoApi, accountId: string): Promise<{ affected: number; moves: ReopenSummary }> {
    const replyBy = Date.now() + REPLY_WAIT_MS;
    this.attach(paseo);
    const state = await this.store.read();
    const account = findAccount(state, accountId);
    if (!account) throw new Error("That account no longer exists.");
    if (account.kind === "main") {
      throw new Error("Your CLI login can't be removed here. Sign out with `claude auth logout`, `codex logout`, `grok logout`, `cursor-agent logout` or Pi's /logout instead.");
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
        const elsewhere = !HAND_OFF[account.family] ? "" : ` or continue ${one ? "it" : "them"} on another account from the account button`;
        throw new Error(
          `${stranded.length} ${FAMILY_LABEL[account.family]} conversation${one ? "" : "s"} still ${one ? "runs" : "run"} on ${account.label} and can't move to another account. Archive ${
            one ? "it" : "them"
          } (the work stays in your files)${elsewhere}, then remove ${account.label}.`,
        );
      }
    }
    const affected = Object.entries(state.sessions)
      .filter(([, session]) => session.accountId === accountId)
      .map(([agentId]) => agentId);
    // A home kept outside ZeroSub's own `homes/` (where added Claude and Pi accounts are kept) is the
    // user's: removing its account only takes it out of ZeroSub, and its folder, sign-in or key and
    // script stay.
    const kept = account.home !== null && !(await isOwnHome(account.home));
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
    if (isLastResort(account)) await this.apiUsage.forget(accountId).catch((error: unknown) => log(`could not forget ${account.label}'s token counts`, error));
    if (account.home && kept) console.log(`[ZeroSub] removed ${account.label} from ZeroSub only: ${account.home} isn't a folder ZeroSub made in ${homesDir()}, so its files and script stay`);
    // Its script is released rather than deleted when its home stays (see writeLaunchers).
    await this.refreshLaunchers(account.home && !kept ? [account.home] : []).catch((error: unknown) => log("could not write the shell launchers", error));
    // Idle agents move now and busy ones after their turn. The home is signed out and deleted by the
    // cleanup pass only once nothing runs on it any more.
    const summary = emptySummary();
    const moves = await this.answerBy(replyBy, this.reconcile(paseo, "removed", affected, new Map([[account.id, account.label]]), { summary }), summary);
    void this.cleanUpHomes(paseo).catch((error: unknown) => log("cleanup failed", error));
    return { affected: affected.length, moves };
  }

  // ------------------------------------------------------------------ Azure OpenAI accounts

  /**
   * Adds an Azure OpenAI account under ChatGPT (Codex): an endpoint and an API key, checked against
   * the endpoint first. A refused key (401/403) isn't saved; when the endpoint can't be reached the
   * account is saved anyway and `warning` says so. The key goes only to the home's `azure.json`, and
   * the account is marked `provider: "azure"`.
   */
  async addAzureAccount(input: { label: string; endpoint: string; key: string }): Promise<{ accountId: string; warning: string | null }> {
    const endpoint = normalizeAzureEndpoint(input.endpoint);
    const key = input.key.trim();
    if (!key) throw new Error("Enter the API key.");
    const identity = azureIdentity(endpoint, key);
    const duplicate = accountsOf(await this.store.read(), "codex").find((account) => account.identity === identity);
    if (duplicate) throw new Error(`That key and endpoint are already added as "${duplicate.label}".`);
    const check = await checkAzureKey(endpoint, key);
    if (!check.ok && check.fatal) throw new Error(check.message);

    const id = `codex-${randomBytes(6).toString("hex")}`;
    const home = join(homesDir(), id);
    this.creatingHomes.add(home);
    try {
      await this.store.update((draft) => {
        draft.cleanup[home] = { family: "codex", accountId: id, why: "unfinished", at: new Date().toISOString() };
      });
      await writeAzureAccount(home, { endpoint, key, prices: {} });
      await this.adapters.codex.prepareHome(home);
      await this.store.update((draft) => {
        const twin = accountsOf(draft, "codex").find((entry) => entry.identity === identity);
        if (twin) throw new Error(`That key and endpoint are already added as "${twin.label}".`);
        const account = newAccount({ id, family: "codex", kind: "managed", home, auth: "api", provider: "azure" });
        account.label = input.label.trim();
        account.autoLabel = false;
        account.identity = identity;
        account.plan = "Azure OpenAI";
        draft.accounts.push(account);
        delete draft.cleanup[home];
      });
    } catch (error) {
      const removed = await removeHome(home).then(
        () => true,
        (failure: unknown) => (log(`could not delete the half-made home ${home}; the cleanup pass tries again`, failure), false),
      );
      if (removed) await this.store.update((draft) => void delete draft.cleanup[home]).catch(() => undefined);
      throw error;
    } finally {
      this.creatingHomes.delete(home);
    }
    console.log(`[ZeroSub] added Azure OpenAI account ${input.label.trim()} (${new URL(endpoint).host})${check.ok ? "" : "; its key couldn't be checked"}`);
    return { accountId: id, warning: check.ok ? null : `Saved, but the key couldn't be checked: ${check.message}` };
  }

  /**
   * Changes an Azure account's endpoint, key (empty keeps it) or price table. A new key or endpoint is
   * checked as when adding one; a kept key only goes to a new endpoint when it's typed again.
   */
  async updateAzureAccount(accountId: string, input: { endpoint?: string; key?: string; prices?: Record<string, ApiPrice> }): Promise<{ warning: string | null }> {
    return this.onAccount(accountId, async (account) => {
      if (!account || !account.home) throw new Error("That account no longer exists.");
      if (!isAzureAccount(account)) throw new Error(`${account.label} isn't an Azure OpenAI account.`);
      const home = account.home;
      const current = await readAzureAccount(home);
      const endpoint = input.endpoint?.trim() ? normalizeAzureEndpoint(input.endpoint) : current.endpoint;
      const typed = input.key?.trim() || null;
      if (!typed && endpoint !== current.endpoint) throw new Error("Enter the key again to use it with a different endpoint.");
      const key = typed ?? current.key;
      const changed = typed !== null || endpoint !== current.endpoint;
      let warning: string | null = null;
      if (changed) {
        const identity = azureIdentity(endpoint, key);
        const duplicate = accountsOf(await this.store.read(), "codex").find((entry) => entry.id !== accountId && entry.identity === identity);
        if (duplicate) throw new Error(`That key and endpoint are already added as "${duplicate.label}".`);
        const check = await checkAzureKey(endpoint, key);
        if (!check.ok && check.fatal) throw new Error(check.message);
        if (!check.ok) warning = `Saved, but the key couldn't be checked: ${check.message}`;
      }
      const prices = input.prices
        ? Object.fromEntries(Object.entries(input.prices).map(([model, price]) => [model.trim(), price] as const).filter(([model]) => model !== ""))
        : current.prices;
      if (!(await this.stillHas(account)())) throw new Error("That account no longer exists.");
      await writeAzureAccount(home, { endpoint, key, prices });
      await this.adapters.codex.prepareHome(home).catch((error: unknown) => log(`could not refresh the home of ${account.label}`, error));
      await this.store.update((draft) => {
        const target = findAccount(draft, accountId);
        if (!target) return;
        target.identity = azureIdentity(endpoint, key);
        // A new key or endpoint is worth trying again even if the old one was refused.
        if (changed) {
          target.signedIn = true;
          target.apiError = null;
        }
      });
      return { warning };
    });
  }

  /**
   * Counts the tokens an agent's turn on an Azure account used, from its Codex thread's rollout file
   * (the last `token_count` event's running total, minus what was counted before). Codex writes it
   * as the turn goes, so this waits a moment after the turn ends. A turn whose file can't be found is
   * noted as uncounted, so the card says its totals are short.
   */
  private async countAzureTurn(paseo: PaseoApi, agentId: string, accountId: string): Promise<void> {
    await delay(1_500);
    const agent = (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent as
      | { persistence?: { sessionId?: string; nativeHandle?: string } | null; model?: string | null }
      | undefined;
    const ids = [agent?.persistence?.nativeHandle, agent?.persistence?.sessionId].filter((id): id is string => typeof id === "string" && id !== "");
    for (const threadId of new Set(ids)) {
      const path = await findRollout(threadId);
      if (!path) continue;
      const reading = parseRollout(await readFile(path, "utf8"));
      if (!reading) continue;
      await this.apiUsage.countThread(accountId, threadId, reading, agent?.model ?? "unknown");
      return;
    }
    await this.apiUsage.noteUncounted(accountId);
    console.log(`[ZeroSub] couldn't find the Codex session file of ${agentId}, so its last turn's tokens aren't counted`);
  }

  // ------------------------------------------------------------------ AWS Bedrock accounts

  /**
   * The region the host's own AWS setup names, to fill in the Bedrock form. Only the form asks, when it
   * opens: on a host that isn't an EC2 instance the metadata service never answers, so this is never
   * looked up at startup or for the state view (see `detectHostRegion`).
   */
  async detectBedrockRegion(): Promise<{ region: string | null; source: RegionSource | null }> {
    return this.aws.detectRegion().catch(() => ({ region: null, source: null }));
  }

  /**
   * Adds an AWS Bedrock account under Claude: a region, where its AWS credentials come from (the host's
   * own default chain, a named profile, or an access key kept in its home), and optional model
   * overrides. The credentials are checked first (see `checkBedrock`): refused ones aren't saved, and
   * `warning` says when they couldn't be checked. Secrets go only to the home's `bedrock.json`, and
   * the account is marked `provider: "bedrock"`.
   */
  async addBedrockAccount(input: BedrockInput & { label: string }): Promise<{ accountId: string; warning: string | null }> {
    const account = bedrockFromInput(input, null);
    const identity = bedrockIdentity(account);
    const duplicate = accountsOf(await this.store.read(), "claude").find((entry) => entry.identity === identity);
    if (duplicate) throw new Error(`Those AWS credentials in ${account.region} are already added as "${duplicate.label}".`);
    const check = await this.aws.check(account);
    if (!check.ok && check.fatal) throw new Error(check.message);

    const id = `claude-${randomBytes(6).toString("hex")}`;
    const home = join(homesDir(), id);
    this.creatingHomes.add(home);
    try {
      await this.store.update((draft) => {
        draft.cleanup[home] = { family: "claude", accountId: id, why: "unfinished", at: new Date().toISOString() };
      });
      await writeBedrockAccount(home, account);
      await this.adapters.claude.prepareHome(home);
      await this.store.update((draft) => {
        const twin = accountsOf(draft, "claude").find((entry) => entry.identity === identity);
        if (twin) throw new Error(`Those AWS credentials in ${account.region} are already added as "${twin.label}".`);
        const stored = newAccount({ id, family: "claude", kind: "managed", home, auth: "api", provider: "bedrock" });
        stored.label = input.label.trim();
        stored.autoLabel = false;
        stored.identity = identity;
        stored.plan = "AWS Bedrock";
        draft.accounts.push(stored);
        delete draft.cleanup[home];
      });
    } catch (error) {
      const removed = await removeHome(home).then(
        () => true,
        (failure: unknown) => (log(`could not delete the half-made home ${home}; the cleanup pass tries again`, failure), false),
      );
      if (removed) await this.store.update((draft) => void delete draft.cleanup[home]).catch(() => undefined);
      throw error;
    } finally {
      this.creatingHomes.delete(home);
    }
    console.log(`[ZeroSub] added AWS Bedrock account ${input.label.trim()} (${account.region}, ${account.source} credentials)${check.ok ? "" : "; its credentials couldn't be checked"}`);
    return { accountId: id, warning: check.ok ? null : `Saved, but ${lowerFirst(check.message)}` };
  }

  /**
   * Changes a Bedrock account's region, credentials (an access key's secret left empty keeps it, for
   * the same key ID), model overrides or price table. Changed credentials or region are checked as when
   * adding, and its `settings.json` is remade at once.
   */
  async updateBedrockAccount(accountId: string, input: Partial<BedrockInput> & { prices?: Record<string, ApiPrice> }): Promise<{ warning: string | null }> {
    return this.onAccount(accountId, async (stored) => {
      if (!stored || !stored.home) throw new Error("That account no longer exists.");
      if (!isBedrockAccount(stored)) throw new Error(`${stored.label} isn't an AWS Bedrock account.`);
      const home = stored.home;
      const current = await readBedrockAccount(home);
      const source = input.source ?? current.source;
      const account = bedrockFromInput(
        {
          region: input.region ?? current.region,
          source,
          profile: input.profile ?? current.profile ?? undefined,
          // The stored key ID is only shown by its hint, so an empty one keeps it.
          accessKeyId: input.accessKeyId?.trim() || (current.source === "keys" ? (current.accessKeyId ?? undefined) : undefined),
          secretAccessKey: input.secretAccessKey,
          sessionToken: input.sessionToken,
          models: input.models ?? current.models,
        },
        current,
      );
      if (input.prices) {
        account.prices = Object.fromEntries(Object.entries(input.prices).map(([model, price]) => [model.trim(), price] as const).filter(([model]) => model !== ""));
      }
      const identity = bedrockIdentity(account);
      const credentialsChanged =
        identity !== bedrockIdentity(current) || account.secretAccessKey !== current.secretAccessKey || account.sessionToken !== current.sessionToken;
      let warning: string | null = null;
      if (credentialsChanged) {
        const duplicate = accountsOf(await this.store.read(), "claude").find((entry) => entry.id !== accountId && entry.identity === identity);
        if (duplicate) throw new Error(`Those AWS credentials in ${account.region} are already added as "${duplicate.label}".`);
        const check = await this.aws.check(account);
        if (!check.ok && check.fatal) throw new Error(check.message);
        if (!check.ok) warning = `Saved, but ${lowerFirst(check.message)}`;
      }
      if (!(await this.stillHas(stored)())) throw new Error("That account no longer exists.");
      await writeBedrockAccount(home, account);
      // Its settings.json follows bedrock.json (see bedrockSettings): remade now, not at the next sync.
      await prepareClaudeHome(home, true, this.stillHas(stored)).catch((error: unknown) => log(`could not refresh the home of ${stored.label}`, error));
      await this.store.update((draft) => {
        const target = findAccount(draft, accountId);
        if (!target) return;
        target.identity = identity;
        // New credentials, a region or models are worth trying again even if the last ones were refused.
        target.signedIn = true;
        target.apiError = null;
      });
      return { warning };
    });
  }

  /**
   * Counts the tokens an agent's turn on a Bedrock account used, from its Claude Code session file
   * (shared by every Claude home): the assistant messages written since the turn started, each counted
   * once, since a Claude conversation can move between accounts and its earlier messages may have run
   * elsewhere. Claude Code writes the file as the turn goes, so this waits a moment after the turn
   * ends. A turn whose file can't be found is noted as uncounted, so the card says its totals are short.
   */
  private async countBedrockTurn(paseo: PaseoApi, agentId: string, accountId: string, startedAt: number): Promise<void> {
    await delay(1_500);
    if (this.stopped) return;
    const agent = (await paseo.agents.ref(agentId).refresh().catch(() => null))?.agent as
      | { persistence?: { sessionId?: string; nativeHandle?: string } | null }
      | undefined;
    const ids = [agent?.persistence?.sessionId, agent?.persistence?.nativeHandle].filter((id): id is string => typeof id === "string" && id !== "");
    for (const sessionId of new Set(ids)) {
      const path = await findClaudeSession(sessionId);
      if (!path) continue;
      // A little slack for the clocks of the hook and of Claude Code's own timestamps.
      await this.apiUsage.countMessages(accountId, sessionId, parseClaudeSession(await readFile(path, "utf8"), startedAt - 5_000));
      return;
    }
    await this.apiUsage.noteUncounted(accountId);
    console.log(`[ZeroSub] couldn't find the Claude Code session file of ${agentId}, so its last turn's tokens aren't counted`);
  }

  // ------------------------------------------------------------------ Pi accounts

  /**
   * Whether `account` still has the home it had, asked with its home's lock held before anything is
   * written to it: a home whose account was removed or moved meanwhile, or that a move on record is
   * taking it away from, is never written to (or made again, empty, beside the folder that moved).
   */
  private stillHas(account: StoredAccount): () => Promise<boolean> {
    return async () => {
      const state = await this.store.read();
      if (state.moves[account.id]?.from === account.home) return false;
      const current = findAccount(state, account.id);
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

  /**
   * Added accounts of `kind`, which each get a `<kind>-<account>.sh` script. An AWS Bedrock account
   * gets none: its credentials (an access key's secret) reach its sessions in their environment, which
   * a script would have to read from bedrock.json, so a terminal would run on whatever AWS credentials
   * the shell has instead.
   */
  private launcherAccounts(state: StoredState, kind: LauncherKind = "claude"): LauncherAccount[] {
    return state.accounts.flatMap((account) =>
      account.family === kind && account.kind === "managed" && account.home && !isBedrockAccount(account)
        ? [{ id: account.id, label: account.label, home: account.home }]
        : [],
    );
  }

  /**
   * Rewrites the account scripts when the accounts or their names changed. A removed account's
   * script goes when its home does (`leaving`, or gone); one whose home stays is released to the user.
   * Each kind only touches its own scripts; Pi's are written only where Pi accounts are kept
   * outside `homes/` (the real adapter, not test doubles).
   */
  private async refreshLaunchers(leaving: readonly string[] = []): Promise<void> {
    const state = await this.store.read();
    // A home that's moving keeps its account's script, rewritten for where it's gone.
    const moved = new Map(Object.values(state.moves).map((move) => [resolve(move.from), move.to]));
    const files = new Map<string, string>();
    const kinds: [LauncherKind, string][] = [["claude", launcherDir()]];
    if (this.adapters.pi.homesInUse) kinds.push(["pi", piLauncherDir()]);
    for (const [kind, directory] of kinds) {
      const accounts = this.launcherAccounts(state, kind);
      try {
        const written = await writeLaunchers(accounts, directory, leaving, moved, kind);
        for (const [accountId, name] of written) files.set(accountId, name);
      } catch (error) {
        // One kind's folder failing (say, ~/.claude-config can't be made) never stops the other's
        // scripts; its accounts keep the names they had until it works again.
        log(`could not write the ${kind === "claude" ? "Claude" : "Pi"} account scripts in ${directory}`, error);
        for (const account of accounts) {
          const name = this.launcherFiles?.get(account.id);
          if (name !== undefined) files.set(account.id, name);
        }
      }
    }
    this.launcherFiles = files;
  }

  /**
   * Sets an account's proxy; an empty value clears it. Processes started afterwards use it. The CLI
   * login's is kept in the user's own settings when they set one (Pi's in Pi's settings, Claude's
   * in `~/.claude/settings.json`), changed there only when asked to here.
   */
  async setProxy(accountId: string, input: string): Promise<string | null> {
    const { account, proxy, kept } = await this.onAccount(accountId, async (account) => {
      if (!account) throw new Error("That account no longer exists.");
      const adapter = this.adapters[account.family];
      const main = account.kind === "main";
      if (!adapter.setProxy || !(main || (account.kind === "managed" && account.home))) throw new Error("A proxy can only be set for Claude and Pi accounts.");
      const proxy = input.trim() ? normalizeProxy(input) : null;
      const kept = main ? await adapter.proxyState?.(null).catch(() => null) : null;
      if (main && account.family === "pi" && proxy && proxy !== kept?.own) await this.refuseClearTextFollowers(account.family);
      if (main && adapter.clearTextProxy && proxy && proxy !== kept?.own) await this.refuseClaudeFollowers(account.family, proxy);
      const keyed = !main && account.auth === "api" && adapter.clearTextProxy ? await adapter.api?.(account.home).catch(() => null) : null;
      const before = keyed ? (await adapter.proxyState?.(account.home))?.own ?? null : null;
      // As with a new base URL, a key is never sent somewhere new: over plain http:// a proxy reads it.
      if (keyed && proxy && proxy !== before && sentInTheClear(keyed.baseUrl)) {
        throw new Error(
          "This account sends its key over plain http://, which a proxy can read. To use a new proxy, remove the account and add it again with its key and the proxy, or switch to an https:// base URL.",
        );
      }
      await adapter.setProxy(main ? null : account.home, proxy, this.stillHas(account));
      // Without its own, it goes through the one it inherits: put its own back if that would read the key.
      if (keyed && !proxy && before && account.home) {
        const through = await adapter.clearTextProxy!(account.home, keyed.baseUrl);
        if (through) {
          await adapter.setProxy(account.home, before, this.stillHas(account));
          throw new Error(
            `This account sends its key over plain http://, and without its own proxy it would go through ${maskProxy(through)}, which could read it. Switch to an https:// base URL first, or keep this proxy.`,
          );
        }
      }
      return { account, proxy, kept };
    });
    if (account.kind === "main" && account.family === "pi") {
      await this.followMainSettings(account.family);
    } else {
      void this.checkEgress(account);
      // The CLI login's proxy kept in main's settings is every added account's without one of its own.
      if (account.kind === "main" && kept?.file) void this.followMainSettings(account.family);
    }
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
   * Refuses an API account whose key would cross a proxy it only inherits (the daemon's, or the CLI
   * login's) as plain http:// (see `FamilyAdapter.clearTextProxy`).
   */
  private async refuseClearText(adapter: FamilyAdapter, home: string, baseUrl: string | null): Promise<void> {
    const through = await adapter.clearTextProxy?.(home, baseUrl);
    if (!through) return;
    throw new Error(
      `${baseUrl} is plain http://, and the account would go through ${maskProxy(through)}, which could read its key. Use an https:// base URL, keep the gateway direct with NO_PROXY, or add it with a proxy of its own you trust.`,
    );
  }

  /**
   * As `refuseClearTextFollowers`, for Claude: a new proxy on the CLI login is every added account's
   * without one of its own, so it's refused while one of those API accounts would send its key
   * through it over plain http://, unless its no-proxy list keeps the gateway direct.
   */
  private async refuseClaudeFollowers(family: Family, proxy: string): Promise<void> {
    const adapter = this.adapters[family];
    for (const account of accountsOf(await this.store.read(), family)) {
      const home = this.homeNow(account);
      if (account.kind !== "managed" || account.auth !== "api" || !home) continue;
      if ((await adapter.proxyState?.(home).catch(() => null))?.own) continue;
      const api = await adapter.api?.(home).catch(() => null);
      if (api && (await adapter.clearTextProxy!(home, api.baseUrl, proxy))) {
        throw new Error(
          `${account.label} has no proxy of its own and sends its key over plain http:// to ${api.baseUrl}, so this proxy could read it. Give ${account.label} an https:// base URL, or a proxy of its own, first.`,
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
   * Checks where an account's requests come from; a failed check keeps the last address it saw.
   * Pi's own login is never checked: only an added Pi account's requests are ZeroSub's to place, so
   * nothing is sent while none is added. Claude's CLI login is, as its proxy can be set here too.
   */
  private async checkEgress(account: StoredAccount): Promise<void> {
    const adapter = this.adapters[account.family];
    if (!adapter.egress || !account.signedIn) return;
    if (account.kind === "main" ? account.family !== "claude" : !account.home) return;
    this.egressCheckedAt.set(account.id, Date.now());
    const checkedAt = new Date().toISOString();
    try {
      const seen = await this.onAccount(account.id, async (current) => (current?.home || current?.kind === "main" ? adapter.egress!(current.home) : null));
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
  async addApiAccount(input: ApiAccountInput & { label: string; key: string; proxy?: string; family?: "claude" | "pi" }): Promise<string> {
    // Pi's are an Anthropic API key and nothing else, so its form sends no kind; Claude's always says which.
    const family = input.family ?? (input.keyKind ? "claude" : "pi");
    const keyKind = input.keyKind ?? "api_key";
    const adapter = this.adapters[family];
    if (!adapter.setApi) throw new Error("API accounts aren't supported here.");
    if (family === "pi" && keyKind !== "api_key") throw new Error("Pi accounts use an API key (x-api-key), not an auth token.");
    const baseUrl = input.baseUrl?.trim() ? normalizeBaseUrl(input.baseUrl) : null;
    const proxy = input.proxy?.trim() ? normalizeProxy(input.proxy) : null;
    const key = input.key.trim();
    if (!key) throw new Error(family === "pi" ? "Enter the API key." : "Enter the API key or token.");
    const identity = apiIdentity(baseUrl, keyDigest(key));
    const duplicate = accountsOf(await this.store.read(), family).find((account) => sameApiIdentity(account.identity, identity));
    if (duplicate) throw new Error(`That key is already added as "${duplicate.label}".`);

    // A managed account's ID matches its home's folder name, as its cleanup entry does.
    const id = `${family}-${randomBytes(6).toString("hex")}`;
    const home = join(homesDir(), id);
    this.creatingHomes.add(home);
    try {
      // On the cleanup list until the account is saved, so a home left half made is cleaned up even
      // after a restart. While it's being made, cleanup leaves it alone.
      await this.store.update((draft) => {
        draft.cleanup[home] = { family, accountId: id, why: "unfinished", at: new Date().toISOString() };
      });
      if (proxy) await adapter.setProxy?.(home, proxy);
      await adapter.setApi(home, { ...trafficSwitches(input), keyKind, key, baseUrl });
      await adapter.prepareHome(home);
      // A proxy typed in along with the key is the user's to trust; one the account would only inherit isn't.
      if (!proxy) await this.refuseClearText(adapter, home, baseUrl);
      await this.store.update((draft) => {
        // Checked again here too: another add of the same key may have finished meanwhile.
        const twin = accountsOf(draft, family).find((entry) => sameApiIdentity(entry.identity, identity));
        if (twin) throw new Error(`That key is already added as "${twin.label}".`);
        const account = newAccount({ id, family, kind: "managed", home, auth: "api" });
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
        (failure: unknown) => (log(`could not delete the half-made home ${home}; the cleanup pass tries again`, failure), false),
      );
      if (removed) await this.store.update((draft) => void delete draft.cleanup[home]).catch(() => undefined);
      throw error;
    } finally {
      this.creatingHomes.delete(home);
    }
    await this.placeHomes().catch((error: unknown) => log("moving accounts' homes failed", error));
    await this.refreshLaunchers().catch((error: unknown) => log("could not write the shell launchers", error));
    const added = findAccount(await this.store.read(), id);
    if (added) void this.checkEgress(added);
    return id;
  }

  /** Changes an API account's key (empty keeps it), base URL or traffic switches; Pi's own login's too, when asked to here. */
  async updateApiAccount(accountId: string, input: ApiAccountInput & { key?: string }): Promise<void> {
    await this.onAccount(accountId, async (account) => {
      if (!account) throw new Error("That account no longer exists.");
      const adapter = this.adapters[account.family];
      const key = input.key?.trim() || null;
      const baseUrl = input.baseUrl?.trim() ? normalizeBaseUrl(input.baseUrl) : null;
      // Pi's own login keeps its key in Pi's own files, which the adapter changes in place.
      if (account.kind === "main" && adapter.mainApi && adapter.setApi) {
        await adapter.setApi(null, { ...trafficSwitches(input), keyKind: "api_key", key, baseUrl });
        await this.followMainSettings(account.family);
        return;
      }
      if (isAzureAccount(account)) throw new Error(`${account.label} is an Azure OpenAI account: change its key from its own settings.`);
      if (isBedrockAccount(account)) throw new Error(`${account.label} is an AWS Bedrock account: change its credentials from its own settings.`);
      if (account.auth !== "api" || !account.home || !adapter.setApi) throw new Error(`${account.label} signs in with a subscription, not an API key.`);
      // A kept key stays on its base URL (the adapter refuses to move it), so its identity holds.
      const identity = key ? apiIdentity(baseUrl, keyDigest(key)) : null;
      if (identity) {
        const duplicate = accountsOf(await this.store.read(), account.family).find((entry) => entry.id !== account.id && sameApiIdentity(entry.identity, identity));
        if (duplicate) throw new Error(`That key is already added as "${duplicate.label}".`);
      }
      if (!(await adapter.proxyState?.(account.home).catch(() => null))?.own) await this.refuseClearText(adapter, account.home, baseUrl);
      await adapter.setApi(account.home, { ...trafficSwitches(input), keyKind: input.keyKind ?? "api_key", key, baseUrl }, this.stillHas(account));
      await this.store.update((draft) => {
        const target = findAccount(draft, accountId);
        if (!target) return;
        if (identity) target.identity = identity;
        // A new key is worth trying again even if the old one had been refused. A Pi account's key is
        // only marked refused by Anthropic, so a new base URL alone doesn't clear that; a Claude one's
        // refusal may be the endpoint's, so saving its settings again tries it again.
        if (key || account.family !== "pi") target.signedIn = true;
      });
    });
    const account = findAccount(await this.store.read(), accountId);
    if (account) void this.checkEgress(account);
  }

  /**
   * Adds a folder Claude Code is signed in with already (with a subscription) as an account: one the
   * user set up, or one ZeroSub kept when its account was removed. The folder stays where it is,
   * unless it's in ZeroSub's `homes/` or a folder picked before, which it moves out of like any
   * account's (see `placeHomes`); removing the account later only takes it out of ZeroSub, as for
   * any folder outside `homes/`. Refused, saying why, for a folder `chooseImportedHome` turns down,
   * one not signed in with a Claude subscription, or one signed in as an account here already.
   * Returns the new account's ID.
   */
  async importAccount(input: string): Promise<string> {
    const home = await chooseImportedHome(input, (await this.store.read()).accounts);
    const shown = shownPath(home);
    if ([...this.logins.values()].some((login) => login.home === home && !login.finishedAt)) throw new Error(`${shown} is being signed in right now.`);
    // A removed AWS Bedrock account's home, waiting in `homes/` to be deleted: it isn't signed in to a
    // subscription, and its sessions would run on Bedrock under a subscription account's name.
    if (isBedrockHome(home)) throw new Error(`${shown} is an AWS Bedrock account's folder, not one signed in with a Claude subscription. Add it again with "AWS Bedrock" instead.`);
    const identity = await this.adapters.claude.identity(home).catch((error: unknown) => {
      throw new Error(`ZeroSub couldn't tell whether ${shown} is signed in: ${describe(error)}`);
    });
    if (!identity.signedIn) {
      throw new Error(
        `Claude Code isn't signed in with ${shown}. Sign in there first (CLAUDE_CONFIG_DIR=${shown} claude, then /login), using the same path, or add the account with a Claude subscription sign-in instead.`,
      );
    }
    if (!identity.identity) throw new Error(`${shown} uses an API key or token, not a Claude subscription. Add it with "API key or token" instead.`);
    let account: StoredAccount | undefined;
    await this.store.update((draft) => {
      if (draft.accounts.some((entry) => entry.home && resolve(entry.home) === home)) throw new Error(`${shown} is already added.`);
      // The CLI's own login counts too: an added account must be one of its own.
      const duplicate = accountsOf(draft, "claude").find((entry) => entry.identity === identity.identity);
      if (duplicate) throw new Error(`${identity.email ?? shown} is already added as "${duplicate.label}".`);
      // A folder of ZeroSub's own gets its ID back: a managed account's ID matches its folder's name there.
      const name = basename(home);
      const id = inHomesDir(home) && /^claude-[0-9a-f]{12}$/.test(name) && !findAccount(draft, name) ? name : `claude-${randomBytes(6).toString("hex")}`;
      account = newAccount({ id, family: "claude", kind: "managed", home });
      draft.accounts.push(account);
      applyIdentity(account, identity, draft);
      // A removed account's folder that's back isn't cleaned up after all.
      for (const folder of Object.keys(draft.cleanup)) if (resolve(folder) === home) delete draft.cleanup[folder];
    });
    const added = account!;
    this.identityCheckedAt.set(added.id, Date.now());
    console.log(`[ZeroSub] added ${home}, signed in already, as ${added.label}`);
    await this.placeHomes().catch((error: unknown) => log("moving accounts' homes failed", error));
    await this.refreshLaunchers().catch((error: unknown) => log("could not write the shell launchers", error));
    void this.refreshUsage(added.id, true).catch(() => undefined);
    return added.id;
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
      const duplicate = accountsOf(draft, "pi").find((entry) => sameApiIdentity(entry.identity, identity));
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
    await this.refreshLaunchers().catch((error: unknown) => log("could not write the shell launchers", error));
    void this.checkEgress(added);
    return added.id;
  }

  /**
   * Changes the folder `family`'s added accounts' homes are kept in (empty: the default,
   * `~/.claude-config` or `~/.pi-config`). New accounts go there, and the accounts in the folder it
   * replaces, or still in ZeroSub's `homes/`, move there one at a time as nothing runs on them (see
   * `placeHomes`). Returns the folder as shown, and how many accounts are due to move.
   */
  async setHomesDir(input: string, family: PlacedFamily): Promise<{ dir: string; moving: number }> {
    const state = await this.store.read();
    const key = HOMES_KEY[family];
    const chosen = await chooseHomesDir(input, state.accounts, family);
    const previous = resolve(homesDirFor(family, state[key]));
    const updated = await this.store.update((draft) => {
      const from = new Set(draft[key].from.map((folder) => resolve(folder)));
      from.add(previous);
      from.delete(resolve(homesDirFor(family, { dir: chosen, from: [] })));
      draft[key] = { dir: chosen, from: [...from] };
    });
    this.moveNotes.clear();
    const dir = homesDirFor(family, updated[key]);
    console.log(`[ZeroSub] added ${FAMILY_LABEL[family]} accounts' homes are kept in ${dir} now`);
    void this.placeHomes().catch((error: unknown) => log("moving accounts' homes failed", error));
    return { dir: shownPath(dir), moving: (await this.dueMoves(updated)).filter((account) => account.family === family).length };
  }

  setClaudeHomesDir(input: string): Promise<{ dir: string; moving: number }> {
    return this.setHomesDir(input, "claude");
  }

  setPiHomesDir(input: string): Promise<{ dir: string; moving: number }> {
    return this.setHomesDir(input, "pi");
  }

  /**
   * Moves added Claude and Pi accounts' homes to the folder they're kept in (see `homesDirFor`): a
   * new account's from ZeroSub's own `homes/`, where it was set up, and every account's from a
   * folder picked before. Moves cut short (the plugin stopped halfway) are finished first. Each home
   * moves only while nothing runs on it (see `moveAccountHome`); one in use waits for a later pass,
   * and the app says why. Only families whose adapter can tell what runs on a home take part. One
   * pass at a time; a call during one gets that one.
   */
  placeHomes(): Promise<void> {
    this.placing ??= this.placePass().finally(() => {
      this.placing = null;
    });
    return this.placing;
  }

  /**
   * Finishes the moves on record that aren't under way in this process (ones a stop cut short).
   * Runs before homes are synced or a session is routed: either would otherwise make the old folder
   * again for a home whose registry entry still names it, or open an agent there without its sign-in.
   */
  private async finishRecordedMoves(): Promise<void> {
    for (const [accountId, move] of Object.entries((await this.store.read()).moves)) {
      if (this.moving.has(accountId)) continue;
      await this.finishOne(accountId, move).catch((error: unknown) => {
        this.moveNotes.set(accountId, { waiting: null, error: describe(error) });
        log(`could not finish moving ${move.from} to ${move.to}`, error);
      });
    }
  }

  /** Whether a move of an account's home is on record and not under way here: one a stop cut short. */
  private hasRecordedMoves(state: StoredState): boolean {
    return Object.keys(state.moves).some((accountId) => !this.moving.has(accountId));
  }

  /** `finishMove`, once at a time per account: the pass, routing and the move itself may all ask. */
  private finishOne(accountId: string, move: Move): Promise<void> {
    let finishing = this.finishing.get(accountId);
    if (!finishing) {
      finishing = this.finishMove(accountId, move).finally(() => this.finishing.delete(accountId));
      this.finishing.set(accountId, finishing);
    }
    return finishing;
  }

  private async placePass(): Promise<void> {
    await this.finishRecordedMoves();
    const state = await this.store.read();
    const due = await this.dueMoves(state);
    for (const accountId of this.moveNotes.keys()) {
      if (!due.some((account) => account.id === accountId) && !state.moves[accountId]) this.moveNotes.delete(accountId);
    }
    if (due.length === 0) return this.forgetEmptiedFolders(state);
    const inUse = new Set<string>();
    const unknown = new Set<string>();
    for (const family of PLACED) {
      const homes = due.filter((account) => account.family === family).map((account) => account.home);
      if (homes.length === 0) continue;
      try {
        for (const home of await this.adapters[family].homesInUse!(homes)) inUse.add(home);
      } catch (error) {
        for (const account of due.filter((entry) => entry.family === family)) {
          unknown.add(account.id);
          this.moveNotes.set(account.id, { waiting: null, error: `ZeroSub couldn't tell whether anything runs on it: ${describe(error)}` });
        }
      }
    }
    const taken = new Set(state.accounts.flatMap((account) => (account.home ? [resolve(account.home)] : [])));
    let moved = false;
    for (const account of due) {
      if (unknown.has(account.id)) continue;
      const family = account.family as PlacedFamily;
      const waiting = this.moveBlocker(account, inUse);
      if (waiting) {
        this.moveNotes.set(account.id, { waiting, error: null });
        continue;
      }
      const to = await placeFor(account, homesDirFor(family, state[HOMES_KEY[family]]), taken);
      taken.add(resolve(to));
      try {
        if (await this.moveAccountHome(account, to)) moved = true;
      } catch (error) {
        this.moveNotes.set(account.id, { waiting: null, error: describe(error) });
        log(`could not move the home of ${account.label} to ${to}`, error);
      }
    }
    if (moved) await this.refreshLaunchers().catch((error: unknown) => log("could not write the shell launchers", error));
  }

  /**
   * Added Claude and Pi accounts whose homes are due to move: a folder of their own (a link stays
   * where it points) in ZeroSub's `homes/` or a folder picked before, and no move of theirs under way.
   * Only families whose adapter can tell what runs on a home (the real ones; not test doubles).
   */
  private async dueMoves(state: StoredState): Promise<Array<StoredAccount & { home: string }>> {
    const due: Array<StoredAccount & { home: string }> = [];
    for (const family of PLACED) {
      if (!this.adapters[family].homesInUse) continue;
      const homes = state[HOMES_KEY[family]];
      const dir = resolve(homesDirFor(family, homes));
      const sources = new Set([homesDir(), ...homes.from].map((folder) => resolve(folder)));
      for (const account of accountsOf(state, family)) {
        const home = account.home;
        if (account.kind !== "managed" || !home || state.moves[account.id]) continue;
        // An AWS Bedrock account's home stays in `homes/`: removing it then deletes its bedrock.json
        // (an access key's secret) with it, rather than leaving it in a folder of the user's.
        if (isBedrockAccount(account)) continue;
        const folder = dirname(resolve(home));
        if (folder === dir || !sources.has(folder)) continue;
        if ((await lstat(home).catch(() => null))?.isDirectory()) due.push({ ...account, home });
      }
    }
    return due;
  }

  /** Why an account's home can't move just now, or null when it can. */
  private moveBlocker(account: StoredAccount & { home: string }, inUse: ReadonlySet<string>): string | null {
    const { home } = account;
    if ([...this.logins.values()].some((login) => login.home === home && (!login.finishedAt || login.saving))) return "it's being signed in";
    if (this.creatingHomes.has(home)) return "it's being set up";
    if (inUse.has(home)) return `${PROVIDER_NAME[account.family]} runs on it (an agent or a terminal); it moves once that stops`;
    if ((this.homeCalls.get(home) ?? 0) > 0) return "ZeroSub is working on it";
    if (Date.now() - (this.routedAt.get(account.id) ?? 0) < ROUTED_SETTLE_MS) return "an agent has just started on it";
    return null;
  }

  /**
   * Moves an account's home to `to`, once nothing runs on it. Nothing waits for the move: a session
   * routed to the home, or a call of ZeroSub's on it, while the folder is being moved makes the move
   * give way (the folder goes back, and it's tried at a later pass), and once the move is saved
   * they're given the new folder (see `homeNow`). The move is written down first (`moves`), so one
   * cut short is finished or undone at the next pass (see `finishMove`). What the CLI keeps for the
   * home outside its folder (Claude's Keychain entry) is copied before the folder moves, and the
   * copy goes again when the move gives way. False when it had to wait after all.
   */
  private async moveAccountHome(account: StoredAccount & { home: string }, to: string): Promise<boolean> {
    const adapter = this.adapters[account.family];
    const from = account.home;
    const homesInUse = (homes: readonly string[]) => adapter.homesInUse!(homes);
    const waiting = this.moveBlocker(account, await homesInUse([from]));
    if (waiting) {
      this.moveNotes.set(account.id, { waiting, error: null });
      return false;
    }
    const startedAt = Date.now();
    const move: Move = { from, to, at: new Date(startedAt).toISOString(), family: account.family };
    const run: HomeMove = { from, to, committed: false };
    this.moving.set(account.id, run);
    try {
      await this.store.update((draft) => void (draft.moves[account.id] = move));
      let copied = false;
      try {
        await adapter.copyCredentials?.(from, to);
        copied = true;
        await moveHome(from, to, async () => {
          // Checked again once the folder is there: anything that started on it meanwhile keeps it.
          const started = (await homesInUse([from])).has(from)
            ? `${PROVIDER_NAME[account.family]} started on it (an agent or a terminal); it moves once that stops`
            : [...this.logins.values()].some((login) => login.home === from && !login.finishedAt)
              ? "it's being signed in"
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
        // Still where it was: the copy of its sign-in goes, and so does the record. Otherwise the
        // record stays, for `finishMove` to sort out.
        const back = (await lstat(from).catch(() => null))?.isDirectory() && !(await lstat(to).catch(() => null));
        if (back) {
          if (copied) await adapter.dropCopiedCredentials?.(from, to).catch((failure: unknown) => log(`could not remove the copy of ${account.label}'s sign-in for ${to}`, failure));
          await this.store.update((draft) => void delete draft.moves[account.id]).catch(() => undefined);
        }
        if (!(error instanceof MoveGaveWay)) throw error;
        this.moveNotes.set(account.id, { waiting: error.message, error: null });
        return false;
      }
      this.moved.set(account.id, { from, to });
    } finally {
      this.moving.delete(account.id);
    }
    await this.finishOne(account.id, move);
    return true;
  }

  /**
   * Finishes a recorded move of an account's home. Cut short before the folder moved: the copy of
   * its sign-in goes, and the move is tried again. After the folder moved but before the account's
   * new home was saved: the sign-in is copied (again) and the new home saved. Both folders there
   * before it's saved: the account goes with the one that holds its sign-in or key (see
   * `FamilyAdapter.holdsAccount`). Only the new one does when the old folder was made again after
   * the folder moved (by the CLI on the old script, say): the move is finished, and the old folder
   * left alone. Otherwise, and when neither folder is there, it's left as it is for the user, and
   * the app says so, never asking to delete the folder that holds the account. Once it's saved, the
   * old Keychain entry goes, provided the new one holds the sign-in. The old folder still there
   * after (a copy onto another disk not cleaned up) is left alone, and logged. The account's script
   * is rewritten for the new home before the record goes.
   */
  private async finishMove(accountId: string, move: Move): Promise<void> {
    const forget = () => this.store.update((draft) => void delete draft.moves[accountId]);
    let account = findAccount(await this.store.read(), accountId);
    // Records of earlier versions have no family: the account says whose home it is.
    const family = move.family ?? account?.family;
    const adapter = family ? this.adapters[family] : undefined;
    const folder = async (path: string) => (await lstat(path).catch(() => null))?.isDirectory() === true;
    const [atFrom, atTo] = [await folder(move.from), await folder(move.to)];
    if (account?.home === move.from) {
      if (atFrom && !atTo) {
        await adapter?.dropCopiedCredentials?.(move.from, move.to);
        await forget();
        return;
      }
      const holds = async (path: string) => (adapter?.holdsAccount ? adapter.holdsAccount(path) : false);
      const [holdsFrom, holdsTo] = atFrom && atTo ? [await holds(move.from), await holds(move.to)] : [false, false];
      if (atFrom && atTo && holdsTo && !holdsFrom) {
        console.log(`[ZeroSub] ${move.from} was made again while ${account.label} moved to ${move.to}, which holds its sign-in or key; finishing the move and leaving ${move.from} alone (delete it yourself)`);
      } else if (atFrom || !atTo) {
        throw new Error(
          !atFrom
            ? `ZeroSub stopped while moving ${shownPath(move.from)} to ${shownPath(move.to)}, and neither is there now.`
            : holdsFrom
              ? `ZeroSub stopped while copying ${shownPath(move.from)} to ${shownPath(move.to)} on another disk, and both are there now. The account still uses ${shownPath(move.from)}: delete ${shownPath(move.to)}, and the move starts again at ZeroSub's next check.`
              : `Both ${shownPath(move.from)} and ${shownPath(move.to)} are there, and neither holds ${account.label}'s sign-in or key. Sign it in again, or give it its key again, from its card.`,
        );
      }
      await adapter?.copyCredentials?.(move.from, move.to);
      await this.store.update((draft) => {
        const target = findAccount(draft, accountId);
        if (target?.home === move.from) target.home = move.to;
      });
      account = findAccount(await this.store.read(), accountId);
    }
    if (account?.home === move.to && adapter?.dropOldCredentials && !(await adapter.dropOldCredentials(move.from, move.to))) {
      console.log(`[ZeroSub] kept the sign-in saved for ${move.from}: ${move.to} has none of its own`);
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
    if (PLACED.every((family) => state[HOMES_KEY[family]].from.every(used))) return;
    await this.store.update((draft) => {
      for (const family of PLACED) draft[HOMES_KEY[family]].from = draft[HOMES_KEY[family]].from.filter(used);
    });
  }

  // ------------------------------------------------------------------ RPC: sign-in

  startLogin(family: Family, method: LoginMethod, accountId?: string, proxy?: string): Promise<LoginView> {
    return this.loginLocks[family].run(() => this.beginLogin(family, method, accountId, proxy));
  }

  private async beginLogin(family: Family, method: LoginMethod, accountId?: string, proxyInput?: string): Promise<LoginView> {
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
    if (existing && isBedrockAccount(existing)) throw new Error(`${existing.label} uses AWS credentials. Change them from its card instead.`);
    if (existing?.auth === "api") throw new Error(`${existing.label} uses an API key. Change the key from its card instead.`);
    // The CLI would sign in into the folder the account is leaving, and the sign-in go with it.
    if (existing && (this.moving.has(existing.id) || state.moves[existing.id])) {
      throw new Error(`${existing.label}'s folder is being moved. Sign it in again once that's done (its card says when).`);
    }
    // A new account's proxy is in place before the CLI starts, so the sign-in itself goes through it.
    const proxy = !existing && proxyInput?.trim() ? normalizeProxy(proxyInput) : null;
    if (proxy && !this.adapters[family].setProxy) throw new Error(`A proxy can't be set for ${FAMILY_LABEL[family]} accounts yet.`);

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
      if (home && proxy) await this.adapters[family].setProxy?.(home, proxy);
      if (home) await this.adapters[family].prepareHome(home, existing ? this.stillHas(existing) : undefined);
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
    // A new account's script is there by the time the app says it's added; its home then moves out
    // of `homes/` to where accounts are kept.
    await this.refreshLaunchers().catch((error: unknown) => log("could not write the shell launchers", error));
    session.view = { ...session.view, step: "done", accountId, message: null };
    void this.placeHomes().catch((error: unknown) => log("moving accounts' homes failed", error));
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

/** What the add and edit forms send for a Bedrock account. */
interface BedrockInput {
  region: string;
  source: BedrockSource;
  profile?: string;
  accessKeyId?: string;
  /** Empty keeps the stored one, for the same access key ID. */
  secretAccessKey?: string;
  /** Empty keeps the stored one along with a kept secret; a new secret drops it unless one is typed with it. */
  sessionToken?: string;
  models?: Partial<BedrockModels>;
}

/** A Bedrock account's settings from a form, checked; `current` supplies a kept secret (same key ID only) and the prices. */
function bedrockFromInput(input: BedrockInput, current: BedrockAccount | null): BedrockAccount {
  const region = normalizeRegion(input.region);
  const trim = (value: string | undefined) => value?.trim() || null;
  const models: BedrockModels = { model: "", opus: "", sonnet: "", haiku: "" };
  for (const field of Object.keys(models) as Array<keyof BedrockModels>) {
    const model = input.models?.[field]?.trim() ?? "";
    if (model && !/^[\w.:/-]{3,200}$/.test(model)) throw new Error(`"${model}" doesn't look like a Bedrock model or inference-profile ID`);
    models[field] = model;
  }
  const account: BedrockAccount = {
    region,
    source: input.source,
    profile: null,
    accessKeyId: null,
    secretAccessKey: null,
    sessionToken: null,
    models,
    prices: current?.prices ?? {},
  };
  if (input.source === "profile") {
    const profile = trim(input.profile);
    if (!profile || !/^[\w.+@=,-]{1,128}$/.test(profile)) throw new Error("Enter the name of an AWS profile in the host's ~/.aws config");
    account.profile = profile;
  } else if (input.source === "keys") {
    const keyId = trim(input.accessKeyId);
    if (!keyId || !/^[A-Z0-9]{16,128}$/.test(keyId)) throw new Error("Enter the access key ID (like AKIA… or ASIA…)");
    const typed = trim(input.secretAccessKey);
    const kept = current?.source === "keys" && current.accessKeyId === keyId;
    const secret = typed ?? (kept ? current.secretAccessKey : null);
    if (!secret) throw new Error(kept ? "Enter the secret access key" : "Enter the secret access key for this access key ID");
    account.accessKeyId = keyId;
    account.secretAccessKey = secret;
    // A session token belongs to its secret: kept only with a kept secret.
    account.sessionToken = trim(input.sessionToken) ?? (typed ? null : (current?.sessionToken ?? null));
  }
  return account;
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** An adapter's API summary as the app shows it, the key kind and switches filled in. */
function apiView(api: ApiSummary | null | undefined): AccountView["api"] {
  return api ? ApiSummarySchema.parse(api) : null;
}

/** An API account's fields as the app sends them. */
type ApiAccountInput = Partial<TrafficSwitches> & { keyKind?: ApiKeyKind; baseUrl?: string };

/** The traffic switches in `input`, each off unless it's on. */
function trafficSwitches(input: Partial<TrafficSwitches>): TrafficSwitches {
  return {
    disableTelemetry: input.disableTelemetry === true,
    disableErrorReporting: input.disableErrorReporting === true,
    disableNonessentialTraffic: input.disableNonessentialTraffic === true,
  };
}

/** Claude's Auto mode, as Paseo names it: Paseo's default Claude mode, which Bedrock can't run. */
const CLAUDE_AUTO_MODE = "auto";

/** Whether a Claude agent runs in Auto mode. One whose mode isn't known counts too: Auto is Paseo's default. */
function runsAutoMode(modeId: string | null | undefined): boolean {
  return modeId === undefined || modeId === null || modeId === CLAUDE_AUTO_MODE;
}

/** The timeline's word when paid fallback left Bedrock out for an agent in Auto mode. */
function autoModeSkipNote(label: string): string {
  return `${label} (AWS Bedrock) wasn't used: Bedrock can't run Claude's Auto mode, which needs the Anthropic API. Switch this agent to another mode (Accept File Edits, say) to let it move there.`;
}

/** The timeline's word when Paseo refused Auto mode on a Bedrock account the agent was put on by hand or as the default. */
function autoModeRefusedNote(label: string): string {
  return `Claude's Auto mode can't run on ${label}: on AWS Bedrock it needs the Anthropic API, so Paseo didn't start the turn. Pick another mode for this agent (Accept File Edits, say), or move it to a Claude subscription account. ${label} stays usable.`;
}

function joinDetails(...details: Array<string | null>): string | null {
  const text = details.filter((detail): detail is string => !!detail).join(" ");
  return text || null;
}

/** What to do when Claude Code finds the agent's model missing in a Bedrock account's region. */
function bedrockModelNote(label: string, model: string): string {
  return `Bedrock in ${label}'s region doesn't offer ${model}, which Claude Code picked for this agent's model. Claude Code's built-in Bedrock defaults for the opus, sonnet and haiku aliases can be older than a region offers: set the Opus, Sonnet and Haiku models in ${label}'s Bedrock settings (an inference profile your AWS account has, such as global.anthropic.claude-sonnet-5-5), or pick another model for this agent. ${label} stays usable for other models.`;
}

/** The timeline's word on work that moved onto a paid Azure or Bedrock account by itself (with `paidApiFallback` on). */
function paidFallbackNote(account: StoredAccount): string {
  if (isBedrockAccount(account)) {
    return `Every Claude subscription account is out, so this runs on ${account.label}: AWS Bedrock, a paid API billed per token. It moves back to a Claude account once one has room.`;
  }
  return `Every ChatGPT subscription account is out, so this runs on ${account.label}: Azure OpenAI, a paid API billed per token. New agents go back to a ChatGPT account once one has room.`;
}

/** What tells an API key's account from another: where the key goes, and a short hash of the key. */
/** Anthropic's API, which a blank base URL means too. */
const ANTHROPIC_API = "https://api.anthropic.com";

function apiIdentity(baseUrl: string | null, digest: string): string {
  return `api|${baseUrl === null || baseUrl === ANTHROPIC_API ? "anthropic" : baseUrl}|${digest}`;
}

/** Whether `identity`, as an account was saved with, is `wanted`: one saved with Anthropic's API typed out is the same as one without. */
function sameApiIdentity(identity: string | null, wanted: string): boolean {
  return identity !== null && identity.replace(`api|${ANTHROPIC_API}|`, "api|anthropic|") === wanted;
}

function keyDigest(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function newAccount(fields: Pick<StoredAccount, "id" | "family" | "kind" | "home"> & Partial<Pick<StoredAccount, "auth" | "provider">>): StoredAccount {
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
    modeId: agent.currentModeId ?? null,
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
