import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcherDir, launcherNames, paseoHomeTag, renderLauncher, writeLaunchers } from "./launchers";

const exec = promisify(execFile);
let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-launchers-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = join(root, "zero sub"); // ZeroSub's own homes are in here
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  // Retried: a write the test set off in the background can still be landing in it.
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A home ZeroSub made, which it deletes along with its account. */
const own = (name: string) => join(root, "zero sub", "zerosub", "homes", name);

describe("launcherDir", () => {
  it("is ~/.claude-config unless ZEROSUB_LAUNCHER_DIR says otherwise", () => {
    const previous = process.env.ZEROSUB_LAUNCHER_DIR;
    try {
      delete process.env.ZEROSUB_LAUNCHER_DIR;
      expect(launcherDir()).toBe(join(homedir(), ".claude-config"));
      process.env.ZEROSUB_LAUNCHER_DIR = "/tmp/scripts/";
      expect(launcherDir()).toBe("/tmp/scripts");
    } finally {
      if (previous === undefined) delete process.env.ZEROSUB_LAUNCHER_DIR;
      else process.env.ZEROSUB_LAUNCHER_DIR = previous;
    }
  });
});

describe("launcherNames", () => {
  it("names each account after its label and keeps names unique", () => {
    const names = launcherNames([
      { id: "claude-aaaaaa111", label: "Work", home: "/h/1" },
      { id: "claude-bbbbbb222", label: "work", home: "/h/2" },
      { id: "claude-cccccc333", label: "Ünïcode & Spaces!", home: "/h/3" },
      { id: "claude-dddddd444", label: "工作", home: "/h/4" },
      { id: "claude-eeeeee555", label: "work@example.com", home: "/h/5" },
    ]);
    expect([...names.values()]).toEqual(["claude-work.sh", "claude-work-bbbbbb.sh", "claude-unicode-spaces.sh", "claude-dddddd.sh", "claude-work-example-com.sh"]);
  });
});

/** Runs `call` in `shell` with the scripts on PATH and a fake `claude` that reports what it got. */
async function launch(shell: "sh" | "bash" | "zsh", directory: string, call: string, env: Record<string, string> = {}) {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await writeFile(
    join(bin, "claude"),
    '#!/bin/sh\nprintf "dir=%s\\nsecure=%s\\ntoken=%s\\nkey=%s\\n" "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR" "${CLAUDE_CODE_OAUTH_TOKEN-unset}" "${ANTHROPIC_API_KEY-unset}"\nfor a in "$@"; do printf "arg=%s\\n" "$a"; done\n',
  );
  await chmod(join(bin, "claude"), 0o755);
  const program = `${call}; printf "after=%s\\n" "\${CLAUDE_CONFIG_DIR-unset}"`;
  const { stdout } = await exec(shell, ["-c", program], {
    env: { PATH: `${directory}:${bin}:/usr/bin:/bin`, HOME: root, CLAUDE_CODE_OAUTH_TOKEN: "leak", ANTHROPIC_API_KEY: "leak", ...env },
  });
  return stdout;
}

describe("generated scripts", () => {
  const home = () => own("claude-it's");
  const work = () => ({ id: "claude-abc123", label: "Work", home: home() });
  const personal = () => ({ id: "claude-def456", label: "Personal", home: own("claude-def456") });

  it("writes one executable script per account, quoted safely, only rewritten when it changes", async () => {
    const directory = join(root, "launchers");
    expect(renderLauncher({ ...work(), home: "/tmp/zero sub/homes/claude-it's" })).toContain(`export CLAUDE_CONFIG_DIR='/tmp/zero sub/homes/claude-it'\\''s'`);
    await writeLaunchers([work(), personal()], directory);
    expect((await readdir(directory)).sort()).toEqual(["claude-personal.sh", "claude-work.sh"]);
    const path = join(directory, "claude-work.sh");
    expect((await stat(path)).mode & 0o111).not.toBe(0);
    const before = await stat(path);
    await writeLaunchers([work(), personal()], directory);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it("removes its scripts for accounts in homes/ that are gone or renamed, and nothing else", async () => {
    const directory = join(root, "launchers");
    await writeLaunchers([work(), personal()], directory);
    await writeFile(join(directory, "claude-mine"), "#!/bin/sh\necho mine\n");
    await writeLaunchers([{ ...work(), label: "Office" }], directory);
    expect((await readdir(directory)).sort()).toEqual(["claude-mine", "claude-office.sh"]);
    await writeLaunchers([], directory);
    expect(await readdir(directory)).toEqual(["claude-mine"]);
    expect(await readFile(join(directory, "claude-mine"), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });

  it("keeps the script of an account the registry lost while its home is there, and deletes it once the home is up for cleanup", async () => {
    const directory = join(root, "launchers");
    await mkdir(personal().home, { recursive: true });
    await writeLaunchers([work(), personal()], directory);
    const path = join(directory, "claude-personal.sh");
    // A damaged registry lost the account; nobody removed it, so its home isn't up for cleanup.
    await writeLaunchers([work()], directory);
    expect((await readFile(path, "utf8")).split("\n")[1]).toMatch(/^# No longer managed by ZeroSub/);
    // The account comes back (from a backup, say) and takes its script back.
    await writeLaunchers([work(), personal()], directory);
    expect(await readFile(path, "utf8")).toBe(renderLauncher(personal()));
    // Removed: its home is listed for cleanup, so the script goes now.
    await writeLaunchers([work()], directory, [personal().home]);
    expect(await readdir(directory)).toEqual(["claude-work.sh"]);
  });

  it("leaves a copy of one of its scripts under another name to the user", async () => {
    const directory = join(root, "launchers");
    await writeLaunchers([work()], directory);
    const copy = (await readFile(join(directory, "claude-work.sh"), "utf8")).replace('exec claude "$@"', 'exec claude --verbose "$@"');
    await writeFile(join(directory, "claude-work-yolo.sh"), copy);
    await writeLaunchers([work()], directory);
    await writeLaunchers([{ ...work(), label: "Office" }], directory);
    expect((await readdir(directory)).sort()).toEqual(["claude-office.sh", "claude-work-yolo.sh"]);
    const kept = (await readFile(join(directory, "claude-work-yolo.sh"), "utf8")).split("\n");
    expect(kept[1]).toMatch(/^# No longer managed by ZeroSub/);
    expect(kept.filter((_, index) => index !== 1)).toEqual(copy.split("\n").filter((_, index) => index !== 1));
  });

  it("replaces the scripts it wrote before they were named .sh", async () => {
    const directory = join(root, "launchers");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "claude-work"), renderLauncher(work()));
    await writeLaunchers([work()], directory);
    expect(await readdir(directory)).toEqual(["claude-work.sh"]);
  });

  it("doesn't create the directory while there's nothing to put in it", async () => {
    const directory = join(root, "launchers");
    await writeLaunchers([], directory);
    await expect(stat(directory)).rejects.toThrow();
  });

  for (const shell of ["sh", "bash", "zsh"] as const) {
    it.skipIf(process.platform === "win32")(`starts the CLI on the account from ${shell}, leaving the caller's shell alone`, async () => {
      const directory = join(root, "launchers");
      await writeLaunchers([work()], directory);
      const out = await launch(shell, directory, `claude-work.sh -p "two words" --flag`, { CLAUDE_CONFIG_DIR: "/caller" });
      expect(out).toBe(
        [`dir=${home()}`, `secure=${home()}`, "token=unset", "key=unset", "arg=-p", "arg=two words", "arg=--flag", "after=/caller", ""].join("\n"),
      );
    });
  }
});

describe("scripts for homes outside homes/", () => {
  /** Moved out by hand; ZeroSub must never delete what starts it. */
  const external = () => join(root, "claude-config", "claude-mine");
  const mine = () => ({ id: "claude-mine01", label: "Mine", home: external() });

  it("are kept, working, when their account goes, and become the user's", async () => {
    const directory = join(root, "launchers");
    await writeLaunchers([mine()], directory);
    const path = join(directory, "claude-mine.sh");
    const generated = await readFile(path, "utf8");

    await writeLaunchers([], directory);
    const kept = await readFile(path, "utf8");
    expect(kept.split("\n")[1]).toMatch(/^# No longer managed by ZeroSub/);
    // Only the marker line changed, so it starts the same account as before.
    expect(kept.split("\n").filter((_, index) => index !== 1)).toEqual(generated.split("\n").filter((_, index) => index !== 1));
    expect((await stat(path)).mode & 0o111).not.toBe(0);
    const out = await launch("sh", directory, "claude-mine.sh auth status");
    expect(out).toContain(`dir=${external()}\nsecure=${external()}\n`);

    // Later passes leave it alone.
    const before = await stat(path);
    await writeLaunchers([], directory);
    expect(await readFile(path, "utf8")).toBe(kept);
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  it("are kept under their old name when the account is renamed", async () => {
    const directory = join(root, "launchers");
    await writeLaunchers([mine()], directory);
    await writeLaunchers([{ ...mine(), label: "Office" }], directory);
    expect((await readdir(directory)).sort()).toEqual(["claude-mine.sh", "claude-office.sh"]);
    expect((await readFile(join(directory, "claude-mine.sh"), "utf8")).split("\n")[1]).toMatch(/^# No longer managed by ZeroSub/);
  });

  it("aren't taken over by another account with the same name, but are by the same home added back", async () => {
    const directory = join(root, "launchers");
    await writeLaunchers([mine()], directory);
    await writeLaunchers([], directory);
    const kept = await readFile(join(directory, "claude-mine.sh"), "utf8");

    const other = { id: "claude-other01", label: "Mine", home: own("claude-other01") };
    const names = await writeLaunchers([other], directory);
    expect(names.get(other.id)).toBe("claude-mine-other0.sh");
    expect(await readFile(join(directory, "claude-mine.sh"), "utf8")).toBe(kept);

    // Registered again by hand: its script is ZeroSub's to manage again.
    await writeLaunchers([other, mine()], directory);
    expect(await readFile(join(directory, "claude-mine.sh"), "utf8")).toBe(renderLauncher(mine()));
  });

  it("aren't taken back by their account once changed: it gets another name", async () => {
    const directory = join(root, "launchers");
    await writeLaunchers([mine()], directory);
    await writeLaunchers([], directory);
    const path = join(directory, "claude-mine.sh");
    const changed = (await readFile(path, "utf8")).replace('exec claude "$@"', 'exec claude --verbose "$@"');
    await writeFile(path, changed);
    expect((await writeLaunchers([mine()], directory)).get(mine().id)).toBe("claude-mine-mine01.sh");
    expect(await readFile(path, "utf8")).toBe(changed);
  });

  it("never overwrite a script written by hand", async () => {
    const directory = join(root, "launchers");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "claude-work.sh"), "#!/bin/sh\necho mine\n");
    const work = { id: "claude-abc123", label: "Work", home: own("claude-abc123") };
    expect((await writeLaunchers([work], directory)).get(work.id)).toBe("claude-work-abc123.sh");
    expect(await readFile(join(directory, "claude-work.sh"), "utf8")).toBe("#!/bin/sh\necho mine\n");
  });
});

describe("what isn't a plain script of ZeroSub's", () => {
  const work = () => ({ id: "claude-abc123", label: "Work", home: own("claude-abc123") });

  it("is never replaced or removed: a symlink of the same name, or one pointing at a script", async () => {
    const directory = join(root, "launchers");
    const elsewhere = join(root, "bin", "my-claude.sh");
    await mkdir(join(root, "bin"), { recursive: true });
    await mkdir(directory, { recursive: true });
    await writeFile(elsewhere, "#!/bin/sh\necho mine\n");
    await symlink(elsewhere, join(directory, "claude-work.sh"));
    expect((await writeLaunchers([work()], directory)).get(work().id)).toBe("claude-work-abc123.sh");
    expect((await lstat(join(directory, "claude-work.sh"))).isSymbolicLink()).toBe(true);
    expect(await readFile(elsewhere, "utf8")).toBe("#!/bin/sh\necho mine\n");

    // An alias the user made for one of ZeroSub's own scripts outlives the account.
    await symlink(join(directory, "claude-work-abc123.sh"), join(directory, "cw.sh"));
    await writeLaunchers([], directory);
    expect(await readlink(join(directory, "cw.sh"))).toBe(join(directory, "claude-work-abc123.sh"));
    expect((await readdir(directory)).sort()).toEqual(["claude-work.sh", "cw.sh"]);
  });

  it("is never taken over, even when it starts the account's own home", async () => {
    const directory = join(root, "launchers");
    await mkdir(directory, { recursive: true });
    const handmade = renderLauncher(work()).replace(/^# Generated by ZeroSub.*$/m, "# My own copy").replace('exec claude "$@"', 'exec claude --verbose "$@"');
    await writeFile(join(directory, "claude-work.sh"), handmade);
    expect((await writeLaunchers([work()], directory)).get(work().id)).toBe("claude-work-abc123.sh");
    expect(await readFile(join(directory, "claude-work.sh"), "utf8")).toBe(handmade);
  });
});

describe("daemons sharing the directory", () => {
  /** Runs `action` as the daemon whose Paseo home is `paseo`. */
  async function as<T>(paseo: string, action: () => Promise<T>): Promise<T> {
    const previous = process.env.PASEO_HOME;
    process.env.PASEO_HOME = paseo;
    try {
      return await action();
    } finally {
      process.env.PASEO_HOME = previous;
    }
  }
  const first = () => join(root, "zero sub");
  const second = () => join(root, "other paseo");
  const home = (paseo: string, id: string) => join(paseo, "zerosub", "homes", id);

  it("each keep their own scripts and leave the other's alone", async () => {
    const directory = join(root, "launchers");
    const work = { id: "claude-aaa111", label: "Work", home: home(first(), "claude-aaa111") };
    const play = { id: "claude-bbb222", label: "Play", home: home(second(), "claude-bbb222") };
    const twin = { id: "claude-ccc333", label: "Work", home: home(second(), "claude-ccc333") };
    await as(first(), () => writeLaunchers([work], directory));
    expect((await as(second(), () => writeLaunchers([play, twin], directory))).get(twin.id)).toBe("claude-work-ccc333.sh");
    const written = new Map<string, string>();
    for (const name of await readdir(directory)) written.set(name, await readFile(join(directory, name), "utf8"));

    // Either one running again, even with no accounts left, changes nothing of the other's.
    await as(first(), () => writeLaunchers([work], directory));
    await as(second(), () => writeLaunchers([play, twin], directory));
    await as(first(), () => writeLaunchers([], directory));
    expect((await readdir(directory)).sort()).toEqual(["claude-play.sh", "claude-work-ccc333.sh"]);
    expect(await readFile(join(directory, "claude-play.sh"), "utf8")).toBe(written.get("claude-play.sh"));
    expect((await readFile(join(directory, "claude-play.sh"), "utf8")).split("\n")[1]).toContain(`(Paseo home ${await as(second(), async () => paseoHomeTag())})`);
  });

  it("take over their own scripts in the old format, and leave any other in it alone", async () => {
    const directory = join(root, "launchers");
    await mkdir(directory, { recursive: true });
    const legacy = (account: { id: string; label: string; home: string }) =>
      renderLauncher(account).replace(/^# Generated by ZeroSub.*$/m, "# Generated by ZeroSub. Don't edit: it's rewritten whenever accounts change.");
    const work = { id: "claude-aaa111", label: "Work", home: home(first(), "claude-aaa111") };
    const moved = { id: "claude-ddd444", label: "Moved", home: join(root, "claude-config", "claude-moved") };
    const gone = { id: "claude-eee555", label: "Gone", home: home(first(), "claude-eee555") };
    const others = { id: "claude-bbb222", label: "Play", home: home(second(), "claude-bbb222") };
    const unknown = { id: "claude-fff666", label: "Kept", home: join(root, "claude-config", "claude-kept") };
    for (const account of [work, moved, gone, others, unknown]) {
      await writeFile(join(directory, `claude-${account.label.toLowerCase()}.sh`), legacy(account));
    }

    await as(first(), () => writeLaunchers([work, moved], directory));
    // Its own: rewritten in the new format, or removed with its account.
    expect(await readFile(join(directory, "claude-work.sh"), "utf8")).toBe(await as(first(), async () => renderLauncher(work)));
    expect(await readFile(join(directory, "claude-moved.sh"), "utf8")).toBe(await as(first(), async () => renderLauncher(moved)));
    await expect(stat(join(directory, "claude-gone.sh"))).rejects.toThrow();
    // Another daemon's home, or a home none of its accounts use: maybe another daemon's, so untouched.
    expect(await readFile(join(directory, "claude-play.sh"), "utf8")).toBe(legacy(others));
    expect(await readFile(join(directory, "claude-kept.sh"), "utf8")).toBe(legacy(unknown));

    // The other daemon, still on its old-format script, takes it over the same way.
    await as(second(), () => writeLaunchers([others], directory));
    expect(await readFile(join(directory, "claude-play.sh"), "utf8")).toBe(await as(second(), async () => renderLauncher(others)));
    expect(await readFile(join(directory, "claude-work.sh"), "utf8")).toBe(await as(first(), async () => renderLauncher(work)));
  });
});

describe("Pi scripts", () => {
  it("start pi on the account's folder with its proxy file, and share a directory with Claude's untouched", async () => {
    const dir = join(root, "scripts");
    const claude = await writeLaunchers([{ id: "claude-aaaaaaaaaaaa", label: "Work", home: own("claude-aaaaaaaaaaaa") }], dir);
    await mkdir(own("pi-bbbbbbbbbbbb"), { recursive: true });
    const pi = await writeLaunchers([{ id: "pi-bbbbbbbbbbbb", label: "Pi-Work", home: own("pi-bbbbbbbbbbbb") }], dir, [], new Map(), "pi");
    expect(claude.get("claude-aaaaaaaaaaaa")).toBe("claude-work.sh");
    // A label already starting with "pi-" isn't doubled.
    expect(pi.get("pi-bbbbbbbbbbbb")).toBe("pi-work.sh");
    const script = await readFile(join(dir, "pi-work.sh"), "utf8");
    expect(script).toBe(renderLauncher({ id: "pi-bbbbbbbbbbbb", label: "Pi-Work", home: own("pi-bbbbbbbbbbbb") }, "pi"));
    expect(script).toContain(`export PI_CODING_AGENT_DIR='${own("pi-bbbbbbbbbbbb")}'`);
    expect((await stat(join(dir, "pi-work.sh"))).mode & 0o777).toBe(0o755);

    // Each kind leaves the other's scripts alone, even with no accounts of its own left.
    await writeLaunchers([], dir);
    expect(await readFile(join(dir, "pi-work.sh"), "utf8")).toBe(script);
    await writeLaunchers([], dir, [own("pi-bbbbbbbbbbbb")], new Map(), "pi");
    await expect(stat(join(dir, "pi-work.sh"))).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });

  it("run pi with the account's folder and the proxy ZeroSub keeps for it", async () => {
    const home = join(root, "pi-home");
    await mkdir(home);
    await writeFile(join(home, "zerosub.env"), "export HTTPS_PROXY='http://127.0.0.1:7890'\n");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "pi"), '#!/bin/sh\necho "$PI_CODING_AGENT_DIR|$HTTPS_PROXY|$*"\n', { mode: 0o755 });
    const dir = join(root, "scripts");
    await writeLaunchers([{ id: "pi-cccccccccccc", label: "Gateway", home }], dir, [], new Map(), "pi");
    const { stdout } = await exec(join(dir, "pi-gateway.sh"), ["--version"], { env: { PATH: `${bin}:/usr/bin:/bin`, HTTPS_PROXY: "http://shell:1" } });
    expect(stdout.trim()).toBe(`${home}|http://127.0.0.1:7890|--version`);
  });
});
