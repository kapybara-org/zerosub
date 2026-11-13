import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Reopener, findCli, hostCanReload, hostReload } from "./reopen";

const executable = process.platform === "win32" ? "paseo.cmd" : "paseo";

describe("finding the paseo CLI", () => {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let root: string | null = null;

  afterEach(() => {
    Object.assign(process.env, saved);
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    root = null;
  });

  // The Windows desktop app keeps `resources/` beside Paseo.exe, not above it.
  it("finds the CLI in the resources folder beside the app executable", async () => {
    root = mkdtempSync(join(tmpdir(), "zerosub-reopen-"));
    const app = join(root, "Paseo");
    mkdirSync(join(app, "resources", "bin"), { recursive: true });
    writeFileSync(join(app, "Paseo.exe"), "");
    writeFileSync(join(app, "resources", "bin", executable), "", { mode: 0o755 });
    process.env.PATH = "";
    process.env.HOME = root;
    process.env.USERPROFILE = root;

    expect(await findCli(join(app, "Paseo.exe"))).toBe(join(app, "resources", "bin", executable));
  });
});

describe("reopening through the host", () => {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let root: string | null = null;

  afterEach(() => {
    Object.assign(process.env, saved);
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  /** No paseo CLI anywhere it's looked for, so a CLI reload can't happen and the real one never runs. */
  function withoutCli(): void {
    root = mkdtempSync(join(tmpdir(), "zerosub-reopen-"));
    process.env.PATH = "";
    process.env.HOME = root;
    process.env.USERPROFILE = root;
  }

  it("uses the host's reload when it has one, without looking for the CLI", async () => {
    withoutCli();
    const reloaded: string[] = [];
    const host = { agents: { ref: (id: string) => ({ id, reload: async function (this: { id: string }) { reloaded.push(this.id); } }) } };
    expect(await new Reopener().reopen("a", host)).toEqual({ ok: true });
    expect(reloaded).toEqual(["a"]);
  });

  it("reports the host's error, and says when it gave up waiting", async () => {
    const failing = (message: string) => ({ agents: { ref: () => ({ reload: async () => Promise.reject(new Error(message)) }) } });
    expect(await new Reopener().reopen("a", failing("Agent a is not loaded"))).toEqual({ ok: false, error: "Agent a is not loaded", timedOut: false });
    expect(await new Reopener().reopen("a", failing("Timeout waiting for message (60000ms)"))).toMatchObject({ ok: false, timedOut: true });
    // The daemon timing out on its own work is an answer: it failed the reload without reopening the session.
    const refused = "Timed out closing previous session during refresh requestType=refresh_agent_request code=agent_refresh_failed";
    expect(await new Reopener().reopen("a", failing(refused))).toEqual({ ok: false, error: refused, timedOut: false });
  });

  it("falls back to the CLI on a host without its own reload", async () => {
    withoutCli();
    const result = await new Reopener().reopen("a", { agents: { ref: () => ({ refresh: async () => null }) } });
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/command-line tool was not found/) });
  });

  it("tells a host that can reload from one that can't", () => {
    expect(hostCanReload({ agents: { ref: () => ({ reload: async () => null }) } })).toBe(true);
    expect(hostCanReload({ agents: { ref: () => ({}) } })).toBe(false);
    expect(hostCanReload({ agents: { ref: () => { throw new Error("bad id"); } } })).toBe(false);
    expect(hostCanReload(null)).toBe(false);
    expect(hostReload(undefined, "a")).toBeNull();
  });
});

describe.skipIf(process.platform === "win32")("reading how a reload ended", () => {
  const saved = { PATH: process.env.PATH, PASEO_HOME: process.env.PASEO_HOME };
  let root: string | null = null;

  afterEach(() => {
    Object.assign(process.env, saved);
    if (root) rmSync(root, { recursive: true, force: true });
    root = null;
  });

  /** A Reopener whose CLI is a script printing `stderr` and exiting 1; never the real CLI. */
  async function failingCli(stderr: string): Promise<Reopener> {
    root = mkdtempSync(join(tmpdir(), "zerosub-reopen-"));
    mkdirSync(join(root, "bin"));
    const script = join(root, "bin", "paseo");
    writeFileSync(script, `#!/bin/sh\necho '${stderr}' >&2\nexit 1\n`, { mode: 0o755 });
    process.env.PATH = join(root, "bin");
    process.env.PASEO_HOME = root;
    const reopener = new Reopener();
    expect(await reopener.locate()).toBe(script);
    return reopener;
  }

  it("takes the CLI giving up on the daemon's answer for a reload that may still finish", async () => {
    const reopener = await failingCli("Failed to reload agent: Timeout waiting for message (60000ms)");
    expect(await reopener.reopen("agent-1")).toEqual({
      ok: false,
      error: "Failed to reload agent: Timeout waiting for message (60000ms)",
      timedOut: true,
    });
  });

  it("takes any other failure for a reload that didn't happen", async () => {
    const reopener = await failingCli("Failed to reload agent: Agent not found");
    expect(await reopener.reopen("agent-1")).toEqual({ ok: false, error: "Failed to reload agent: Agent not found", timedOut: false });
  });
});
