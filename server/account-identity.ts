import type { Family } from "../shared/model";
import type { Identity } from "./adapter";

type AccountIdentity = Pick<Identity, "identity" | "email">;

/** Compare old workspace-only Codex keys using their saved email, without rewriting the registry. */
export function sameAccountIdentity(
  family: Family, left: AccountIdentity, right: AccountIdentity, unknownMemberIsDuplicate = false,
): boolean {
  if (!left.identity || !right.identity) return false;
  if (family !== "codex") return left.identity === right.identity;
  const workspace = /^chatgpt\|([^|]+)(?:\|(.+))?$/;
  const a = workspace.exec(left.identity);
  const b = workspace.exec(right.identity);
  if (!a || !b) return left.identity === right.identity;
  if (a[1] !== b[1]) return false;
  const memberA = (a[2] ?? left.email)?.trim().toLowerCase();
  const memberB = (b[2] ?? right.email)?.trim().toLowerCase();
  // Unknown members block duplicate additions but cannot authenticate as a known managed member.
  if (!memberA || !memberB) return unknownMemberIsDuplicate || (!memberA && !memberB);
  return memberA === memberB;
}
