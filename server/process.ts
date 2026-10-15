import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Runs a command to completion with a timeout. Never throws for a non-zero exit. */
export function run(
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string; cwd?: string } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputBytes = 0;
    let outputExceeded = false;
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess;
    try {
      child = spawn(command, [...args], {
        env: options.env ?? process.env,
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: null, stdout, stderr: error instanceof Error ? error.message : String(error), timedOut });
      return;
    }
    const terminate = () => {
      if (killTimer) return;
      clearTimeout(timer);
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? 30_000);
    const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
      if (outputExceeded) return;
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      const text = decoders[stream].write(chunk.subarray(0, remaining));
      if (stream === "stdout") stdout += text;
      else stderr += text;
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        outputExceeded = true;
        terminate();
      }
    };
    // A child that exits early turns our stdin write into EPIPE; without a listener that kills the plugin.
    child.stdin?.on("error", () => undefined);
    child.stdout?.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
    child.on("error", (error) => {
      stderr += error.message;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      stdout += decoders.stdout.end();
      stderr += decoders.stderr.end();
      if (outputExceeded) stderr = `Command output exceeded the 1 MiB limit.${stderr ? `\n${stderr}` : ""}`;
      resolve({ code: outputExceeded ? null : code, stdout, stderr, timedOut });
    });
    if (options.input !== undefined) child.stdin?.end(options.input);
    else child.stdin?.end();
  });
}

/** Strips ANSI escape sequences (colors, cursor movement, OSC hyperlinks) from terminal output. */
export function stripAnsi(text: string): string {
  return text
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\u001b[@-Z\\-_]/g, "")
    .replace(/\r/g, "\n");
}

export function firstUrl(text: string, pattern: RegExp): string | null {
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
    if (pattern.test(match[0])) return match[0];
  }
  return null;
}
