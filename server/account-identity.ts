import type { Family } from "../shared/model";
import type { Identity } from "./adapter";

type AccountIdentity = Pick<Identity, "identity" | "email">;

/** A Codex key read without its workspace, because `account/rateLimits/read` failed (see codex.ts). */
export function withoutWorkspace(identity: string | null | undefined): boolean {
  return identity?.startsWith("chatgpt-email|") === true;
}

/** Compare old workspace-only Codex keys using their saved email, without rewriting the registry. */
export function sameAccountIdentity(
  family: Family, left: AccountIdentity, right: AccountIdentity, unknownMemberIsDuplicate = false,
): boolean {
  if (!left.identity || !right.identity) return false;
  if (family !== "codex") return left.identity === right.identity;
  const workspace = /^chatgpt\|([^|]+)(?:\|(.+))?$/;
  const a = workspace.exec(left.identity);
  const b = workspace.exec(right.identity);
  if (withoutWorkspace(left.identity) || withoutWorkspace(right.identity)) {
    // Such a key can't say which workspace it is, only whose: the same email is the same person.
    const memberA = (a?.[2] ?? left.email)?.trim().toLowerCase();
    const memberB = (b?.[2] ?? right.email)?.trim().toLowerCase();
    return !!memberA && memberA === memberB;
  }
  if (!a || !b) return left.identity === right.identity;
  if (a[1] !== b[1]) return false;
  const memberA = (a[2] ?? left.email)?.trim().toLowerCase();
  const memberB = (b[2] ?? right.email)?.trim().toLowerCase();
  // Unknown members block duplicate additions but cannot authenticate as a known managed member.
  if (!memberA || !memberB) return unknownMemberIsDuplicate || (!memberA && !memberB);
  return memberA === memberB;
}
