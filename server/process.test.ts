import { describe, expect, it } from "vitest";
import { run } from "./process";

const NODE = process.execPath;
const MIB = 1024 * 1024;

describe("run", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const result = await run(NODE, ["-e", 'process.stdout.write("out\\n"); process.stderr.write("err\\n");'], {
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ code: 0, stdout: "out\n", stderr: "err\n", timedOut: false });
  });

  it("keeps multi-byte characters intact across chunk boundaries", async () => {
    const result = await run(NODE, ["-e", 'process.stdout.write("€".repeat(100000))'], { timeoutMs: 10_000 });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("€".repeat(100000));
  });

  it("times out a hanging child", async () => {
    const result = await run(NODE, ["-e", "setTimeout(() => {}, 30_000)"], { timeoutMs: 200 });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
  });

  it.skipIf(process.platform === "win32")("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const started = Date.now();
    const result = await run(NODE, ["-e", 'process.on("SIGTERM", () => {}); setTimeout(() => {}, 30_000)'], {
      timeoutMs: 200,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBeNull();
    // 200 ms timeout + 2 s SIGKILL delay: proves we waited for the escalation instead of hanging.
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
  }, 15_000);

  it("caps output past 1 MiB and reports the limit first", async () => {
    const result = await run(
      NODE,
      ["-e", 'process.stdout.write("x".repeat(2 * 1024 * 1024)); process.stderr.write("late\\n");'],
      { timeoutMs: 10_000 },
    );
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr.split("\n")[0]).toBe("Command output exceeded the 1 MiB limit.");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(MIB);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeGreaterThan(MIB - 8);
  });

  it.skipIf(process.platform === "win32")("reports the output limit, not a timeout, when a spewing child ignores SIGTERM", async () => {
    const result = await run(
      NODE,
      [
        "-e",
        'process.on("SIGTERM", () => {}); const s = "z".repeat(65536); ' +
          "for (let i = 0; i < 40; i++) process.stdout.write(s); " +
          "setInterval(() => process.stdout.write(s), 100); setTimeout(() => {}, 30_000);",
      ],
      { timeoutMs: 300 },
    );
    expect(result.code).toBeNull();
    expect(result.timedOut).toBe(false);
    expect(result.stderr.split("\n")[0]).toBe("Command output exceeded the 1 MiB limit.");
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(MIB);
  }, 15_000);
});
