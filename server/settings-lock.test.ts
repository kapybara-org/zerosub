import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Holds the next read of `path` until `release` is called, so a sync can be caught halfway. */
const gate = vi.hoisted((): { path: string | null; reached: () => void; release: () => void } => ({ path: null, reached: () => {}, release: () => {} }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    if (gate.path !== null && String(args[0]) === gate.path) {
      gate.path = null;
      gate.reached();
      await new Promise<void>((resolve) => (gate.release = resolve));
    }
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

const { prepareClaudeHome, writeAccountProxy } = await import("./homes");

let root: string;
const previous = process.env.CLAUDE_CONFIG_DIR;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zerosub-lock-")));
});

afterEach(async () => {
  if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previous;
  // Retried: a write the test set off in the background can still be landing in it.
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

describe("a proxy set while the home is being synced", () => {
  it("isn't undone by the sync writing back what it read before", async () => {
    const main = join(root, "main");
    const home = join(root, "homes", "claude-race");
    process.env.CLAUDE_CONFIG_DIR = main;
    await mkdir(main, { recursive: true });
    await writeFile(join(main, "settings.json"), "{}");
    await prepareClaudeHome(home, true);

    // The upkeep's sync has read the account's overrides and is reading main's settings.
    const reached = new Promise<void>((resolve) => (gate.reached = resolve));
    gate.path = join(main, "settings.json");
    const sync = prepareClaudeHome(home, true);
    await reached;
    const edit = writeAccountProxy(home, "http://127.0.0.1:7890");
    await new Promise((resolve) => setTimeout(resolve, 100));
    gate.release();
    await Promise.all([sync, edit]);

    const settings = JSON.parse(await readFile(join(home, "settings.json"), "utf8"));
    expect(settings.env?.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  });
});
