import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { launcherNames, paseoHomeTag, piLauncherDir, renderLauncher, writeLaunchers } from "./launchers";

const exec = promisify(execFile);
let root: string;
let previousHome: string | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zerosub-launchers-"));
  previousHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = join(root, "paseo"); // ZeroSub's own homes are in here
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env.PASEO_HOME;
  else process.env.PASEO_HOME = previousHome;
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** A home ZeroSub made, which it deletes along with its account. */
const own = (name: string) => join(root, "paseo", "zerosub", "homes", name);

describe("piLauncherDir", () => {
  it("is ~/.pi-config unless ZEROSUB_PI_DIR says otherwise", () => {
    const previous = process.env.ZEROSUB_PI_DIR;
    try {
      delete process.env.ZEROSUB_PI_DIR;
      expect(piLauncherDir()).toBe(join(homedir(), ".pi-config"));
      process.env.ZEROSUB_PI_DIR = "/tmp/scripts/";
      expect(piLauncherDir()).toBe("/tmp/scripts");
    } finally {
      if (previous === undefined) delete process.env.ZEROSUB_PI_DIR;
      else process.env.ZEROSUB_PI_DIR = previous;
    }
  });
});

describe("Pi scripts", () => {
  it("are named after their accounts, once with pi-, and fall back to the account's ID", () => {
    const names = launcherNames([
      { id: "pi-aaaaaaaaaaaa", label: "Work", home: "/a" },
      { id: "pi-bbbbbbbbbbbb", label: "Pi-Work", home: "/b" },
      { id: "pi-cccccccccccc", label: "日本", home: "/c" },
    ]);
    expect([...names.values()]).toEqual(["pi-work.sh", "pi-work-bbbbbb.sh", "pi-cccccc.sh"]);
  });

  it("start pi on the account's folder with the proxy ZeroSub keeps for it, whatever the shell exports", async () => {
    const home = join(root, "pi-home");
    await mkdir(home);
    await writeFile(join(home, "zerosub.env"), "export HTTPS_PROXY='http://127.0.0.1:7890'\n");
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "pi"), '#!/bin/sh\necho "$PI_CODING_AGENT_DIR|$HTTPS_PROXY|$*"\n', { mode: 0o755 });
    const dir = join(root, "scripts");
    const names = await writeLaunchers([{ id: "pi-cccccccccccc", label: "Gateway", home }], dir);
    expect(names.get("pi-cccccccccccc")).toBe("pi-gateway.sh");
    expect((await stat(join(dir, "pi-gateway.sh"))).mode & 0o777).toBe(0o755);
    const { stdout } = await exec(join(dir, "pi-gateway.sh"), ["--version"], { env: { PATH: `${bin}:/usr/bin:/bin`, HTTPS_PROXY: "http://shell:1" } });
    expect(stdout.trim()).toBe(`${home}|http://127.0.0.1:7890|--version`);
  });

  it("go with a removed account's own home, and are released when its home is kept elsewhere", async () => {
    const dir = join(root, "scripts");
    await mkdir(own("pi-aaaaaaaaaaaa"), { recursive: true });
    const kept = join(root, "pi-config", "pi-kept");
    await mkdir(kept, { recursive: true });
    await writeLaunchers(
      [
        { id: "pi-aaaaaaaaaaaa", label: "Own", home: own("pi-aaaaaaaaaaaa") },
        { id: "pi-bbbbbbbbbbbb", label: "Kept", home: kept },
      ],
      dir,
    );
    expect((await readdir(dir)).sort()).toEqual(["pi-kept.sh", "pi-own.sh"]);
    await writeLaunchers([], dir, [own("pi-aaaaaaaaaaaa")]);
    expect(await readdir(dir)).toEqual(["pi-kept.sh"]);
    const released = await readFile(join(dir, "pi-kept.sh"), "utf8");
    expect(released.split("\n")[1]).toMatch(/^# No longer managed by ZeroSub/);
    // Added back, it gets its script back.
    await writeLaunchers([{ id: "pi-dddddddddddd", label: "Kept", home: kept }], dir);
    expect(await readFile(join(dir, "pi-kept.sh"), "utf8")).toBe(renderLauncher({ id: "pi-dddddddddddd", label: "Kept", home: kept }));
  });

  it("never touch hand-written scripts, other daemons' scripts or links", async () => {
    const dir = join(root, "scripts");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "pi-work.sh"), "#!/bin/sh\nexec pi\n");
    const other = renderLauncher({ id: "pi-eeeeeeeeeeee", label: "Other", home: "/elsewhere" }).replace(paseoHomeTag(), "00000000");
    await writeFile(join(dir, "pi-other.sh"), other);
    await symlink("/dev/null", join(dir, "pi-link.sh"));
    const names = await writeLaunchers([{ id: "pi-ffffffffffff", label: "Work", home: join(root, "work") }], dir);
    expect(names.get("pi-ffffffffffff")).toBe("pi-work-ffffff.sh");
    expect(await readFile(join(dir, "pi-work.sh"), "utf8")).toBe("#!/bin/sh\nexec pi\n");
    expect(await readFile(join(dir, "pi-other.sh"), "utf8")).toBe(other);
    expect((await readdir(dir)).sort()).toEqual(["pi-link.sh", "pi-other.sh", "pi-work-ffffff.sh", "pi-work.sh"]);
  });
});
