import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnEnv } from "./adapter";
import { accountProxy, claudeEgress } from "./claude";
import { parseTrace } from "./processes";
import { FamilyResolver } from "./families";
import { writeAccountProxy } from "./homes";
import { providerEnv, rememberProviderEnvs } from "./provider-env";

const USAGE = "https://api.anthropic.com/api/oauth/usage";
const VARIABLES = ["CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "ANTHROPIC_BASE_URL"];
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-provider-env-")));
  saved = Object.fromEntries(VARIABLES.map((key) => [key, process.env[key]]));
  for (const key of VARIABLES) delete process.env[key];
  process.env.CLAUDE_CONFIG_DIR = join(root, "main");
  await mkdir(join(root, "main"), { recursive: true });
});

afterEach(async () => {
  rememberProviderEnvs({}, undefined);
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Retried: a write the test set off in the background can still be landing in it.
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** The daemon config's `providers`, as a plugin reads it. */
function paseoWith(providers: Record<string, unknown> | Error) {
  return {
    config: {
      get: async () => {
        if (providers instanceof Error) throw providers;
        return { config: { providers } };
      },
    },
  } as unknown as Parameters<FamilyResolver["resolve"]>[0];
}

describe("a provider's env from Paseo's config", () => {
  it("is read with the providers, except for one that brings its own credentials, and kept when the config can't be read", async () => {
    await new FamilyResolver().resolve(
      paseoWith({ claude: { env: { HTTPS_PROXY: "http://provider:1", NODE_EXTRA_CA_CERTS: "/ca.pem" } }, codex: { env: { OPENAI_API_KEY: "sk-own" } } }),
    );
    expect(providerEnv("claude")).toEqual({ HTTPS_PROXY: "http://provider:1", NODE_EXTRA_CA_CERTS: "/ca.pem" });
    expect(providerEnv("codex")).toEqual({});

    await new FamilyResolver().resolve(paseoWith(new Error("not now")));
    expect(providerEnv("claude")).toEqual({ HTTPS_PROXY: "http://provider:1", NODE_EXTRA_CA_CERTS: "/ca.pem" });
  });

  it("goes under what ZeroSub sets for the CLI processes it starts, as Paseo layers it for a session", () => {
    process.env.HTTPS_PROXY = "http://daemon:1";
    process.env.CLAUDE_CONFIG_DIR = "/daemon";
    rememberProviderEnvs({ claude: "claude" }, { claude: { env: { HTTPS_PROXY: "http://provider:2", EXTRA: "1" } } });
    const managed = spawnEnv({ CLAUDE_CONFIG_DIR: "/home", ANTHROPIC_API_KEY: "" }, "claude");
    expect(managed).toMatchObject({ HTTPS_PROXY: "http://provider:2", EXTRA: "1", CLAUDE_CONFIG_DIR: "/home", ANTHROPIC_API_KEY: "" });
    expect(spawnEnv({ CLAUDE_CONFIG_DIR: null }, "claude").CLAUDE_CONFIG_DIR).toBe("/daemon");
    expect(spawnEnv({}, "codex").HTTPS_PROXY).toBe("http://daemon:1");
  });

  it("decides the proxy for ZeroSub's own calls under the account's settings, and its no-proxy list too", async () => {
    const home = join(root, "homes", "claude-a");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.json"), "{}");
    rememberProviderEnvs({ claude: "claude" }, { claude: { env: { HTTPS_PROXY: "http://provider:2" } } });
    expect(await accountProxy(home, USAGE)).toBe("http://provider:2");

    await writeFile(join(home, "settings.json"), JSON.stringify({ env: { https_proxy: "http://account:3" } }));
    expect(await accountProxy(home, USAGE)).toBe("http://account:3");

    // Claude Code goes direct here, so the usage read does too.
    rememberProviderEnvs({ claude: "claude" }, { claude: { env: { HTTPS_PROXY: "http://provider:2", NO_PROXY: "localhost,.anthropic.com" } } });
    expect(await accountProxy(home, USAGE)).toBeNull();
  });

  it("has its no-proxy list pinned without Claude's domains for an account with a proxy of its own", async () => {
    const home = join(root, "homes", "claude-b");
    rememberProviderEnvs({ claude: "claude" }, { claude: { env: { HTTPS_PROXY: "http://provider:2", NO_PROXY: "corp.example,.anthropic.com" } } });
    await writeAccountProxy(home, "http://127.0.0.1:7890");
    const env = JSON.parse(await readFile(join(home, "settings.json"), "utf8")).env;
    expect(env).toMatchObject({ HTTPS_PROXY: "http://127.0.0.1:7890", NO_PROXY: "localhost,127.0.0.1,::1,downloads.claude.ai,corp.example", no_proxy: "localhost,127.0.0.1,::1,downloads.claude.ai,corp.example" });
    expect(await accountProxy(home, USAGE)).toBe("http://127.0.0.1:7890");
  });
});

describe("the address Anthropic sees an account's requests come from", () => {
  let proxy: Server | null = null;
  afterEach(async () => {
    await new Promise((resolve) => (proxy ? proxy.close(resolve) : resolve(undefined)));
    proxy = null;
  });

  it("is asked of Anthropic's own host through the account's proxy, the way its Claude Code goes", async () => {
    const seen: string[] = [];
    proxy = createServer();
    // Refusing the tunnel keeps the test off the network; what it was asked for is what counts.
    proxy.on("connect", (req, socket) => void (seen.push(req.url ?? ""), socket.end("HTTP/1.1 407 Nope\r\n\r\n")));
    const port = await new Promise<number>((resolve) => proxy!.listen(0, "127.0.0.1", () => resolve((proxy!.address() as AddressInfo).port)));
    const home = join(root, "homes", "claude-c");
    await writeAccountProxy(home, `http://127.0.0.1:${port}`);
    await expect(claudeEgress(home)).rejects.toThrow("HTTP 407");
    expect(seen).toEqual(["api.anthropic.com:443"]);
  });

  it("isn't asked for an account whose requests go to another base URL: that reaches Anthropic from its own address", async () => {
    const home = join(root, "homes", "claude-d");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://relay.example/v1", HTTPS_PROXY: "http://127.0.0.1:1" } }));
    expect(await claudeEgress(home)).toBeNull();
  });

  it("is read from the edge's trace", () => {
    expect(parseTrace("fl=12f34\nh=api.anthropic.com\nip=203.0.113.7\nts=1793190000.123\nloc=US\ncolo=LAX\n")).toEqual({ ip: "203.0.113.7", country: "US" });
    expect(parseTrace("ip=2001:db8::1\n")).toEqual({ ip: "2001:db8::1", country: null });
    expect(parseTrace("<html>blocked</html>")).toBeNull();
  });
});
