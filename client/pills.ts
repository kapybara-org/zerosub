import type {
  PluginButton,
  PluginButtonContentProps,
  PluginButtonIcon,
  PluginButtonMenuEntry,
  PluginButtonRegistration,
  PluginClientContext,
} from "@getpaseo/plugin/client";
import type { ComponentType } from "react";
import { moveProblem, pillText, shortLabel } from "../shared/format";
import { accountRoom, glance, glanceLabel, glanceTitle } from "../shared/glance";
import { accountGlyph } from "../shared/glyph";
import { FAMILY_LABEL, HAND_OFF, OTHER_FAMILY, type AccountView, type StateView } from "../shared/model";
import { setAgentAccount } from "../shared/rpc";
import { accountOf, type TrackedAgent } from "./agent-account";
import { agentAccounts } from "./agent-accounts";
import { forkPopover } from "./fork-confirm";
import { resetPopover } from "./reset-confirm";
import { stoppedWaiting, type ZeroSubStore } from "./store";
import { usageCard } from "./usage-card";
import { glyphIcon } from "./usage-icon";

/** The most agents Paseo returns per page. */
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

/** An agent as Paseo lists it; `runtimeInfo` arrived after the SDK this builds against. */
interface ListedAgent {
  id: string;
  workspaceId?: string | null;
  provider: string;
  model?: string | null;
  runtimeInfo?: { model?: string | null } | null;
}

interface WantedPill {
  id: string;
  button: PluginButton;
  key: string;
}

/**
 * One composer pill per Claude/Codex agent showing the account it runs on. Tapping it opens a menu
 * of that provider's accounts. Pills only appear once a provider has more than one account, so a
 * single-account setup looks exactly like stock Paseo.
 *
 * An agent that can move between accounts in place opens "Accounts for this agent" instead: which
 * accounts this conversation may use, in which order, and where its next turn runs.
 *
 * Next to it, the agent's usage at a glance (see `glance`): the window that holds it back the most,
 * and a second one while the 5-hour window is nearly spent. Either opens the usage card.
 */
export function contributePills(client: PluginClientContext, store: ZeroSubStore): () => void {
  const agents = new Map<string, TrackedAgent>();
  const pills = new Map<string, { agentId: string; registration: PluginButtonRegistration; key: string }>();
  const lifetime = new AbortController();
  let stopped = false;
  const card = usageCard(store, (agentId) => agents.get(agentId), () => client.openSurface("accounts"));
  const panel = agentAccounts(store, (agentId) => agents.get(agentId), () => client.openSurface("accounts"));

  function sync(): void {
    if (stopped) return;
    const state = store.current.state;
    const wanted = new Map<string, { agent: TrackedAgent; pill: WantedPill }>();
    for (const agent of agents.values()) {
      for (const pill of state ? pillsFor(client, store, state, agent, card, panel) : []) {
        wanted.set(`${agent.id}\u0000${pill.id}`, { agent, pill });
      }
    }
    for (const [slot, pill] of pills) {
      if (!wanted.has(slot)) {
        pill.registration.remove();
        pills.delete(slot);
      }
    }
    for (const [slot, { agent, pill }] of wanted) {
      const existing = pills.get(slot);
      if (existing) {
        if (existing.key !== pill.key) {
          existing.registration.update(pill.button);
          existing.key = pill.key;
        }
        continue;
      }
      try {
        const registration = client.addComposerPill({
          id: pill.id,
          workspaceId: agent.workspaceId,
          agentId: agent.id,
          button: pill.button,
        });
        pills.set(slot, { agentId: agent.id, registration, key: pill.key });
      } catch (error) {
        console.warn(`[ZeroSub] could not add ${pill.id} pill`, error);
      }
    }
  }

  const unsubscribeStore = store.subscribe(sync);

  const track = (agent: ListedAgent) => {
    if (!agent.workspaceId) return;
    const model = agent.runtimeInfo?.model ?? agent.model ?? null;
    agents.set(agent.id, { id: agent.id, workspaceId: agent.workspaceId, provider: agent.provider, model });
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
      for (const { agent } of result.entries) track(agent as ListedAgent);
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
          for (const { agent } of entries) track(agent as ListedAgent);
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
            track(update.agent as ListedAgent);
            // A new agent may have been routed by the daemon a moment ago; fetch its account.
            if (!known) void store.refresh();
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
    lifetime.abort();
    unsubscribeStore();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}

function pillsFor(
  client: PluginClientContext,
  store: ZeroSubStore,
  state: StateView,
  agent: TrackedAgent,
  card: ComponentType<PluginButtonContentProps>,
  panel: ComponentType<PluginButtonContentProps>,
): WantedPill[] {
  const pills: WantedPill[] = [];
  const button = buttonFor(client, store, state, agent, panel);
  if (button) pills.push({ id: "account", button, key: JSON.stringify([button.label, button.title, iconKey(button.icon), menuKey(button)]) });
  pills.push(...usagePills(state, agent, card));
  return pills;
}

/**
 * "54% week", "87% 5h", "64% Fable": how much of the window that holds the agent back is used, with
 * that window's own glyph (a clock for 5 hours, a calendar for the week, a sparkle for Fable) filling
 * alike and turning amber, then red, near the end. Once full, the wait: "5h full ·
 * 1h 37m". Hovering says it in a sentence; tapping opens the usage card. Nothing without a reading,
 * so no guess ever shows.
 */
function usagePills(state: StateView, agent: TrackedAgent, card: ComponentType<PluginButtonContentProps>, now: number = Date.now()): WantedPill[] {
  if (!state.showComposerPill) return [];
  const account = accountOf(state, agent);
  if (!account?.usage || account.status === "signed_out" || account.status === "disabled") return [];
  return glance(account.usage.windows, agent.model, now).map((entry, index) => {
    const label = glanceLabel(entry, now);
    const title = glanceTitle(entry, now);
    const { window: limit, tone } = entry;
    const icon = glyphIcon(entry.kind, limit.usedPercent, tone);
    const button: PluginButton = { title, icon, label, behavior: { kind: "popover", Content: card } };
    return { id: index === 0 ? "usage" : "usage-next", button, key: JSON.stringify([label, title, icon.displayName]) };
  });
}

function buttonFor(
  client: PluginClientContext,
  store: ZeroSubStore,
  state: StateView,
  agent: TrackedAgent,
  panel: ComponentType<PluginButtonContentProps>,
): PluginButton | null {
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
  // A banked reset is worth offering right where the agent stopped, even with a single account.
  const resets = current.usage?.resets ?? null;
  const offerReset = resets !== null && (current.status === "limited" || resets.usableNow);
  // With every account of this provider out, the work can carry on with the other provider (Pi has none).
  const other = OTHER_FAMILY[family];
  const offerFork =
    other !== null &&
    current.status === "limited" &&
    accounts.every((account) => account.status === "limited" || account.status === "signed_out" || account.status === "disabled") &&
    state.accounts.some((account) => account.family === other && account.status === "ready");
  if (accounts.length < 2 && !(current.status === "limited" && (offerReset || offerFork))) return null;

  const choose = (accountId: string | null, to: string) => async () => {
    const summary = await store.rpc(setAgentAccount, { agentId: agent.id, accountId }).catch((error: unknown) => {
      // The move goes on without Paseo waiting for it, and the pill shows it under way.
      if (stoppedWaiting(error)) return null;
      throw error;
    });
    // Paseo shows what an action throws: here, that the agent couldn't be reloaded.
    const problem = summary && moveProblem(summary, to);
    if (problem) throw new Error(problem);
  };

  // Codex threads can't change accounts in place; continue in this task's tab for that account.
  const movable = route?.movable ?? true;
  const now = Date.now();
  const running = route?.pendingAccountId ? state.accounts.find((account) => account.id === route.pendingAccountId) : undefined;
  const moves = route?.waiting ?? (state.canReopen ? "idle" : "restart");

  // An agent that moves in place gets its own panel: its accounts, their order, its next turn.
  if (movable && accounts.length >= 2) {
    const atWall = route?.atWall === true;
    const text = pillText(current, running ?? null, moves, "Accounts for this agent");
    return {
      title: atWall ? "Accounts for this agent: every checked account is full" : text.title,
      icon: current.status === "limited" || atWall ? "CircleAlert" : "CircleUserRound",
      label: atWall ? `${shortLabel(current)} · waiting` : text.label,
      behavior: { kind: "popover", Content: panel },
    };
  }

  // Grok conversations stay on their account: the others are listed, not offered.
  const stays = !movable && !HAND_OFF[family];
  const items: PluginButtonMenuEntry[] = accounts.map((account, index) => {
    const picked = account.id === current.id;
    const inPlace = picked || movable || stays;
    return {
      kind: "item",
      id: `account-${index}`,
      title: inPlace ? menuTitle(account, now) : `Continue on ${menuTitle(account, now)}`,
      icon: inPlace ? menuIcon(account, agent.model, now) : "ArrowRightLeft",
      // With automatic switching on, an account at its limit would only pass the agent on (the server refuses it too).
      disabled:
        stays || account.status === "signed_out" || account.status === "disabled" || (state.autoSwitch && account.status === "limited") || picked,
      behavior: { kind: "action", onPress: choose(account.id, account.label) },
    };
  });
  // When the agent is stuck on a limit, a way out is the most useful thing in the menu.
  const wayOut: PluginButtonMenuEntry[] = [];
  if (offerReset && resets) {
    const entry: PluginButtonMenuEntry = {
      kind: "item",
      id: "use-reset",
      title: `Use a banked reset on ${current.label} (${resets.available} left)…`,
      icon: "TimerReset",
      behavior: { kind: "popover", Content: resetPopover(store, current, agent.id) },
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
  if (stays) {
    items.push({
      kind: "item", id: "stays",
      title: `${FAMILY_LABEL[family]} conversations stay on their account; new agents follow your pick`,
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

  return {
    ...pillText(current, running ?? null, moves),
    icon: current.status === "limited" ? "CircleAlert" : "CircleUserRound",
    behavior: { kind: "menu", items },
  };
}

/**
 * An account in the menu, by the room it has, since that is what picking one weighs: "work · 46%
 * left · week", "personal · full, back in 1h 37m". Its own windows only: a model's full window
 * (Claude's "Weekly · Opus") leaves the account usable for the rest.
 */
function menuTitle(account: AccountView, now: number): string {
  const room = accountRoom(account, now);
  return room ? `${account.label} · ${room}` : account.label;
}

/** The glyph of the window that holds the agent's model back the most on that account. */
function menuIcon(account: AccountView, model: string | null, now: number): PluginButtonIcon {
  const glyph = accountGlyph(account, model, now);
  return glyphIcon(glyph.kind, glyph.usedPercent, glyph.tone, { dashed: glyph.dashed });
}

function iconKey(icon: PluginButtonIcon | undefined): string {
  if (!icon) return "";
  return typeof icon === "string" ? icon : (icon.displayName ?? icon.name);
}

function menuKey(button: PluginButton): string {
  return button.behavior.kind === "menu"
    ? button.behavior.items
        .map((item) => (item.kind === "item" ? `${item.id}:${item.title}:${iconKey(item.icon)}:${item.disabled}` : item.id))
        .join("|")
    : "";
}
