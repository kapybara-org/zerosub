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
      defaults: { claude: "claude-main", codex: null, pi: null },
    });
    expect(dropped).toBe(true);
    expect(state.accounts.map((entry) => entry.id)).toEqual(["claude-main"]);
    expect(Object.keys(state.bindings)).toEqual(["a"]);
    expect(state.defaults.claude).toBe("claude-main");
  });

  it("keeps valid OpenCode fork records when an unrelated record is malformed", () => {
    const record = {
      forkAgentId: "fork-1",
      seen: { epoch: "epoch-1", seq: 3 },
      pending: { stage: "sending", targetId: "fork-1", messageId: "zerosub-handoff-m1", seen: { epoch: "epoch-1", seq: 3 }, sentDigest: "abc" },
    };
    const { state, dropped } = salvageState({
      accounts: [account],
      defaults: { claude: "claude-main", codex: null },
      opencodeForks: { good: record, bad: { forkAgentId: 7 } },
    });
    expect(state.opencodeForks).toEqual({ good: record });
    expect(dropped).toBe(true);
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

  const MARK = { epoch: "epoch-1", seq: 3 };
  const reservation = (stage: "creating" | "sending") => ({
    forkAgentId: "fork-1",
    seen: MARK,
    pending: {
      stage,
      targetId: "fork-1",
      messageId: "zerosub-handoff-m2",
      seen: { epoch: "epoch-1", seq: 9 },
      ...(stage === "creating"
        ? { config: { provider: "opencode/glm", modeId: "build", workspaceId: "ws", cwd: null, parentId: null, title: "Fix the build (continued on OpenCode)", why: "the work was moved to OpenCode" } }
        : {}),
      sentDigest: "digest-m2",
    },
  });

  it.each(["creating", "sending"] as const)(
    "keeps the file's current %s reservation over a lagging snapshot when an unrelated record is broken",
    async (stage) => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const writer = new StateStore(path());
      await writer.update((draft) => Object.assign(draft, { accounts: [{ ...account, label: "older" }], opencodeForks: { "agent-1": { forkAgentId: "fork-1", seen: MARK } } }));
      // The registry is written before its snapshot, and a failed snapshot is tolerated: the file is newer.
      await writeFile(path(), JSON.stringify({ accounts: [account, { id: "broken", family: "gemini" }], opencodeForks: { "agent-1": reservation(stage) } }));

      const state = await new StateStore(path()).read();
      expect(state.accounts.map((entry) => entry.label)).toEqual(["older"]);
      expect(state.opencodeForks).toEqual({ "agent-1": reservation(stage) });
      expect(JSON.parse(await readFile(path(), "utf8")).opencodeForks["agent-1"].pending.messageId).toBe("zerosub-handoff-m2");
    },
  );

  it.each([
    ["not valid JSON", "{ not json"],
    ["partly invalid in that record", JSON.stringify({ accounts: [account], opencodeForks: { "agent-1": { forkAgentId: "fork-1", pending: { stage: "bogus" } } } })],
  ])("drops OpenCode fork records it can't trust when the file is %s, instead of restoring the snapshot's", async (_, damage) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writer = new StateStore(path());
    await writer.update((draft) => Object.assign(draft, { accounts: [account], opencodeForks: { "agent-1": reservation("sending") } }));
    await writeFile(path(), damage);

    const state = await new StateStore(path()).read();
    expect(state.accounts.map((entry) => entry.id)).toEqual(["claude-main"]);
    expect(state.opencodeForks).toEqual({});
  });

  it("holds every OpenCode source when the registry can't be read at all", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writer = new StateStore(path());
    await writer.update((draft) => Object.assign(draft, { accounts: [account], opencodeForks: { "agent-1": reservation("sending") } }));
    await writeFile(path(), "{ not json");

    const state = await new StateStore(path()).read();
    expect(state.opencodeForks).toEqual({});
    expect(Object.keys(state.opencodeHolds)).toEqual(["*"]);
    // The hold is written back, so a second restart still knows authority was lost.
    expect(Object.keys((await new StateStore(path()).read()).opencodeHolds)).toEqual(["*"]);
  });

  it("holds only the source whose record didn't validate, keeping the others", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writer = new StateStore(path());
    await writer.update((draft) => Object.assign(draft, { accounts: [account] }));
    await writeFile(path(), JSON.stringify({ accounts: [account], opencodeForks: { "agent-1": { forkAgentId: 7 }, "agent-2": reservation("sending") } }));

    const state = await new StateStore(path()).read();
    expect(state.opencodeForks).toEqual({ "agent-2": reservation("sending") });
    expect(Object.keys(state.opencodeHolds)).toEqual(["agent-1"]);
  });

  it.each([
    ["a source's hold doesn't validate", { "agent-1": { at: 7 } }, ["agent-1"]],
    ["the holds themselves are unreadable", "holds", ["*"]],
  ])("keeps holding when %s", async (_, holds, expected) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writer = new StateStore(path());
    await writer.update((draft) => Object.assign(draft, { accounts: [account] }));
    await writeFile(path(), JSON.stringify({ accounts: [account], opencodeHolds: holds }));
    const state = await new StateStore(path()).read();
    expect(Object.keys(state.opencodeHolds)).toEqual(expected);
    expect(Object.values(state.opencodeHolds).every((hold) => !hold.told)).toBe(true);
  });

  it("resets an earlier acknowledgement when the source's record is lost again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writer = new StateStore(path());
    await writer.update((draft) => Object.assign(draft, { accounts: [account] }));
    await writeFile(path(), JSON.stringify({ accounts: [account], opencodeForks: { "agent-1": { forkAgentId: 7 } }, opencodeHolds: { "agent-1": { at: "2026-01-01", told: true } } }));
    expect((await new StateStore(path()).read()).opencodeHolds["agent-1"]?.told).toBeUndefined();
  });

  it("holds nothing when the fork records are intact", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const writer = new StateStore(path());
    await writer.update((draft) => Object.assign(draft, { accounts: [account] }));
    await writeFile(path(), JSON.stringify({ accounts: [account, { id: "broken", family: "gemini" }], opencodeForks: { "agent-2": reservation("sending") } }));
    expect((await new StateStore(path()).read()).opencodeHolds).toEqual({});
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
