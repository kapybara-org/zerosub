import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PiAdapter } from "./pi";
import { homesInEnvironment, parseTrace } from "./processes";

describe("which homes a process runs on", () => {
  const homes = ["/Users/me/.pi-config/pi-work", "/Users/me/.pi-config/pi work"];

  it("takes a home only from the variable set to exactly that path", () => {
    const line = "node /usr/local/bin/pi TERM=xterm PI_CODING_AGENT_DIR=/Users/me/.pi-config/pi-work HOME=/Users/me";
    expect(homesInEnvironment(line, homes, ["PI_CODING_AGENT_DIR"])).toEqual(["/Users/me/.pi-config/pi-work"]);
    // A longer path that starts with it, or another variable, isn't it.
    expect(homesInEnvironment("pi PI_CODING_AGENT_DIR=/Users/me/.pi-config/pi-work-2", homes, ["PI_CODING_AGENT_DIR"])).toEqual([]);
    expect(homesInEnvironment("pi XPI_CODING_AGENT_DIR=/Users/me/.pi-config/pi-work", homes, ["PI_CODING_AGENT_DIR"])).toEqual([]);
    expect(homesInEnvironment("pi OTHER=/Users/me/.pi-config/pi-work", homes, ["PI_CODING_AGENT_DIR"])).toEqual([]);
  });

  it("finds a home whose path has a space in it", () => {
    expect(homesInEnvironment("pi PI_CODING_AGENT_DIR=/Users/me/.pi-config/pi work LANG=C", homes, ["PI_CODING_AGENT_DIR"])).toEqual([
      "/Users/me/.pi-config/pi work",
    ]);
  });

  it.runIf(process.platform === "darwin" || process.platform === "linux")("sees a running process started on a home", async () => {
    const root = await mkdtemp(join(tmpdir(), "zerosub-processes-"));
    const home = join(root, "pi-work");
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
      env: { ...process.env, PI_CODING_AGENT_DIR: home },
      stdio: "ignore",
    });
    try {
      await new Promise((resolve) => child.once("spawn", resolve));
      const adapter = new PiAdapter();
      expect(await adapter.homesInUse([home, join(root, "pi-other")])).toEqual(new Set([home]));
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
      expect(await adapter.homesInUse([home])).toEqual(new Set());
    } finally {
      child.kill();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("the address Anthropic sees", () => {
  it("reads it from a trace answer", () => {
    expect(parseTrace("fl=1\nip=203.0.113.7\nloc=US\nvisit_scheme=https\n")).toEqual({ ip: "203.0.113.7", country: "US" });
    expect(parseTrace("ip=2001:db8::1\n")).toEqual({ ip: "2001:db8::1", country: null });
    expect(parseTrace("<html>blocked</html>")).toBeNull();
  });
});
