import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { OmpAccounts } from "./omp";

type PaseoApi = Parameters<OmpAccounts["view"]>[0];

/**
 * Stands in for the `omp` CLI: logs every call and answers from `omp.json`, including the few rpc
 * commands ZeroSub sends over stdin.
 */
const FAKE_OMP = `
const fs = require("node:fs");
const path = require("node:path");
const dir = process.env.FAKE_OMP_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(dir, "calls.log"), args.join(" ") + "\\n");
const data = JSON.parse(fs.readFileSync(path.join(dir, "omp.json"), "utf8"));
const print = (value) => process.stdout.write(JSON.stringify(value));
if (args[0] === "--mode") {
  require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
    const command = JSON.parse(line);
    const reply = (payload) => process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: payload }) + "\\n");
    if (command.type === "get_login_providers") reply({ providers: data.providers });
    else if (command.type === "get_logout_accounts") reply({ accounts: data.lists[command.providerId] ?? [] });
    else reply({});
  });
} else if (args[0] === "--version") process.stdout.write("omp/0.0.0");
else if (args[0] === "config") print(data.config);
else if (args[0] === "usage" && args[1] === "reset") print({ accounts: data.resets });
else if (args[0] === "usage" && args.includes("--history")) print({ entries: [] });
else if (args[0] === "usage") print({ reports: [] });
else if (args[0] === "dry-balance") print({ model: args[1], success: { accounts: [] } });
else print({});
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

async function fakeOmp(config: Record<string, { value: unknown }> = {}): Promise<void> {
  await rm(join(root, "calls.log"), { force: true });
  await rm(join(root, "zerosub"), { recursive: true, force: true });
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
    }),
  );
}

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
});
