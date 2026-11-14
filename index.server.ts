import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import { ClaudeAdapter } from "./server/claude";
import { CodexAdapter } from "./server/codex";
import { PiAdapter } from "./server/pi";
import { Service, describe } from "./server/service";
import { preferences } from "./shared/preferences";
import {
  addApiAccount,
  cancelLogin,
  clearAccountLimit,
  getState,
  redeemReset,
  removeAccount,
  renameAccount,
  setAgentAccount,
  setDefaultAccount,
  setNextAgentAccount,
  setAccountEnabled,
  forkAgent,
  importPiAccount,
  setAccountProxy,
  setPiHomesDir,
  startLogin,
  submitLoginCode,
  updateApiAccount,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const service = new Service({ claude: new ClaudeAdapter(), codex: new CodexAdapter(), pi: new PiAdapter() });

  const settings = server.registerSettings(preferences);
  const applySettings = (state: PluginSettingsState<typeof preferences.schema>) => {
    if (state.status === "ready") service.setPreferences(state.values);
  };
  void settings.read().then(applySettings, (error: unknown) => console.error("[ZeroSub] could not read preferences", describe(error)));
  const stopSettings = settings.subscribe(applySettings);

  void service.start().catch((error: unknown) => console.error("[ZeroSub] startup failed; trying again in 30 s", describe(error)));

  // Never let routing break or stall an agent: on any error, or if it takes too long (Paseo fails
  // a hook after 30s), the session simply opens on its usual login. Routing is told it was given
  // up on, so it doesn't record an account the session never opened on.
  server.before("agent.session_open", async ({ request }, context) => {
    const late = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[ZeroSub] routing ${request.agentId} took too long; using the default login`);
        late.abort();
        resolve(undefined);
      }, 15_000);
    });
    try {
      return await Promise.race([service.onSessionOpen(request, context, late.signal), deadline]);
    } catch (error) {
      console.error(`[ZeroSub] could not route ${request.agentId}; using the default login`, describe(error));
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  });

  server.on("agent.turn_started", (event, context) => {
    void service.onTurnStarted(event.agent, context).catch(() => undefined);
  });

  // Failover can take longer than a hook invocation is allowed to, so it runs in the background.
  server.on("agent.turn_ended", (event, context) => {
    void service.onTurnEnded(event, context).catch((error: unknown) => {
      console.error(`[ZeroSub] failover for ${event.agent.id} failed`, describe(error));
    });
  });
  server.on("agent.archived", (event) => {
    void service.onAgentArchived(event.agent.id).catch(() => undefined);
  });
  // Paseo 0.11 and later say when an agent closes, though the plugin SDK's types don't list it yet.
  // An older Paseo refuses the event; agents then keep their record until their session next opens.
  try {
    const lifecycle = server as unknown as { on(name: "agent.closed", handler: (event: { agent: { id: string } }) => void): unknown };
    lifecycle.on("agent.closed", (event) => {
      void service.onAgentClosed(event.agent.id).catch(() => undefined);
    });
  } catch (error) {
    console.error("[ZeroSub] this Paseo doesn't report closed agents", describe(error));
  }

  server.handle(getState, ({ refreshUsage }, { paseo }) => service.view(paseo, refreshUsage));
  server.handle(startLogin, ({ family, method, accountId }) => service.startLogin(family, method, accountId));
  server.handle(submitLoginCode, ({ loginId, code }) => service.submitCode(loginId, code));
  server.handle(cancelLogin, ({ loginId }) => service.cancelLogin(loginId));
  server.handle(renameAccount, async ({ accountId, label }) => {
    await service.rename(accountId, label);
    return { ok: true as const };
  });
  server.handle(removeAccount, async ({ accountId }, { paseo }) => {
    const { affected, moves } = await service.remove(paseo, accountId);
    return { ok: true as const, movedAgents: affected, moves };
  });
  server.handle(setNextAgentAccount, ({ accountId, enabled }) => service.setNextAgent(accountId, enabled));
  server.handle(setDefaultAccount, ({ accountId }, { paseo }) => service.setDefault(paseo, accountId));
  server.handle(clearAccountLimit, async ({ accountId }) => {
    await service.clearLimit(accountId);
    return { ok: true as const };
  });
  server.handle(redeemReset, ({ accountId, agentId }, { paseo }) => service.redeem(paseo, accountId, agentId));
  server.handle(setAgentAccount, ({ agentId, accountId }, { paseo }) => service.setAgentAccount(paseo, agentId, accountId));
  server.handle(forkAgent, ({ agentId, destination }, { paseo }) => service.forkAgent(paseo, agentId, destination));
  server.handle(setAccountEnabled, ({ accountId, enabled }, { paseo }) => service.setAccountEnabled(paseo, accountId, enabled));
  server.handle(addApiAccount, async (input) => ({ accountId: await service.addApiAccount(input) }));
  server.handle(updateApiAccount, async ({ accountId, ...input }) => {
    await service.updateApiAccount(accountId, input);
    return { ok: true as const };
  });
  server.handle(setAccountProxy, async ({ accountId, proxy }) => ({ ok: true as const, proxy: await service.setProxy(accountId, proxy) }));
  server.handle(setPiHomesDir, async ({ dir }) => ({ ok: true as const, ...(await service.setPiHomesDir(dir)) }));
  server.handle(importPiAccount, async ({ path }) => ({ accountId: await service.importPiAccount(path) }));

  return async () => {
    stopSettings();
    await service.stop();
  };
}
