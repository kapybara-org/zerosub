import type { PluginButton, PluginButtonRegistration, PluginClientContext } from "@getpaseo/plugin/client";
import {
  canStandIn,
  capsAccount,
  egressText,
  formatCountdown,
  formatCredits,
  formatPercent,
  formatResetAt,
  isDisabled,
  moveProblem,
  pillText,
  reportsUsage,
  shortLabel,
  shortWindowLabel,
} from "../shared/format";
import { FAMILY_LABEL, OTHER_FAMILY, type AccountView, type Family, type StateView } from "../shared/model";
import { setAgentAccount } from "../shared/rpc";
import { accountMenu, type MenuEntry } from "./account-menu";
import { forkPopover } from "./fork-confirm";
import { resetPopover } from "./reset-confirm";
import { stoppedWaiting, type ZeroSubStore } from "./store";

/** The most agents Paseo returns per page. */
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/** A little longer than the daemon keeps its list of agents (`AGENT_LIST_MS` in server/service.ts). */
const AGENT_LIST_SETTLE_MS = 3_500;

interface TrackedAgent {
  id: string;
  workspaceId: string;
  provider: string;
}

/** Where an agent stands, as its pill and its menu both read it. */
interface Standing {
  family: Family;
  accounts: AccountView[];
  route: StateView["agents"][number] | undefined;
  current: AccountView;
  offerReset: boolean;
  /** The provider a stopped chat can carry on with; null for Pi. */
  other: Family | null;
  offerFork: boolean;
  /** Accounts at their limit can't be picked. */
  autoSwitch: boolean;
}

/** A move asked for from the menu: to an account, or (`null`) back to following the default. */
interface Move {
  accountId: string | null;
  label: string;
}

/** Says `move` is under way until `answer` settles. */
type MoveStarted = (move: Move, answer: Promise<unknown>) => void;

/**
 * One composer pill per Claude/Codex agent showing the account it runs on. Tapping it opens a menu
 * of that provider's accounts. Pills only appear once a provider has more than one account, so a
 * single-account setup looks exactly like stock Paseo.
 */
export function contributePills(client: PluginClientContext, store: ZeroSubStore): () => void {
  const agents = new Map<string, TrackedAgent>();
  /**
   * `face` is the pill's label, tooltip and icon, which Paseo updates in place. The menu reads the
   * store itself (see `accountMenu`), so Paseo gets it once: a new one would close it.
   */
  const pills = new Map<string, { registration: PluginButtonRegistration; face: string }>();
  /** Moves asked for from a menu and not answered yet, by agent. */
  const moves = new Map<string, Move>();
  const lifetime = new AbortController();
  let stopped = false;
  let lookAgain: ReturnType<typeof setTimeout> | null = null;

  const moveStarted =
    (agentId: string): MoveStarted =>
    (move, answer) => {
      moves.set(agentId, move);
      sync();
      // Until the state after it is in, so the pill doesn't show the old account again for a moment.
      void answer
        .catch(() => undefined)
        .then(() => store.refresh())
        .finally(() => {
          if (moves.get(agentId) === move) moves.delete(agentId);
          sync();
        });
    };

  function sync(): void {
    if (stopped) return;
    const state = store.current.state;
    for (const [agentId, pill] of pills) {
      if (!agents.has(agentId)) {
        pill.registration.remove();
        pills.delete(agentId);
      }
    }
    for (const agent of agents.values()) {
      const standing = state ? standingOf(state, agent) : null;
      const existing = pills.get(agent.id);
      if (!state || !standing) {
        existing?.registration.remove();
        pills.delete(agent.id);
        continue;
      }
      const face = faceFor(state, standing, moves.get(agent.id) ?? null);
      const key = JSON.stringify([face.label, face.title, face.icon]);
      if (existing) {
        if (existing.face !== key) {
          // No behavior, so Paseo leaves an open menu open.
          existing.registration.update(face);
          existing.face = key;
        }
        continue;
      }
      try {
        const registration = client.addComposerPill({
          id: "account",
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: { ...face, behavior: { kind: "popover", Content: pillMenu(client, store, agent, moveStarted(agent.id)) } },
        });
        pills.set(agent.id, { registration, face: key });
      } catch (error) {
        console.warn("[ZeroSub] could not add account pill", error);
      }
    }
  }

  const unsubscribeStore = store.subscribe(sync);

  const track = (agent: { id: string; workspaceId?: string | null; provider: string }) => {
    if (!agent.workspaceId) return;
    agents.set(agent.id, { id: agent.id, workspaceId: agent.workspaceId, provider: agent.provider });
  };

  // The subscription covers the newest page and every later change. Older agents come from the
  // remaining pages, so an agent that has been idle for a while still gets its pill.
  const newestFirst = () => [{ key: "updated_at" as const, direction: "desc" as const }];
  let snapshots = 0;
  async function loadOlder(cursor: string | null, generation: number): Promise<void> {
    for (let page = 1; cursor && page < MAX_PAGES; page += 1) {
      const result = await client.paseo.agents.list({
        signal: lifetime.signal,
        sort: newestFirst(),
        page: { limit: PAGE_SIZE, cursor },
      });
      if (stopped || generation !== snapshots) return;
      for (const { agent } of result.entries) track(agent);
      sync();
      cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? null) : null;
    }
  }

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal, sort: newestFirst(), page: { limit: PAGE_SIZE } })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries, pageInfo }) => {
          const generation = ++snapshots;
          agents.clear();
          for (const { agent } of entries) track(agent);
          sync();
          const next = pageInfo.hasMore ? (pageInfo.nextCursor ?? null) : null;
          void loadOlder(next, generation).catch((error: unknown) => {
            if (!stopped) console.warn("[ZeroSub] could not list older agents", error);
          });
        },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const update = message.payload;
          if (update.kind === "remove") agents.delete(update.agentId);
          else {
            const known = agents.has(update.agent.id);
            track(update.agent);
            if (!known) {
              // A new agent may have been routed by the daemon a moment ago; fetch its account. The
              // daemon's list of agents can be a few seconds old, so look again once it's renewed.
              void store.refresh({ fresh: true });
              lookAgain ??= setTimeout(() => {
                lookAgain = null;
                if (!stopped) void store.refresh({ fresh: true });
              }, AGENT_LIST_SETTLE_MS);
            }
          }
          sync();
        },
      });
      return undefined;
    })
    .catch((error: unknown) => {
      if (!stopped) console.error("[ZeroSub] agent observation failed", error);
    });

  return () => {
    stopped = true;
    if (lookAgain) clearTimeout(lookAgain);
    lifetime.abort();
    unsubscribeStore();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}

/**
 * `agent`'s menu. Made here rather than in `sync`'s loop: Hermes on the phone scopes `let` and
 * `const` to the function, not the block, so a closure made in a loop sees the loop's last agent.
 */
function pillMenu(client: PluginClientContext, store: ZeroSubStore, agent: TrackedAgent, moveStarted: MoveStarted) {
  return accountMenu(store, (state) => {
    const standing = standingOf(state, agent);
    return standing ? menuEntries(client, store, standing, agent, moveStarted) : [];
  });
}

/** Where `agent` stands, or null when it gets no pill. */
function standingOf(state: StateView, agent: TrackedAgent): Standing | null {
  if (!state.showComposerPill) return null;
  const family = state.providers[agent.provider];
  if (!family) return null;
  const accounts = state.accounts.filter((account) => account.family === family);
  const route = state.agents.find((entry) => entry.agentId === agent.id);
  const current =
    accounts.find((account) => account.id === route?.accountId) ??
    accounts.find((account) => account.isDefault) ??
    accounts[0];
  if (!current) return null;
  // A banked reset is worth offering right where the agent stopped, even with a single account. A
  // signed-out account can't spend one (the server refuses), though its usage still lists them.
  const resets = current.usage?.resets ?? null;
  const offerReset = resets !== null && current.status !== "signed_out" && (current.status === "limited" || resets.usableNow);
  // With no account of this provider left to move the work to, it can carry on with the other
  // provider, on an account the server would pick for it. Either way an API account doesn't count:
  // the server never moves work onto one, so a ready one doesn't keep this provider going.
  const other = OTHER_FAMILY[family];
  const offerFork =
    other !== null &&
    current.status === "limited" &&
    !accounts.some(canStandIn) &&
    state.accounts.some((account) => account.family === other && canStandIn(account));
  if (accounts.length < 2 && !(current.status === "limited" && (offerReset || offerFork))) return null;
  return { family, accounts, route, current, offerReset, other, offerFork, autoSwitch: state.autoSwitch };
}

/**
 * The pill's label, tooltip and icon. The pill is 160 points wide at most: room for the usage, not
 * the account too, so the tooltip has both: the account first (on a phone Paseo heads the menu
 * with the tooltip's first line, and only that), then a line a window counting down as the menu
 * does, and the address Anthropic sees the agent's requests come from now, as Claude Code's status
 * line shows it. Paseo updates them in place as the store polls. While a move is under way, from
 * here (`moving`) or on the daemon, the pill names both accounts instead.
 */
function faceFor(state: StateView, { accounts, route, current }: Standing, moving: Move | null): Omit<PluginButton, "behavior"> {
  const now = Date.now();
  const icon = current.status === "limited" ? "CircleAlert" : "CircleUserRound";
  const target = moving && (moving.accountId ?? accounts.find((account) => account.isDefault)?.id);
  if (moving && target !== current.id && !route?.pendingAccountId) {
    return { label: `${shortLabel(current, 12)} → ${shortLabel(moving, 12)}`, title: `Moving to ${moving.label}…`, icon };
  }
  const running = route?.pendingAccountId ? state.accounts.find((account) => account.id === route.pendingAccountId) : undefined;
  const text = pillText(current, running ?? null, route?.waiting ?? (state.canReopen ? "idle" : "restart"));
  const windows = running ? [] : shownWindows(current, now);
  const details = windows.map(({ name, percent, resetsAt }) => {
    const at = formatResetAt(resetsAt, now);
    return `${name} ${formatPercent(percent)}${at ? ` · resets in ${formatCountdown(resetsAt, now)} (${at})` : ""}`;
  });
  const ip = egressText((running ?? current).egress, now);
  return {
    label: windows.length > 0 ? windows.map(({ name, percent }) => `${name} ${formatPercent(percent)}`).join(" · ") : text.label,
    title: [text.title, ...details, ...(ip ? [ip] : [])].join("\n"),
    icon,
  };
}

/** The agent's menu: the provider's accounts, a way out when it's stuck on a limit, and the rest. */
function menuEntries(
  client: PluginClientContext,
  store: ZeroSubStore,
  { family, accounts, route, current, offerReset, other, offerFork, autoSwitch }: Standing,
  agent: TrackedAgent,
  moveStarted: MoveStarted,
): MenuEntry[] {
  const choose = (accountId: string | null, to: string) => async () => {
    const answer = store.rpc(setAgentAccount, { agentId: agent.id, accountId });
    moveStarted({ accountId, label: to }, answer);
    const summary = await answer.catch((error: unknown) => {
      // The move goes on without Paseo waiting for it, and the pill shows it under way.
      if (stoppedWaiting(error)) return null;
      throw error;
    });
    // The menu shows what an action throws: here, that the agent couldn't be reloaded.
    const problem = summary && moveProblem(summary, to);
    if (problem) throw new Error(problem);
  };

  // Codex threads can't change accounts in place; continue in this task's tab for that account.
  const movable = route?.movable ?? true;
  const now = Date.now();
  const items: MenuEntry[] = accounts.map((account, index) => ({
    kind: "item",
    id: `account-${index}`,
    title: account.id === current.id || movable ? accountName(account, now) : `Continue on ${account.label}`,
    detail: usageLine(account, now),
    icon: account.id === current.id ? "CircleCheck" : movable ? "Circle" : "ArrowRightLeft",
    // With automatic switching on, an account at its limit would only pass the agent on (the server refuses it too).
    disabled:
      account.status === "signed_out" ||
      isDisabled(account) ||
      (autoSwitch && account.status === "limited") ||
      account.id === current.id,
    behavior: { kind: "action", onPress: choose(account.id, account.label) },
  }));
  // When the agent is stuck on a limit, a way out is the most useful thing in the menu.
  const wayOut: MenuEntry[] = [];
  const resets = current.usage?.resets ?? null;
  if (offerReset && resets) {
    const entry: MenuEntry = {
      kind: "item",
      id: "use-reset",
      title: `Use a banked reset on ${current.label} (${resets.available} left)…`,
      icon: "TimerReset",
      behavior: { kind: "popover", Content: resetPopover(store, current.id, agent.id) },
    };
    if (current.status === "limited") wayOut.push(entry);
    else items.push(entry);
  }
  if (offerFork && other) {
    wayOut.push({
      kind: "item",
      id: "fork-other",
      title: `Continue on ${FAMILY_LABEL[other]} (new agent)…`,
      icon: "GitFork",
      behavior: { kind: "popover", Content: forkPopover(store, agent.id, family, other) },
    });
  }
  if (wayOut.length > 0) items.unshift(...wayOut, { kind: "separator", id: "way-out-divider" });
  if (route?.selectionReason === "weekly_reset") {
    items.push({
      kind: "item", id: "selection-reason",
      title: "Started here: weekly reset was near",
      icon: "Info", disabled: true, behavior: { kind: "action", onPress() {} },
    });
  }
  items.push({ kind: "separator", id: "manage-divider" });
  if (route?.pinned && movable) {
    const fallback = accounts.find((account) => account.isDefault);
    items.push({
      kind: "item",
      id: "follow-default",
      title: fallback ? `Follow default (${fallback.label})` : "Follow default",
      icon: "Undo2",
      behavior: { kind: "action", onPress: choose(null, fallback?.label ?? "the default account") },
    });
  }
  items.push({
    kind: "item",
    id: "manage",
    title: "Manage accounts…",
    icon: "Users",
    behavior: {
      kind: "action",
      onPress() {
        client.openSurface("accounts");
      },
    },
  });
  return items;
}

/**
 * An account's usage, under its name in the menu: "5h 4% ↻2h40m · 7d 24% ↻1d17h", for each window
 * that stops the whole account and how long until it resets, then any ChatGPT credits. With no
 * reading (it failed, or there's none yet) the windows are there, empty, so every entry reads alike;
 * an account the provider reports no usage for (an API account, any Pi account) has none.
 */
function usageLine(account: AccountView, now: number): string | null {
  const windows = shownWindows(account, now);
  const credits = account.status === "signed_out" ? null : (account.usage?.credits ?? null);
  const creditsText = credits ? ` · ${formatCredits(credits)}` : "";
  if (windows.length === 0) return reportsUsage(account) ? `5h – · 7d –${creditsText}` : null;
  return (
    windows
      .map(({ name, percent, resetsAt }) => {
        const left = formatCountdown(resetsAt, now);
        return `${name} ${formatPercent(percent)}${left ? ` ↻${left}` : ""}`;
      })
      .join(" · ") + creditsText
  );
}

/** The account, and why it can't be used, if it can't. */
function accountName(account: AccountView, now: number): string {
  if (account.status === "signed_out") return `${account.label} (signed out${account.disabled ? ", disabled" : ""})`;
  if (isDisabled(account)) return `${account.label} (disabled)`;
  if (account.status === "limited") {
    const windows = shownWindows(account, now);
    // A full window says it already.
    if (windows.some((window) => window.percent >= 100)) return account.label;
    // With no reading to say when, the limit's own end does.
    const until = windows.length > 0 ? null : formatCountdown(account.limitedUntil, now);
    return `${account.label} (limit reached${until ? ` ↻${until}` : ""})`;
  }
  return account.label;
}

/**
 * The windows that stop the whole account, as a full "Weekly · Opus" doesn't, as they stand at
 * `now`. None for a signed-out account, whose last reading may be long gone.
 */
function shownWindows(account: AccountView, now: number): { name: string; percent: number; resetsAt: string | null }[] {
  if (account.status === "signed_out" || !account.usage) return [];
  return account.usage.windows.filter(capsAccount).map((window) => ({
    name: shortWindowLabel(window.label),
    // Past its reset, a window starts again from nothing; the next reading says how much since.
    percent: window.resetsAt && Date.parse(window.resetsAt) <= now ? 0 : window.usedPercent,
    resetsAt: window.resetsAt,
  }));
}
