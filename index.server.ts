import type { PluginServerContext, PluginSettingsState } from "@getpaseo/plugin/server";
import { ClaudeAdapter } from "./server/claude";
import { CodexAdapter } from "./server/codex";
import { OmpAccounts } from "./server/omp";
import { Service, describe } from "./server/service";
import { preferences } from "./shared/preferences";
import {
  cancelLogin,
  cancelOmpLogin,
  clearAccountLimit,
  getState,
  redeemOmpReset,
  redeemReset,
  removeAccount,
  removeOmpAccount,
  renameAccount,
  preferOmpAccount,
  setAgentAccount,
  setDefaultAccount,
  setAccountEnabled,
  setOmpReserve,
  setOmpSettings,
  forkAgent,
  startLogin,
  startOmpLogin,
  submitLoginCode,
  submitOmpLoginCode,
} from "./shared/rpc";

export default function contribute(server: PluginServerContext) {
  const service = new Service({ claude: new ClaudeAdapter(), codex: new CodexAdapter() });
  const omp = new OmpAccounts();

  const settings = server.registerSettings(preferences);
  const applySettings = (state: PluginSettingsState<typeof preferences.schema>) => {
    if (state.status === "ready") service.setPreferences(state.values);
  };
  void settings.read().then(applySettings, (error: unknown) => console.error("[ZeroSub] could not read preferences", describe(error)));
  const stopSettings = settings.subscribe(applySettings);

  void service.start().catch((error: unknown) => console.error("[ZeroSub] startup failed", describe(error)));

  // Never let routing break or stall an agent: on any error, or if it takes too long (Paseo fails
  // a hook after 30s), the session simply opens on its usual login.
  server.before("agent.session_open", async ({ request }, context) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => {
        console.error(`[ZeroSub] routing ${request.agentId} took too long; using the default login`);
        resolve(undefined);
      }, 15_000);
    });
    try {
      // OMP picks its own account; its sessions only get ZeroSub's settings overlay.
      const routed = request.provider === "omp" ? omp.openSession(request) : service.onSessionOpen(request, context);
      return await Promise.race([routed, deadline]);
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

  server.handle(getState, async ({ refreshUsage }, { paseo }) => {
    // OMP's part has a short time limit and never throws, so OMP can't hold up or break the rest.
    const [view, ompView] = await Promise.all([service.view(paseo, refreshUsage), omp.viewWithin(paseo, refreshUsage ?? false)]);
    return { ...view, omp: ompView };
  });
  server.handle(startLogin, ({ family, method, accountId }) => service.startLogin(family, method, accountId));
  server.handle(submitLoginCode, ({ loginId, code }) => service.submitCode(loginId, code));
  server.handle(cancelLogin, ({ loginId }) => service.cancelLogin(loginId));
  server.handle(renameAccount, async ({ accountId, label }) => {
    await service.rename(accountId, label);
    return { ok: true as const };
  });
  server.handle(removeAccount, async ({ accountId }, { paseo }) => ({
    ok: true as const,
    movedAgents: await service.remove(paseo, accountId),
  }));
  server.handle(setDefaultAccount, ({ accountId }, { paseo }) => service.setDefault(paseo, accountId));
  server.handle(clearAccountLimit, async ({ accountId }) => {
    await service.clearLimit(accountId);
    return { ok: true as const };
  });
  server.handle(redeemReset, ({ accountId, agentId }, { paseo }) => service.redeem(paseo, accountId, agentId));
  server.handle(setAgentAccount, ({ agentId, accountId }, { paseo }) => service.setAgentAccount(paseo, agentId, accountId));
  server.handle(forkAgent, ({ agentId }, { paseo }) => service.forkAgent(paseo, agentId));
  server.handle(setAccountEnabled, ({ accountId, enabled }, { paseo }) => service.setAccountEnabled(paseo, accountId, enabled));
  // OMP actions run only while Paseo's OMP provider is on. Canceling a sign-in stays open, so one
  // started before the provider was turned off can still be stopped.
  server.handle(startOmpLogin, async ({ provider }, { paseo }) => {
    await omp.assertEnabled(paseo);
    return omp.startLogin(provider);
  });
  server.handle(submitOmpLoginCode, async ({ loginId, code }, { paseo }) => {
    await omp.assertEnabled(paseo);
    return omp.submitCode(loginId, code);
  });
  server.handle(cancelOmpLogin, ({ loginId }) => omp.cancelLogin(loginId));
  server.handle(removeOmpAccount, async ({ provider, credentialId }, { paseo }) => {
    await omp.assertEnabled(paseo);
    await omp.remove(provider, credentialId);
    return { ok: true as const };
  });
  server.handle(redeemOmpReset, async ({ provider, credentialId }, { paseo }) => {
    await omp.assertEnabled(paseo);
    return omp.redeem(provider, credentialId);
  });
  server.handle(preferOmpAccount, async ({ provider, credentialId, preferred }, { paseo }) => {
    await omp.assertEnabled(paseo);
    await omp.prefer(provider, credentialId, preferred);
    return { ok: true as const };
  });
  server.handle(setOmpReserve, async ({ provider, credentialId, reservePct }, { paseo }) => {
    await omp.assertEnabled(paseo);
    await omp.setReserve(provider, credentialId, reservePct);
    return { ok: true as const };
  });
  server.handle(setOmpSettings, async ({ settings }, { paseo }) => {
    await omp.assertEnabled(paseo);
    await omp.setSettings(settings);
    return { ok: true as const };
  });

  return async () => {
    stopSettings();
    await service.stop();
    omp.stop();
  };
}
