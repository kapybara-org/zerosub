import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { PluginSessionOpenRequest } from "@getpaseo/plugin/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { StateViewSchema, type OmpView, type StateView } from "../shared/model";
import { OmpAccounts } from "./omp";
import { overlayPath } from "./omp-controls";

type PaseoApi = Parameters<OmpAccounts["view"]>[0];

async function overlay(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(overlayPath(), "utf8")) as Record<string, unknown>;
}

/** Every `omp` command run so far, one line of arguments each. */
async function calls(): Promise<string[]> {
  return (await readFile(join(root, "calls.log"), "utf8")).split("\n").filter(Boolean);
}

/**
 * Stands in for the `omp` CLI: logs every call and answers from `omp.json`, including the few rpc
 * commands ZeroSub sends over stdin. A test can make a command fail, print something else instead,
 * answer late, or send lines ZeroSub should ignore before each rpc answer.
 */
const FAKE_OMP = `
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_OMP_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ") + "\\n");
const data = JSON.parse(fs.readFileSync(path.join(dir, "omp.json"), "utf8"));
const name =
  args[0] === "--mode" ? "rpc"
  : args[0] === "--version" ? "version"
  : args[0] === "usage" && args[1] === "reset" ? "resets"
  : args[0] === "usage" && args.includes("--history") ? "history"
  : args[0] === "usage" && args[1] === "invalidate" ? "invalidate"
  : args[0];
const raw = data.raw || {};
const print = (value) => process.stdout.write(name in raw ? raw[name] : JSON.stringify(value));
function answer() {
  if (data.fail && data.fail[name]) {
    process.stderr.write(data.fail[name]);
    process.exit(1);
  }
  if (name === "rpc") {
    require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
      const command = JSON.parse(line);
      const reply = (payload) =>
        process.stdout.write((data.noise || "") + JSON.stringify({ type: "response", id: command.id, success: true, data: payload }) + "\\n");
      if (command.type === "get_login_providers") reply({ providers: data.providers });
      else if (command.type === "get_logout_accounts") reply({ accounts: data.lists[command.providerId] ?? [] });
      else reply({});
    });
  } else if (name === "version") process.stdout.write("omp/0.0.0");
  else if (name === "config") print(data.config);
  else if (name === "resets") print({ accounts: data.resets });
  else if (name === "history") print({ entries: data.history ?? [] });
  else if (name === "usage") print({ reports: data.reports ?? [] });
  else if (name === "dry-balance") print(data.balance ?? { model: args[1], success: { accounts: [] } });
  else print({});
}
setTimeout(answer, (data.delay && data.delay[name]) || 0);
`;

const work = { provider: "anthropic", credentialId: 3, label: "work", type: "oauth" };
const personal = { provider: "anthropic", credentialId: 4, label: "personal", type: "oauth" };
const chatgpt = { provider: "openai-codex", credentialId: 7, label: "chatgpt", type: "oauth" };
const resets = [
  { provider: "anthropic", credentialId: 3, accountId: "acct-work", orgId: "org-work", availableCount: 0, redeemableCount: 0 },
  { provider: "anthropic", credentialId: 4, accountId: "acct-personal", availableCount: 0, redeemableCount: 0 },
];

function paseoWith(providers: unknown): PaseoApi {
  return { config: { get: async () => ({ config: { providers } }) } } as unknown as PaseoApi;
}
const ompOn = paseoWith({ omp: { enabled: true } });

let root: string;
const previous = { PASEO_HOME: process.env.PASEO_HOME, FAKE_OMP_DIR: process.env.FAKE_OMP_DIR };

async function fakeOmp(config: Record<string, { value: unknown }> = {}, answers: Record<string, unknown> = {}): Promise<void> {
  await rm(join(root, "calls.log"), { force: true });
  await rm(join(root, "zerosub"), { recursive: true, force: true });
  await ompAnswers(config, answers);
}

/** Changes what the fake `omp` answers from now on; `answers` replaces parts of the usual ones. */
async function ompAnswers(config: Record<string, { value: unknown }> = {}, answers: Record<string, unknown> = {}): Promise<void> {
  await writeFile(
    join(root, "omp.json"),
    JSON.stringify({
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "openai-codex", name: "ChatGPT", authenticated: true },
        // A login alias: OMP lists the same ChatGPT credential under it.
        { id: "openai-codex-device", name: "ChatGPT (device)", authenticated: true },
        { id: "openrouter", name: "OpenRouter", authenticated: true },
      ],
      lists: {
        anthropic: [work, personal],
        "openai-codex": [chatgpt],
        "openai-codex-device": [chatgpt],
        openrouter: [{ provider: "openrouter", credentialId: 9, label: "key", type: "api_key" }],
      },
      resets,
      config: { "retry.usageReservePct": { value: 10 }, "auth.accountPolicies": { value: [] }, ...config },
      ...answers,
    }),
  );
}

/** Everything getState sends besides OMP's part, so a test can check the whole state the client parses. */
const claudeAndCodex: StateView = {
  accounts: [],
  agents: [],
  logins: [],
  providers: {},
  canReopen: false,
  browserSignIn: true,
  showComposerPill: false,
  warnings: [],
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-omp-"));
  const script = join(root, "fake-omp.cjs");
  await writeFile(script, FAKE_OMP);
  // ZeroSub runs the CLI Paseo is configured with, so the fake goes in through Paseo's config.
  await writeFile(join(root, "config.json"), JSON.stringify({ agents: { providers: { omp: { command: [process.execPath, script] } } } }));
  process.env.PASEO_HOME = root;
  process.env.FAKE_OMP_DIR = root;
});

beforeEach(() => fakeOmp());

afterAll(async () => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

describe("OmpAccounts", () => {
  it.each([
    ["turned off", paseoWith({ omp: { enabled: false } })],
    ["never configured (Paseo ships it off)", paseoWith({})],
    ["unreadable", { config: { get: async () => Promise.reject(new Error("daemon away")) } } as unknown as PaseoApi],
  ])("stays out of the way while Paseo's OMP provider is %s", async (_state, paseo) => {
    const omp = new OmpAccounts();
    expect(await omp.view(paseo, true)).toBeUndefined();
    await expect(omp.assertEnabled(paseo)).rejects.toThrow(/turned off/);
    expect(existsSync(join(root, "calls.log"))).toBe(false);
  });

  it("lists each OAuth login once, under its own provider, and leaves API keys out", async () => {
    const view = await new OmpAccounts().view(ompOn, true);
    expect(view?.accounts.map((account) => `${account.provider}/${account.credentialId}`)).toEqual([
      "anthropic/3",
      "anthropic/4",
      "openai-codex/7",
    ]);
    expect(view?.providers.map((provider) => provider.id)).toEqual(["anthropic", "openai-codex"]);
  });

  it("adds its overlay after the session's own overlays, and only once", async () => {
    const omp = new OmpAccounts();
    const request = { agentId: "a", provider: "omp", env: { PI_CONFIG_FILES: "/team.yml" } } as unknown as PluginSessionOpenRequest;
    const opened = await omp.openSession(request);
    expect(opened?.env.PI_CONFIG_FILES).toBe(["/team.yml", overlayPath()].join(delimiter));
    expect(await omp.openSession(opened!)).toBeUndefined();
    expect(await overlay()).toEqual({});
  });

  it("prefers at most one account per provider, and can drop the preference", async () => {
    const omp = new OmpAccounts();
    await omp.view(ompOn, true);
    await omp.prefer("anthropic", 3, true);
    await omp.prefer("anthropic", 4, true);
    expect(await overlay()).toEqual({
      auth: {
        accountPolicies: [{ provider: "anthropic", account: { accountId: "acct-personal" }, priority: 100, reclaimAbovePct: 25 }],
      },
    });
    const anthropic = (await omp.view(ompOn, false))?.accounts.filter((account) => account.provider === "anthropic");
    expect(anthropic?.map((account) => account.preferred)).toEqual([false, true]);
    await omp.prefer("anthropic", 4, false);
    expect(await overlay()).toEqual({});
  });

  it("refuses preferences for a login it can't identify", async () => {
    const omp = new OmpAccounts();
    await omp.view(ompOn, true);
    await expect(omp.prefer("openai-codex", 7, true)).rejects.toThrow(/can't set its preferences/);
  });

  it("leaves account policies to the user's own OMP config, but still applies the other settings", async () => {
    const omp = new OmpAccounts();
    await omp.view(ompOn, true);
    await omp.prefer("anthropic", 3, true);
    await fakeOmp({ "auth.accountPolicies": { value: [{ provider: "anthropic", account: { email: "x@example.com" } }] } });
    await omp.setSettings({ "retry.waitForUsageReset": true });
    const view = await omp.view(ompOn, true);
    expect(view?.policiesLocked).toBe(true);
    expect(await overlay()).toEqual({ retry: { waitForUsageReset: true } });
  });

  it("leaves out what it can't read in omp's output, and getState still sends a state the client accepts", async () => {
    await fakeOmp({}, {
      providers: [
        { id: "anthropic", name: "Anthropic", authenticated: true },
        { id: "openai-codex", name: { en: "ChatGPT" }, authenticated: true },
        "openrouter",
      ],
      lists: { anthropic: [work, personal, { provider: "anthropic", credentialId: "8", label: null, type: "oauth" }] },
      reports: [
        {
          provider: "anthropic",
          fetchedAt: 1_000,
          metadata: { accountId: "acct-work" },
          limits: [
            { id: "anthropic:5h", label: "5 Hour", amount: { usedFraction: 0.25 }, window: { resetsAt: 2_000 } },
            { id: "anthropic:7d", label: "7 Day", amount: { usedFraction: "most" } },
            { id: "anthropic:opus", label: "Opus", amount: { usedFraction: 0.5 }, window: { resetsAt: 1e20 } },
          ],
        },
        { provider: "anthropic", metadata: { accountId: 4 }, limits: [{ id: "x", label: "x", amount: { usedFraction: 0.9 } }] },
      ],
      resets: [...resets, { provider: "anthropic", credentialId: 9, availableCount: "two" }],
      history: [{ recordedAt: "yesterday" }],
      // OMP couldn't balance: no `success`.
      balance: { model: "anthropic/sonnet", error: "no accounts to balance" },
      noise: 'not json\n[1,2]\n{"type":5,"id":[]}\n',
      // 1e400 parses as Infinity, which the client's schema refuses.
      raw: { config: '{"retry.usageReservePct":{"value":1e400},"auth.accountPolicies":{"value":[]}}' },
    });
    const view = await new OmpAccounts().viewWithin(ompOn, true, 30_000);
    expect(view?.accounts.map((account) => `${account.provider}/${account.credentialId}`)).toEqual(["anthropic/3", "anthropic/4"]);
    expect(view?.accounts[0]?.windows).toEqual([
      { id: "anthropic:5h", label: "5 Hour", usedPercent: 25, resetsAt: new Date(2_000).toISOString() },
    ]);
    expect(view?.accounts[0]?.usageAt).toBe(new Date(1_000).toISOString());
    expect(view?.accounts[1]?.windows).toEqual([]);
    expect(view).toMatchObject({ error: null, preview: [], defaults: {}, policiesLocked: false });
    expect(view?.providers).toEqual([
      { id: "anthropic", name: "Anthropic" },
      { id: "openai-codex", name: "openai-codex" },
    ]);
    expect(StateViewSchema.safeParse({ ...claudeAndCodex, omp: view }).success).toBe(true);
  });

  it("says which of omp's answers it couldn't read, and still shows the rest", async () => {
    await fakeOmp({}, { raw: { usage: "Error: not json", resets: '{"accounts":"none"}' } });
    const view = await new OmpAccounts().viewWithin(ompOn, true, 30_000);
    expect(view?.accounts).toHaveLength(3);
    expect(view?.error).toContain("Usage: omp usage --json gave output ZeroSub can't read");
    expect(view?.error).toContain("Resets: omp usage reset --json gave output ZeroSub can't read");
    await fakeOmp({}, { providers: "none" });
    const unlisted = await new OmpAccounts().viewWithin(ompOn, true, 30_000);
    expect(unlisted).toMatchObject({ accounts: [], error: "Could not read OMP's accounts: omp get_login_providers gave output ZeroSub can't read" });
    expect(StateViewSchema.safeParse({ ...claudeAndCodex, omp: unlisted }).success).toBe(true);
  });

  it("never gives getState an OMP view the client would refuse, or an error", async () => {
    const omp = new OmpAccounts();
    const good = await omp.viewWithin(ompOn, true, 30_000);
    vi.spyOn(omp, "view").mockResolvedValueOnce({ ...good, fetchedAt: 42 } as unknown as OmpView);
    expect(await omp.viewWithin(ompOn, false)).toEqual(good);
    const fresh = new OmpAccounts();
    vi.spyOn(fresh, "view").mockRejectedValueOnce(new Error("boom"));
    const failed = await fresh.viewWithin(ompOn, false);
    expect(failed).toMatchObject({ accounts: [], error: "Could not read OMP's accounts: boom" });
    expect(StateViewSchema.safeParse({ ...claudeAndCodex, omp: failed }).success).toBe(true);
  });

  it("answers getState in time while omp is slow, with the last good view or one that only says so", async () => {
    await fakeOmp({}, { delay: { version: 1_500 } });
    const omp = new OmpAccounts();
    let started = Date.now();
    const first = await omp.viewWithin(ompOn, false, 100);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(first).toMatchObject({ accounts: [], fetchedAt: null, error: expect.stringMatching(/slow to answer/) });
    const good = await omp.viewWithin(ompOn, true, 30_000);
    expect(good?.accounts).toHaveLength(3);
    // The second getState waited for the first check that omp is there instead of starting another.
    expect((await calls()).filter((line) => line === "--version")).toHaveLength(1);
    await ompAnswers({}, { delay: { usage: 1_500 } });
    started = Date.now();
    expect(await omp.viewWithin(ompOn, true, 100)).toEqual(good);
    expect(Date.now() - started).toBeLessThan(1_000);
    // Lets the slow read finish before the next test.
    await ompAnswers();
    await omp.view(ompOn, true);
  });

  it("leaves account policies out of the overlay while it can't read OMP's config", async () => {
    // Saved before this daemon read OMP's config.
    await mkdir(join(root, "zerosub"), { recursive: true });
    await writeFile(
      join(root, "zerosub", "omp-controls.json"),
      JSON.stringify({ preferred: [{ provider: "anthropic", accountId: "acct-work", orgId: "org-work" }] }),
    );
    await ompAnswers({}, { fail: { config: "config is broken" } });
    const omp = new OmpAccounts();
    await omp.openSession({ agentId: "a", provider: "omp", env: {} } as unknown as PluginSessionOpenRequest);
    expect(await overlay()).toEqual({});
    const view = await omp.view(ompOn, true);
    expect(view).toMatchObject({ policiesLocked: true, error: "Settings: config is broken" });
    await omp.setReserve("anthropic", 4, 20);
    expect(await overlay()).toEqual({});

    await ompAnswers();
    expect((await omp.view(ompOn, true))?.policiesLocked).toBe(false);
    expect(await overlay()).toEqual({
      auth: {
        accountPolicies: [
          { provider: "anthropic", account: { accountId: "acct-personal" }, reservePct: 20 },
          { provider: "anthropic", account: { accountId: "acct-work", orgId: "org-work" }, priority: 100, reclaimAbovePct: 25 },
        ],
      },
    });
    // A later read that fails, gives something unreadable, or an accountPolicies entry it can't make
    // sense of, takes them out again instead of counting as unlocked.
    for (const answers of [{ fail: { config: "timed out" } }, { raw: { config: "[]" } }]) {
      await ompAnswers({}, answers);
      expect((await omp.view(ompOn, true))?.policiesLocked).toBe(true);
      expect(await overlay()).toEqual({});
      await ompAnswers();
      await omp.view(ompOn, true);
      expect(await overlay()).toHaveProperty("auth");
    }
    await ompAnswers({ "auth.accountPolicies": { value: "yes" } });
    expect((await omp.view(ompOn, true))?.policiesLocked).toBe(true);
    expect(await overlay()).toEqual({});
  });

  it("reads OMP again at most every 5 minutes for getState's polls, and whenever usage is refreshed", async () => {
    const omp = new OmpAccounts();
    const reads = async () => {
      const lines = await calls();
      return { usage: lines.filter((line) => line === "usage --json").length, invalidated: lines.filter((line) => line === "usage invalidate").length };
    };
    await omp.view(ompOn, true);
    expect(await reads()).toEqual({ usage: 1, invalidated: 1 });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 4 * 60_000);
      for (let poll = 0; poll < 3; poll++) await omp.view(ompOn, false);
      // Refreshing usage reads OMP now. Had a poll started a read, this would wait for it and read again.
      await omp.view(ompOn, true);
      expect(await reads()).toEqual({ usage: 2, invalidated: 2 });
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);
      await omp.view(ompOn, false);
      // Waits for the read that poll started (no invalidate), then reads again.
      await omp.view(ompOn, true);
      expect(await reads()).toEqual({ usage: 4, invalidated: 3 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps settings changed at the same time, and changes only the ones it's given", async () => {
    const omp = new OmpAccounts();
    await omp.view(ompOn, true);
    await Promise.all([
      omp.setSettings({ "retry.waitForUsageReset": true }),
      omp.setSettings({ "codexResets.keepCredits": 2 }),
      omp.setReserve("anthropic", 3, 20),
    ]);
    expect((await omp.view(ompOn, false))?.settings).toEqual({ "retry.waitForUsageReset": true, "codexResets.keepCredits": 2 });
    expect(await overlay()).toEqual({
      retry: { waitForUsageReset: true },
      codexResets: { keepCredits: 2 },
      auth: { accountPolicies: [{ provider: "anthropic", account: { accountId: "acct-work", orgId: "org-work" }, reservePct: 20 }] },
    });
    await omp.setSettings({ "retry.waitForUsageReset": null });
    expect((await omp.view(ompOn, false))?.settings).toEqual({ "codexResets.keepCredits": 2 });
    await expect(omp.setSettings({ "codexResets.keepCredits": "lots" })).rejects.toThrow(/doesn't take that value/);
    expect((await omp.view(ompOn, false))?.settings).toEqual({ "codexResets.keepCredits": 2 });
  });

  it("rewrites the overlay only when what it says changes", async () => {
    const omp = new OmpAccounts();
    await omp.view(ompOn, true);
    // The same overlay, written differently: a rewrite would replace the text.
    await writeFile(overlayPath(), "{ }");
    await omp.view(ompOn, true);
    await omp.openSession({ agentId: "a", provider: "omp", env: {} } as unknown as PluginSessionOpenRequest);
    expect(await readFile(overlayPath(), "utf8")).toBe("{ }");
    await omp.setSettings({ "retry.waitForUsageReset": false });
    expect(await overlay()).toEqual({ retry: { waitForUsageReset: false } });
  });
});
