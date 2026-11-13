import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StateStore, salvageState, snapshotsToKeep } from "./state";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zerosub-state-"));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await chmod(join(dir, "state.json"), 0o600).catch(() => undefined);
  await rm(dir, { recursive: true, force: true, maxRetries: 5 });
});

const account = {
  id: "claude-main",
  family: "claude",
  label: "me",
  kind: "main",
  home: null,
  createdAt: "2026-09-01T00:00:00Z",
};

describe("salvageState", () => {
  it("keeps valid entries and drops only the broken ones", () => {
    const { state, dropped } = salvageState({
      accounts: [account, { id: "broken", family: "gemini" }],
      bindings: { a: { accountId: "claude-main", source: "thread", at: "x" }, b: { accountId: 7 } },
      sessions: {},
      defaults: { claude: "claude-main", codex: null },
    });
    expect(dropped).toBe(true);
    expect(state.accounts.map((entry) => entry.id)).toEqual(["claude-main"]);
    expect(Object.keys(state.bindings)).toEqual(["a"]);
    expect(state.defaults.claude).toBe("claude-main");
  });
});

describe("StateStore", () => {
  it("backs up a file it can't parse instead of silently discarding it", async () => {
    const path = join(dir, "state.json");
    await writeFile(path, "{ not json");
    const store = new StateStore(path);
    expect((await store.read()).accounts).toEqual([]);
    const backups = (await readdir(dir)).filter((name) => name.startsWith("state.json.bad-"));
    expect(backups).toHaveLength(1);
    expect(await readFile(join(dir, backups[0] ?? ""), "utf8")).toBe("{ not json");
  });

  it("never overwrites a file it couldn't read", async () => {
    if (process.getuid?.() === 0) return; // root can read anything
    const path = join(dir, "state.json");
    await writeFile(path, JSON.stringify({ accounts: [account] }));
    await chmod(path, 0o000);
    const store = new StateStore(path);
    await expect(store.update(() => undefined)).rejects.toThrow();
    await chmod(path, 0o600);
    expect(JSON.parse(await readFile(path, "utf8")).accounts).toHaveLength(1);
  });
});

describe("StateStore backups", () => {
  const path = () => join(dir, "state.json");
  const backups = () => join(dir, "backups");
  const snapshots = async () => (await readdir(backups()).catch(() => [] as string[])).filter((name) => name.startsWith("state-")).sort();
  const labelled = (label: string) => (store: StateStore) => store.update((draft) => Object.assign(draft, { accounts: [{ ...account, label }] }));

  it("snapshots every write, readable only by the owner", async () => {
    const store = new StateStore(path());
    await labelled("me")(store);
    const [name] = await snapshots();
    expect(name).toMatch(/^state-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/);
    expect((await stat(join(backups(), name ?? ""))).mode & 0o777).toBe(0o600);
    expect(await readFile(join(backups(), name ?? ""), "utf8")).toBe(await readFile(path(), "utf8"));
  });

  it.each([
    ["not valid JSON", "{ not json"],
    ["empty", ""],
    ["partly invalid", JSON.stringify({ accounts: [account, { id: "broken", family: "gemini" }] })],
    ["missing", null],
  ])("restores a file that is %s from the newest snapshot", async (problem, damage) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writer = new StateStore(path());
    await labelled("older")(writer);
    await labelled("newest")(writer);
    if (damage === null) await rm(path());
    else await writeFile(path(), damage);

    const state = await new StateStore(path()).read();
    expect(state.accounts.map((entry) => entry.label)).toEqual(["newest"]);
    expect(String(errors.mock.calls[0]?.[0])).toContain(`was ${problem}`);
    expect(String(errors.mock.calls[0]?.[0])).toContain("restored it from");
    // The restored registry is written back, and a damaged file kept as it was.
    expect(JSON.parse(await readFile(path(), "utf8")).accounts[0].label).toBe("newest");
    const kept = (await readdir(dir)).filter((name) => name.startsWith("state.json.bad-"));
    expect(kept).toHaveLength(damage === null ? 0 : 1);
    if (damage !== null) expect(await readFile(join(dir, kept[0] ?? ""), "utf8")).toBe(damage);
  });

  it("starts empty on a new install, without writing anything", async () => {
    expect((await new StateStore(path()).read()).accounts).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("keeps the file's valid records when the newest snapshot doesn't validate either (another version wrote it)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await mkdir(backups(), { recursive: true });
    const other = { id: "claude-other", family: "claude", label: "other", kind: "managed", home: "/x", createdAt: "2026-09-01T00:00:00Z" };
    await writeFile(join(backups(), "state-2026-10-01T00-00-00-000Z.json"), JSON.stringify({ accounts: [other] }));
    await writeFile(join(backups(), "state-2026-10-02T00-00-00-000Z.json"), JSON.stringify({ accounts: [account], defaults: { claude: 7 } }));
    await writeFile(path(), JSON.stringify({ accounts: [account, { ...other, kind: "future" }] }));

    const state = await new StateStore(path()).read();
    expect(state.accounts.map((entry) => entry.id)).toEqual(["claude-main"]);
  });

  it("keeps a bounded rotation: the latest writes, then the last of each hour and day", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.parse("2026-10-01T00:00:00.000Z");
    const store = new StateStore(path());
    const written: string[] = [];
    for (let index = 0; index < 120; index += 1) {
      const at = new Date(start + index * 83 * 60_000); // about seven days
      vi.setSystemTime(at);
      written.push(`state-${at.toISOString().replace(/[:.]/g, "-")}.json`);
      await labelled(`write ${index}`)(store);
    }
    const kept = await snapshots();
    expect(kept).toEqual([...snapshotsToKeep(written)].sort());
    expect(kept.length).toBeLessThanOrEqual(5 + 12 + 7);
    expect(kept.at(-1)).toBe(written.at(-1));
    expect(kept[0]?.slice(0, 16)).toBe("state-2026-10-01"); // the oldest day is still there
  }, 30_000);
});

describe("snapshotsToKeep", () => {
  it("keeps the last five writes, then the last of each hour and day", () => {
    const names = [
      "2026-10-03T10-50", "2026-10-03T10-40", "2026-10-03T10-30", "2026-10-03T10-20", "2026-10-03T10-10",
      "2026-10-03T10-00", "2026-10-03T09-50", "2026-10-03T08-00", "2026-10-02T23-00", "2026-10-02T05-00", "2026-10-01T12-00",
    ].map((at) => `state-${at}-00-000Z.json`);
    const keep = snapshotsToKeep(names);
    // Only the sixth write of the 10:00 hour goes: it's neither recent nor the last of its hour or day.
    expect(names.filter((name) => !keep.has(name))).toEqual(["state-2026-10-03T10-00-00-000Z.json"]);
  });

  it("never keeps more than the tiers add up to", () => {
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    const names = Array.from({ length: 2_000 }, (_, index) => `state-${new Date(start + index * 10 * 60_000).toISOString().replace(/[:.]/g, "-")}.json`);
    expect(snapshotsToKeep(names).size).toBeLessThanOrEqual(5 + 12 + 7);
  });
});
