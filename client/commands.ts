import type { PluginClientContext } from "@getpaseo/plugin/client";
import { describeReopen, limitedPick, moveProblem } from "../shared/format";
import { FAMILY_LABEL, type AccountView, type StateView } from "../shared/model";
import { setAgentAccount, setDefaultAccount, setNextAgentAccount, type ReopenSummary } from "../shared/rpc";
import { stoppedWaiting, type ZeroSubStore } from "./store";

/** Command Center entries and the `/account` slash command. */
export function contributeCommands(client: PluginClientContext, store: ZeroSubStore): () => void {
  const removers: Array<() => void> = [];

  removers.push(
    client.addCommandCenterItem({
      id: "open-accounts",
      title: "Manage subscription accounts (ZeroSub)",
      icon: "Users",
      keywords: ["zerosub", "claude", "chatgpt", "codex", "pi", "account", "subscription", "login", "switch"],
      context: "global",
      onSelect({ openSurface }) {
        openSurface("accounts");
      },
    }),
  );

  removers.push(
    client.addSlashCommand({
      name: "account",
      description: "Switch the subscription account this agent uses",
      argumentHint: "[name | default]",
      context: "agent",
      async onSubmit({ args, agent, openSurface }) {
        const state = await currentState(store);
        const family = state.providers[agent.provider];
        if (!family) throw new Error(`${agent.provider} agents don't use Claude or ChatGPT subscription accounts.`);
        const query = args.trim();
        if (!query) {
          openSurface("accounts");
          return;
        }
        const accounts = state.accounts.filter((account) => account.family === family);
        // Paseo shows what a command throws: a refusal, or that the agent couldn't be reloaded.
        const move = async (accountId: string | null, to: string) => {
          const problem = moveProblem(await stillMoving(store.rpc(setAgentAccount, { agentId: agent.id, accountId })), to);
          if (problem) throw new Error(problem);
        };
        if (/^default$/i.test(query)) {
          await move(null, accounts.find((account) => account.isDefault)?.label ?? "the default account");
          return;
        }
        const match = findAccount(accounts, query);
        if (!match) {
          const names = accounts.map((account) => account.label).join(", ");
          throw new Error(`No ${FAMILY_LABEL[family]} account matches "${query}". Accounts: ${names || "none"}.`);
        }
        if (match.status === "signed_out") throw new Error(`${match.label} is signed out. Sign it in from Accounts first.`);
        if (match.status === "disabled") throw new Error(`${match.label} is disabled. Enable it in Accounts first.`);
        if (match.status === "limited" && state.autoSwitch) throw new Error(limitedPick(match.label));
        await move(match.id, match.label);
      },
    }),
  );

  // One "Make … the default" entry per account, kept in step with the account list.
  let dynamic: Array<() => void> = [];
  let signature = "";
  const syncDynamic = () => {
    const state = store.current.state;
    const next = state ? JSON.stringify(state.accounts.map((a) => [a.id, a.label, a.isDefault, a.status, a.nextAgentUntil])) : "";
    if (next === signature) return;
    signature = next;
    for (const remove of dynamic) remove();
    dynamic = [];
    if (!state) return;
    state.accounts.forEach((account, index) => {
      const pending = Boolean(account.nextAgentUntil);
      // A waiting pick can always be canceled, whatever has become of its account since.
      if (pending || (account.status !== "signed_out" && account.status !== "disabled")) {
        dynamic.push(
          client.addCommandCenterItem({
            id: `next-agent-${index}`,
            title: pending
              ? `Cancel: next new ${FAMILY_LABEL[account.family]} agent on ${account.label}`
              : `Next new ${FAMILY_LABEL[account.family]} agent: use ${account.label}`,
            icon: pending ? "CircleX" : "SquarePlus",
            keywords: ["account", "next", "new agent", "workspace", account.email ?? "", account.family],
            context: "global",
            async onSelect() {
              await store.rpc(setNextAgentAccount, { accountId: account.id, enabled: !pending });
              await store.refresh();
            },
          }),
        );
      }
      if (account.isDefault || account.status === "signed_out" || account.status === "disabled") return;
      dynamic.push(
        client.addCommandCenterItem({
          id: `default-${index}`,
          title: `Make ${account.label} the default ${FAMILY_LABEL[account.family]} account`,
          icon: "Star",
          keywords: ["account", "default", "switch", account.email ?? "", account.family],
          context: "global",
          async onSelect() {
            const summary = await stillMoving(store.rpc(setDefaultAccount, { accountId: account.id }));
            // Only a reload that didn't work needs saying; Paseo shows what this throws.
            if (summary.failed.length > 0) throw new Error(describeReopen(`${account.label} is now the default`, summary));
          },
        }),
      );
    });
  };
  const unsubscribe = store.subscribe(syncDynamic);
  syncDynamic();

  return () => {
    unsubscribe();
    for (const remove of dynamic) remove();
    for (const remove of removers) remove();
  };
}

/** A move's outcome; nothing to report when Paseo stopped waiting for it, since it goes on regardless. */
async function stillMoving(request: Promise<ReopenSummary>): Promise<ReopenSummary> {
  return request.catch((error: unknown) => {
    if (stoppedWaiting(error)) return { reopened: [], deferred: [], failed: [], pending: [], continuedIn: null };
    throw error;
  });
}

async function currentState(store: ZeroSubStore): Promise<StateView> {
  if (!store.current.state) await store.refresh();
  const state = store.current.state;
  if (!state) throw new Error(store.current.error ?? "Accounts are not available yet.");
  return state;
}

export function findAccount(accounts: readonly AccountView[], query: string): AccountView | undefined {
  const needle = query.trim().toLowerCase();
  const exact = accounts.find(
    (account) => account.label.toLowerCase() === needle || account.email?.toLowerCase() === needle,
  );
  if (exact) return exact;
  const prefix = accounts.filter(
    (account) => account.label.toLowerCase().startsWith(needle) || account.email?.toLowerCase().startsWith(needle),
  );
  if (prefix.length === 1) return prefix[0];
  const partial = accounts.filter(
    (account) => account.label.toLowerCase().includes(needle) || account.email?.toLowerCase().includes(needle),
  );
  return partial.length === 1 ? partial[0] : undefined;
}
