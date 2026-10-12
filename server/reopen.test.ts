import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findCli } from "./reopen";

const executable = process.platform === "win32" ? "paseo.cmd" : "paseo";

describe("finding the paseo CLI", () => {
  const saved = { PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  let root: string | null = null;

  afterEach(() => {
    Object.assign(process.env, saved);
    if (root) rmSync(root, { recursive: true, force: true });
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
