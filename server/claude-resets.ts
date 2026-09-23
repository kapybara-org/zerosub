import type { ResetOffer } from "../shared/model";
import type { RedeemReply } from "./adapter";

/**
 * Claude's banked "limit reset" (Claude Code's hidden `/limit-reset`, program `cedar_ember`).
 * Status arrives as a `cedar_ember` block in `/api/oauth/usage?cedar_ember=1`; redeeming posts the
 * next grant to `/api/organizations/{org}/reset_rate_limits`. Field names follow Claude Code 2.1.x.
 */
export const CLAUDE_RESET_PROGRAM = "cedar_ember";
export const GRANT_ID = /^[a-z0-9_-]{1,40}$/;

const LIMIT_LABELS: Record<string, string> = {
  five_hour: "5-hour",
  seven_day: "weekly",
  seven_day_opus: "Opus weekly",
  seven_day_sonnet: "Sonnet weekly",
  seven_day_overage_included: "Fable weekly",
};

const INELIGIBLE: Record<string, string> = {
  config_off: "Limit resets aren't switched on for this account.",
  tier: "This plan doesn't include limit resets.",
  seat: "This seat type doesn't include limit resets.",
  mobile: "Resets bought on mobile can only be used there.",
  surface: "This reset can't be used from Claude Code.",
  cli_version: "Update Claude Code to use this reset.",
  no_grant: "No banked resets on this account.",
  tenure: "This account isn't eligible for resets yet.",
  other_experiment: "This account is in a different limit experiment.",
  unavailable: "Limit resets aren't available right now.",
};

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function limitTypes(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function labels(types: readonly string[]): string[] {
  return [...new Set(types.map((type) => LIMIT_LABELS[type] ?? "weekly"))];
}

function joinLabels(types: readonly string[]): string {
  const names = labels(types);
  if (names.length <= 1) return names[0] ?? "usage";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

function isoTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

interface Grant {
  id: string;
  label: string;
  resetsLeft: number;
  endsAt: string | null;
  clears: string[];
  paused: boolean;
  usableNow: boolean;
  useRequiresLimit: boolean;
  blocking: string[];
}

function parseGrant(value: unknown): Grant | null {
  if (!isObject(value) || typeof value.id !== "string" || !GRANT_ID.test(value.id)) return null;
  const left = value.resets_left;
  if (typeof left !== "number" || !Number.isInteger(left) || left < 0) return null;
  return {
    id: value.id,
    label: typeof value.label === "string" ? value.label : "",
    resetsLeft: left,
    endsAt: isoTime(value.ends_at),
    clears: limitTypes(value.clears),
    paused: value.paused === true,
    usableNow: value.usable_now === true,
    useRequiresLimit: value.use_requires_limit !== false,
    blocking: limitTypes(value.blocking),
  };
}

export interface ClaudeResetStatus {
  offer: ResetOffer | null;
  /** The grant the server will accept next; claims for any other grant are refused. */
  nextGrantId: string | null;
  /** Claude sees the account at a usage limit right now. */
  atLimit: boolean;
}

/** Reads the `cedar_ember` block. `offer` is null when nothing is banked. */
export function parseClaudeResets(block: unknown, now: number = Date.now()): ClaudeResetStatus {
  if (!isObject(block)) return { offer: null, nextGrantId: null, atLimit: false };
  const atLimit = block.at_limit === true;
  const grants = (Array.isArray(block.grants) ? block.grants : []).map(parseGrant).filter((grant): grant is Grant => grant !== null);
  const available = grants.reduce((sum, grant) => sum + grant.resetsLeft, 0);
  if (available === 0) return { offer: null, nextGrantId: null, atLimit };

  const nextId = typeof block.next_grant_id === "string" && grants.some((grant) => grant.id === block.next_grant_id) ? block.next_grant_id : null;
  const next = grants.find((grant) => grant.id === nextId) ?? grants.find((grant) => grant.resetsLeft > 0) ?? null;
  const eligible = block.eligible === true;
  const cooldown = isoTime(block.cooldown_until);

  let blockedReason: string | null = null;
  if (!eligible) {
    const reason = typeof block.ineligible_reason === "string" ? block.ineligible_reason : "unavailable";
    blockedReason = INELIGIBLE[reason] ?? INELIGIBLE.unavailable ?? null;
  } else if (cooldown && Date.parse(cooldown) > now) {
    blockedReason = `Resets are cooling down until ${new Date(cooldown).toLocaleString()}.`;
  } else if (!next || !nextId) {
    blockedReason = "Not usable right now.";
  } else if (next.paused) {
    blockedReason = "This reset is paused for now.";
  } else if (next.blocking.length > 0) {
    blockedReason = `This reset doesn't refill your ${joinLabels(next.blocking)} limit, so it can't be used until that resets.`;
  } else if (next.useRequiresLimit && !atLimit) {
    blockedReason = "Can be used once this account hits a limit.";
  } else if (!next.usableNow) {
    blockedReason = "Not usable right now; try again in a minute.";
  }

  return {
    nextGrantId: nextId,
    atLimit,
    offer: {
      available,
      usableNow: blockedReason === null,
      blockedReason,
      expiresAt: next?.endsAt ?? null,
      refills: next ? labels(next.clears) : [],
      label: next?.label.trim() || null,
    },
  };
}

/** A one-line, secret-free summary of the `cedar_ember` block, for the plugin log. */
export function describeResetBlock(block: unknown): string {
  if (block === undefined || block === null) return "not offered to this account (no reset program in the usage reply)";
  if (!isObject(block)) return "unreadable reset status";
  const grants = Array.isArray(block.grants) ? block.grants.length : 0;
  const left = (Array.isArray(block.grants) ? block.grants : [])
    .map(parseGrant)
    .reduce((sum, grant) => sum + (grant?.resetsLeft ?? 0), 0);
  const eligibility = block.eligible === true ? "eligible" : `not eligible (${String(block.ineligible_reason ?? "unknown")})`;
  const props = isObject(block.event_props) ? block.event_props : {};
  const seenAs = [props.surface, props.tier].filter((value) => typeof value === "string").join("/");
  return `${eligibility}, ${grants} grant(s), ${left} reset(s) left${block.at_limit === true ? ", at a limit" : ""}${
    seenAs ? ` [seen as ${seenAs}]` : ""
  }`;
}

/** Turns the claim endpoint's reply into an outcome and a sentence for the user. */
export function readClaimReply(body: unknown): RedeemReply {
  if (!isObject(body) || typeof body.result !== "string") {
    return { outcome: "error", message: "Claude sent an unreadable reply. Check the account's usage before trying again.", left: null };
  }
  const left = typeof body.resets_left === "number" ? body.resets_left : null;
  const leftText = left === null ? "" : ` · ${left} left`;
  switch (body.result) {
    case "reset": {
      const cleared = limitTypes(body.cleared);
      return { outcome: "reset", message: `Limits reset${cleared.length ? ` (${joinLabels(cleared)})` : ""}${leftText}.`, left };
    }
    case "already_used":
      return { outcome: "already_used", message: `That reset was already used${leftText}.`, left };
    case "not_limited":
      return {
        outcome: "not_limited",
        message: "This account isn't at a usage limit right now, so the reset was kept. Use it once the account hits a limit.",
        left,
      };
    case "cooldown": {
      const until = isoTime(body.cooldown_until);
      return {
        outcome: "cooldown",
        message: `Resets are cooling down${until ? ` until ${new Date(until).toLocaleString()}` : ""}. The reset was kept.`,
        left,
      };
    }
    case "ineligible": {
      const reason = typeof body.reason === "string" ? INELIGIBLE[body.reason] : undefined;
      return { outcome: "unavailable", message: reason ?? "This account can't use a reset right now. The reset was kept.", left };
    }
    default:
      return { outcome: "unavailable", message: "Limit resets aren't available right now. The reset was kept.", left };
  }
}
