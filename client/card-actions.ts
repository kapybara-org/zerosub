import { FAMILY_LABEL, type AccountView } from "../shared/model";
import { egressText, isDisabled } from "../shared/format";

export type CardActionKey = "clear" | "next" | "default" | "toggle" | "usage" | "api" | "azure" | "bedrock" | "proxy" | "sessions" | "rename" | "remove";

/** Which buttons an account's card shows, in order. The card gives each its icon, label and handler. */
export function cardActions(
  account: Pick<AccountView, "family" | "kind" | "auth" | "status" | "disabled" | "isDefault" | "nextAgentUntil" | "apiEditable" | "proxyEditable" | "azure" | "bedrock"> &
    Partial<Pick<AccountView, "sessionsShared">>,
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
  // An Azure OpenAI account's endpoint, key and prices have a form of their own, and so do an AWS
  // Bedrock account's region, credentials, models and prices.
  if (account.azure) keys.push("azure");
  else if (account.bedrock) keys.push("bedrock");
  else if (account.auth === "api" || account.apiEditable) keys.push("api");
  if (account.proxyEditable) keys.push("proxy");
  // Only an added Claude account's can be shared, and an older server doesn't say.
  if (typeof account.sessionsShared === "boolean") keys.push("sessions");
  keys.push("rename");
  if (account.kind !== "main") keys.push("remove");
  return keys;
}

/** How many buttons a wide card keeps beside the account's name; the rest open from "…" under it. */
export const INLINE_CARD_ACTIONS = 3;

/** Kept beside the name first, when the card has them: the ones used most. */
const INLINE_FIRST: readonly CardActionKey[] = ["clear", "usage", "default", "next"];

/**
 * A wide card's buttons sit beside the account's name, and nine of them leave the name little
 * room. So up to `INLINE_CARD_ACTIONS` stay there and the rest open from "…" into a row under it.
 * One button more than that fits as well as "…" does, so then they all stay. Both keep the card's order.
 */
export function splitCardActions(keys: readonly CardActionKey[]): { inline: CardActionKey[]; more: CardActionKey[] } {
  if (keys.length <= INLINE_CARD_ACTIONS + 1) return { inline: [...keys], more: [] };
  const kept = new Set(INLINE_FIRST.filter((key) => keys.includes(key)).slice(0, INLINE_CARD_ACTIONS));
  for (const key of keys) if (kept.size < INLINE_CARD_ACTIONS) kept.add(key);
  return { inline: keys.filter((key) => kept.has(key)), more: keys.filter((key) => !kept.has(key)) };
}

/** Whether removing an account moves its agents' conversations to the default account (see the server's `remove`). */
function conversationsMove(family: AccountView["family"]): boolean {
  return family === "claude" || family === "pi";
}

/** What the Remove dialog says, and its button's tooltip. */
export function removeText(account: Pick<AccountView, "family" | "auth" | "home" | "externalHome" | "launcher" | "azure" | "bedrock">): { body: string; tooltip: string } {
  const moves = conversationsMove(account.family);
  const keyed = account.family === "pi" || account.auth === "api";
  const what = account.externalHome
    ? `This only removes the account from ZeroSub. Its folder${account.home ? ` (${account.home})` : ""} is outside ZeroSub's own, so its sign-in${
        account.launcher ? `, its files and its terminal script ${account.launcher}` : " and its files"
      } stay as they are, and you can add it back by hand.`
    : account.bedrock
      ? "This deletes the account's folder on this machine, with its AWS settings (and access key, if it has one) and its token counts."
      : account.azure
      ? "This deletes the account's saved key and endpoint on this machine, and its token counts."
      : keyed
        ? "This deletes the account's folder and saved key on this machine."
        : "This signs the account out on this machine and deletes its saved login.";
  const agents = moves
    ? "Agents using it move to the default account; their conversations are kept."
    : `New agents use the default account. Existing ${FAMILY_LABEL[account.family]} conversations on it can't move, so start new agents for them.`;
  const action = account.externalHome
    ? "Remove it from ZeroSub only"
    : account.bedrock
      ? "Delete its AWS settings"
      : keyed
        ? "Delete its saved key"
        : "Sign it out and delete its saved login";
  return { body: `${what} ${agents}`, tooltip: `${action}; ${moves ? "its agents move to the default" : "new agents use the default"}` };
}

/** The line under a Claude card's name: its key or token and where it goes, its proxy, the address Anthropic sees, its script. */
export function claudeCardDetails(account: Pick<AccountView, "family" | "api" | "proxy" | "egress" | "launcher">): string | null {
  if (account.family !== "claude") return null;
  const api = account.api;
  const parts = [
    api ? `${api.keyKind === "api_key" ? "Key" : "Token"}${api.keyHint ? ` …${api.keyHint}` : ""} · ${api.baseUrl ?? "Anthropic API"}` : null,
    account.proxy ? `Via ${account.proxy}` : null,
    egressText(account.egress),
    account.launcher ? `Terminal: ${account.launcher}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}
