import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createConnection, createServer, type AddressInfo, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { bypassesProxy, maskProxy, noProxyFromEnv, normalizeProxy, openTunnel, proxiedFetch, withRequiredNoProxy, withoutDomains } from "./proxy";

const servers: (Server | HttpServer)[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen<T extends Server | HttpServer>(server: T): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

/** A TCP server that answers every line with "echo:" + line. */
async function echoServer(): Promise<number> {
  return listen(createServer((socket) => socket.on("data", (chunk) => socket.write(`echo:${chunk}`))));
}

/** A minimal CONNECT proxy that records what it was asked and can refuse, or send every tunnel `to` one local port. */
async function connectProxy(options: { refuse?: number; to?: number } = {}): Promise<{ port: number; seen: { url?: string; auth?: string }[] }> {
  const seen: { url?: string; auth?: string }[] = [];
  const server = createHttpServer();
  server.on("connect", (req, client, head) => {
    seen.push({ url: req.url, auth: req.headers["proxy-authorization"] });
    if (options.refuse) {
      client.end(`HTTP/1.1 ${options.refuse} Nope\r\n\r\n`);
      return;
    }
    const [host, port] = (req.url ?? "").split(":");
    const upstream = createConnection(options.to ? { host: "127.0.0.1", port: options.to } : { host, port: Number(port) }, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
  });
  return { port: await listen(server), seen };
}

function firstReply(socket: import("node:net").Socket): Promise<string> {
  return new Promise((resolve) => socket.once("data", (chunk) => resolve(String(chunk))));
}


describe("normalizeProxy", () => {
  it("accepts http(s) proxies with optional credentials, in canonical form", () => {
    expect(normalizeProxy(" http://127.0.0.1:7890/ ")).toBe("http://127.0.0.1:7890");
    expect(normalizeProxy("https://user:p%40ss@proxy.example:8443")).toBe("https://user:p%40ss@proxy.example:8443");
    expect(normalizeProxy("HTTP://Proxy.Example")).toBe("http://proxy.example");
  });

  it("refuses anything Pi and ZeroSub can't both use", () => {
    expect(() => normalizeProxy("socks5://127.0.0.1:1080")).toThrow("socks5 proxies aren't supported");
    expect(() => normalizeProxy("127.0.0.1:7890")).toThrow();
    expect(() => normalizeProxy("http://127.0.0.1:7890/path")).toThrow("scheme, host and port");
    expect(() => normalizeProxy("not a proxy")).toThrow("as a URL");
  });

  it("refuses a proxy whose password is still the one shown hidden", () => {
    expect(() => normalizeProxy("http://me:•••@proxy.example:8443")).toThrow("type it in full");
    expect(() => normalizeProxy("http://•••@proxy.example:8443")).toThrow("type it in full");
  });
});

describe("maskProxy", () => {
  it("hides only the password", () => {
    expect(maskProxy("http://user:secret@127.0.0.1:7890")).toBe("http://user:•••@127.0.0.1:7890");
    expect(maskProxy("http://127.0.0.1:7890")).toBe("http://127.0.0.1:7890");
  });
});

describe("openTunnel", () => {
  it("tunnels to the target through the proxy and sends proxy credentials", async () => {
    const target = await echoServer();
    const proxy = await connectProxy();
    const socket = await openTunnel(`http://user:p%40ss@127.0.0.1:${proxy.port}`, "127.0.0.1", target);
    socket.write("hi");
    expect(await firstReply(socket)).toBe("echo:hi");
    socket.destroy();
    expect(proxy.seen).toEqual([{ url: `127.0.0.1:${target}`, auth: `Basic ${Buffer.from("user:p@ss").toString("base64")}` }]);
  });

  it("fails when the proxy refuses the tunnel", async () => {
    const proxy = await connectProxy({ refuse: 407 });
    await expect(openTunnel(`http://127.0.0.1:${proxy.port}`, "example.com", 443)).rejects.toThrow("HTTP 407");
  });

  it("fails rather than going direct when the proxy is unreachable", async () => {
    const closed = await listen(createServer());
    await new Promise((resolve) => servers.pop()!.close(resolve));
    await expect(openTunnel(`http://127.0.0.1:${closed}`, "example.com", 443)).rejects.toThrow("Proxy connection failed");
  });

  it("refuses proxy schemes it can't speak", async () => {
    await expect(openTunnel("socks5://127.0.0.1:1080", "example.com", 443)).rejects.toThrow("socks5:");
    await expect(openTunnel("not a url", "example.com", 443)).rejects.toThrow("valid URL");
  });
});

describe("proxiedFetch", () => {
  it("sends an https request through the proxy's tunnel, never straight to the host", async () => {
    // A host only the proxy reaches: it doesn't resolve, so going straight there gets nowhere.
    let hello = "";
    const target = await listen(createServer((socket) => socket.once("data", (chunk: Buffer) => ((hello = chunk.toString("latin1")), socket.destroy()))));
    const proxy = await connectProxy({ to: target });
    await expect(proxiedFetch(`http://127.0.0.1:${proxy.port}`, "https://usage.zerosub.test/api", { signal: AbortSignal.timeout(5_000) })).rejects.toThrow();
    expect(proxy.seen.map((entry) => entry.url)).toEqual(["usage.zerosub.test:443"]);
    // The TLS handshake with the host went through the tunnel: the host's name is in its hello.
    expect(hello).toContain("usage.zerosub.test");
  });

  it("never sends a plain-http request through the tunnel path", async () => {
    await expect(proxiedFetch("http://127.0.0.1:1", "http://example.com/")).rejects.toThrow("https://");
  });
});

describe("maskProxy, for proxies not typed in the app", () => {
  it("hides credentials without a scheme, a lone user name, and anything it can't read", () => {
    expect(maskProxy("user:secret@proxy.example:8080")).toBe("user:•••@proxy.example:8080");
    expect(maskProxy("proxy.example:8080")).toBe("proxy.example:8080");
    expect(maskProxy("http://token@proxy.example:8080")).toBe("http://•••@proxy.example:8080");
    expect(maskProxy("http://us er:sec ret@proxy.example:8080")).not.toContain("sec");
    expect(maskProxy("http://user:secret@proxy example")).toBe("•••@proxy example");
    expect(maskProxy("http://[bad-secret")).toBe("•••");
  });
});

describe("no-proxy lists", () => {
  it("are read from both variables", () => {
    expect(noProxyFromEnv({ no_proxy: "a", NO_PROXY: "b" })).toBe("a,b");
    expect(noProxyFromEnv({ no_proxy: "a", NO_PROXY: "a" })).toBe("a");
    expect(noProxyFromEnv({ no_proxy: "", NO_PROXY: "b" })).toBe("b");
    expect(noProxyFromEnv({ no_proxy: "a", NO_PROXY: "*" })).toBe("*");
    expect(noProxyFromEnv({})).toBeNull();
  });

  it("send a host past the proxy by exact host, suffix or host:port", () => {
    const usage = "https://api.anthropic.com/api/oauth/usage";
    expect(bypassesProxy("*", usage)).toBe(true);
    expect(bypassesProxy(".anthropic.com", usage)).toBe(true);
    expect(bypassesProxy("localhost, API.anthropic.com", usage)).toBe(true);
    expect(bypassesProxy("api.anthropic.com:443", usage)).toBe(true);
    expect(bypassesProxy("api.anthropic.com:8443", usage)).toBe(false);
    expect(bypassesProxy("anthropic.com", usage)).toBe(false);
    expect(bypassesProxy("localhost,*", usage)).toBe(false);
    expect(bypassesProxy(null, usage)).toBe(false);
  });

  it("lose only the entries that could send the given domains' traffic past the proxy", () => {
    const anthropic = ["anthropic.com", "claude.ai", "claude.com"];
    expect(
      withoutDomains("localhost, 127.0.0.1,.anthropic.com,anthropic.com,api.anthropic.com:443,*.claude.ai,claude.com,.com,10.0.0.0/8,corp.example,notanthropic.com", anthropic),
    ).toBe("localhost,127.0.0.1,10.0.0.0/8,corp.example,notanthropic.com");
    expect(withoutDomains("gw.example.com,other.example", [...anthropic, "gw.example.com"])).toBe("other.example");
    expect(withoutDomains("*", anthropic)).toBe("");
    expect(withoutDomains(null, anthropic)).toBe("");
    // undici from 8.12 (Pi 1.5.0 on) takes `*` with a port for every host on that port, anywhere in
    // the list; a trailing dot names the same host to every version.
    expect(withoutDomains("corp.example,*:443,*:8443", anthropic)).toBe("corp.example");
    expect(withoutDomains("anthropic.com.,api.anthropic.com.:443,.claude.ai.,corp.example.", anthropic)).toBe("corp.example.");
    // Nor any entry that's `*` once a port, a leading `*.` or `.` and a trailing dot are dropped.
    for (const entry of [".*", "*.*", ".*.", "*.*:443"]) expect(withoutDomains(`corp.example,${entry}`, anthropic), entry).toBe("corp.example");
  });

  it("keep this machine direct when a proxy is installed", () => {
    expect(withRequiredNoProxy("corp.example,localhost,::1")).toBe("localhost,127.0.0.1,::1,corp.example");
  });
});
