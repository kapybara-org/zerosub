import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Reopener, findCli } from "./reopen";

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
