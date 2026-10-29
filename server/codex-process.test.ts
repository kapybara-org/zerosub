import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexAdapter } from "./codex";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("./binaries", () => ({
  providerCommand: async () => ({ command: "fake-codex", prefix: [] }),
}));

type Child = EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; kill: ReturnType<typeof vi.fn> };

function childProcess(): Child {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
}

interface Request {
  id: number;
  method: string;
  params?: unknown;
}

/** Wires a fake `codex app-server` onto the mocked child: stdin requests trigger `onRequest`, replies go to stdout. */
function serve(child: Child, onRequest: (request: Request) => void): Request[] {
  const seen: Request[] = [];
  let buffer = "";
  child.stdin.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const request = JSON.parse(buffer.slice(0, newline)) as Request;
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      seen.push(request);
      onRequest(request);
    }
  });
  return seen;
}

function reply(child: Child, id: number, result: unknown): void {
  child.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function replyError(child: Child, id: number, message: string): void {
  child.stdout.write(`${JSON.stringify({ id, error: { message } })}\n`);
}

const ACCOUNT = { account: { type: "chatgpt", email: "Ada@Example.com", planType: "plus" } };
const LIMITS = {
  accountId: "acc-1",
  rateLimits: { primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1_784_000_000 } },
  rateLimitResetCredits: { availableCount: 0 },
};

function healthy(child: Child): Request[] {
  return serve(child, (request) => {
    if (request.method === "initialize") reply(child, request.id, {});
    else if (request.method === "account/read") reply(child, request.id, ACCOUNT);
    else if (request.method === "account/rateLimits/read") reply(child, request.id, LIMITS);
  });
}

describe("Codex app-server process handling", () => {
  beforeEach(() => spawn.mockReset());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    spawn.mockReset();
  });

  it("an oversized notification doesn't break a read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const child = childProcess();
    spawn.mockReturnValue(child);
    const huge = `${JSON.stringify({ method: "codex/event", params: { blob: "x".repeat(1024 * 1024) } })}\n`;
    serve(child, (request) => {
      if (request.method === "initialize") reply(child, request.id, {});
      else if (request.method === "account/read") {
        child.stdout.write(huge);
        child.stdout.write(huge);
        reply(child, request.id, ACCOUNT);
      } else if (request.method === "account/rateLimits/read") reply(child, request.id, LIMITS);
    });
    const identity = await new CodexAdapter().identity(null);
    expect(identity).toMatchObject({ signedIn: true, email: "Ada@Example.com", identity: "chatgpt|acc-1|ada@example.com" });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a flood with no newline stays bounded", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const child = childProcess();
    spawn.mockReturnValue(child);
    const held: Request[] = [];
    serve(child, (request) => {
      if (request.method === "initialize") reply(child, request.id, {});
      else if (request.method === "account/read") held.push(request);
      else if (request.method === "account/rateLimits/read") reply(child, request.id, LIMITS);
    });
    const read = new CodexAdapter().identity(null);
    await vi.waitFor(() => expect(held).toHaveLength(1));
    const id = held[0]!.id;
    const quarter = "y".repeat(256 * 1024);
    for (let i = 0; i < 4; i++) child.stdout.write(quarter);
    expect(warn).not.toHaveBeenCalled(); // exactly 1 MiB is still allowed
    child.stdout.write(quarter);
    expect(warn).toHaveBeenCalledTimes(1); // dropped as soon as it passed the limit
    // Up to its newline this is still the oversized message, even where it looks like a reply.
    const wrong = { account: { type: "chatgpt", email: "wrong@example.com", planType: "plus" } };
    child.stdout.write(`${JSON.stringify({ id, result: wrong })}\n`);
    reply(child, id, ACCOUNT);
    await expect(read).resolves.toMatchObject({ email: "Ada@Example.com" });
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("shares one in-flight read between identity and usage past the TTL", async () => {
    vi.useFakeTimers();
    try {
      const child = childProcess();
      spawn.mockReturnValue(child);
      const held: Request[] = [];
      serve(child, (request) => {
        if (request.method === "initialize") reply(child, request.id, {});
        else if (request.method === "account/read") held.push(request);
        else if (request.method === "account/rateLimits/read") reply(child, request.id, LIMITS);
      });
      const adapter = new CodexAdapter();
      const first = adapter.identity(null);
      await vi.advanceTimersByTimeAsync(0);
      const pending = held[0];
      if (!pending) throw new Error("expected the account/read request to be in flight");
      await vi.advanceTimersByTimeAsync(16_000); // Past the 15 s (and 5 s fresh) TTL, before request timeouts.
      const second = adapter.usage(null);
      expect(spawn).toHaveBeenCalledTimes(1);
      reply(child, pending.id, ACCOUNT);
      await vi.advanceTimersByTimeAsync(0);
      const [identity, usage] = await Promise.all([first, second]);
      expect(identity.email).toBe("Ada@Example.com");
      expect(usage.windows).toHaveLength(1);
      expect(usage.windows[0]).toMatchObject({ id: "primary", label: "5-hour", usedPercent: 12 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a read after 60 s and releases every waiter", async () => {
    vi.useFakeTimers();
    const hung = childProcess();
    const next = childProcess();
    spawn.mockReturnValueOnce(hung).mockReturnValueOnce(next);
    // Starting takes 59 s, inside its own timeout; then account/read never answers.
    serve(hung, (request) => {
      if (request.method === "initialize") setTimeout(() => reply(hung, request.id, {}), 59_000);
    });
    healthy(next);
    const adapter = new CodexAdapter();
    const errors: string[] = [];
    void adapter.identity(null).catch((error: Error) => errors.push(error.message));
    await vi.advanceTimersByTimeAsync(20_000);
    void adapter.usage(null).catch((error: Error) => errors.push(error.message));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(errors).toEqual(["Codex did not answer within 60 s", "Codex did not answer within 60 s"]);
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(hung.kill).toHaveBeenCalledWith("SIGTERM");
    // The failure isn't cached, so the next read starts a fresh session.
    await expect(adapter.identity(null)).resolves.toMatchObject({ email: "Ada@Example.com" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("retries with a fresh session after a failed read", async () => {
    const failing = childProcess();
    const next = childProcess();
    spawn.mockReturnValueOnce(failing).mockReturnValueOnce(next);
    serve(failing, (request) => {
      if (request.method === "initialize") reply(failing, request.id, {});
      else if (request.method === "account/read") replyError(failing, request.id, "rateLimits exploded");
    });
    healthy(next);
    const adapter = new CodexAdapter();
    await expect(adapter.identity(null)).rejects.toThrow("rateLimits exploded");
    const identity = await adapter.identity(null);
    expect(identity).toMatchObject({ signedIn: true, email: "Ada@Example.com", identity: "chatgpt|acc-1|ada@example.com" });
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("keeps a character split across two writes whole", async () => {
    const child = childProcess();
    spawn.mockReturnValue(child);
    serve(child, (request) => {
      if (request.method === "initialize") reply(child, request.id, {});
      else if (request.method === "account/read") {
        const account = { account: { type: "chatgpt", email: "zoë@example.com", planType: "plus" } };
        const frame = Buffer.from(`${JSON.stringify({ id: request.id, result: account })}\n`);
        const cut = frame.indexOf(Buffer.from("ë")) + 1; // between the two bytes of "ë"
        child.stdout.write(frame.subarray(0, cut));
        child.stdout.write(frame.subarray(cut));
      } else if (request.method === "account/rateLimits/read") reply(child, request.id, LIMITS);
    });
    const identity = await new CodexAdapter().identity(null);
    expect(identity.email).toBe("zoë@example.com");
  });
});
