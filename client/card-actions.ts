import type { AccountView } from "../shared/model";
import { isDisabled } from "../shared/format";

export type CardActionKey = "clear" | "next" | "default" | "toggle" | "usage" | "api" | "proxy" | "rename" | "remove";

/** Which buttons an account's card shows, in order. The card gives each its icon, label and handler. */
export function cardActions(
  account: Pick<AccountView, "family" | "kind" | "auth" | "status" | "disabled" | "isDefault" | "nextAgentUntil" | "apiEditable" | "proxyEditable">,
): CardActionKey[] {
  const disabled = isDisabled(account);
  const signedOut = account.status === "signed_out";
  const keys: CardActionKey[] = [];
  if (account.status === "limited") keys.push("clear");
  // A pick waiting here can always be canceled, whatever has become of the account since.
  if (account.nextAgentUntil || (!signedOut && !disabled)) keys.push("next");
  if (!account.isDefault && !signedOut && !disabled) keys.push("default");
  // No Pi account stands in for another, so a disabled one would still be used (see the server's
  // `setAccountEnabled`). One disabled before can still be enabled.
  if (account.family !== "pi" || disabled) keys.push("toggle");
  if (account.family === "claude" && account.auth !== "api") keys.push("usage");
  if (account.auth === "api" || account.apiEditable) keys.push("api");
  if (account.proxyEditable) keys.push("proxy");
  keys.push("rename");
  if (account.kind !== "main") keys.push("remove");
  return keys;
}
