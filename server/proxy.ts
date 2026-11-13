import { request as httpsRequest } from "node:https";
import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { HIDDEN } from "../shared/model";

/** The order Node clients read them in (undici's `EnvHttpProxyAgent`, as Pi uses): the first one set wins. */
export const PROXY_KEYS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;

/** The proxy an environment names, in the order Node clients read the variables in; null without one. */
export function proxyFromEnv(env: Record<string, string | undefined>): string | null {
  for (const key of PROXY_KEYS) {
    const value = env[key]?.trim();
    if (value) return value;
  }
  return null;
}

export const NO_PROXY_KEYS = ["no_proxy", "NO_PROXY"] as const;

/** Hosts that stay direct when ZeroSub gives a process a proxy: this machine, where a local gateway may be. */
export const REQUIRED_NO_PROXY = ["localhost", "127.0.0.1", "::1"] as const;

/** The no-proxy list in an environment: `*` if either variable is, else both when they differ. */
export function noProxyFromEnv(env: Record<string, string | undefined>): string | null {
  const { no_proxy: lower, NO_PROXY: upper } = env;
  if (lower === "*" || upper === "*") return "*";
  if (lower && upper && lower !== upper) return `${lower},${upper}`;
  return lower || upper || null;
}

/**
 * Whether a request to `target` goes direct under the no-proxy list `noProxy`: `*` for everything,
 * `host:port`, `.suffix` (the domain itself or any below it), otherwise the exact host.
 */
export function bypassesProxy(noProxy: string | null, target: string): boolean {
  if (!noProxy) return false;
  if (noProxy === "*") return true;
  const url = new URL(target);
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80");
  return noProxy
    .split(/[,\s]+/)
    .filter(Boolean)
    .some((raw) => {
      const entry = raw.toLowerCase();
      if (entry.includes(":")) return `${host}:${port}` === entry;
      if (entry.startsWith(".")) return host === entry.slice(1) || host.endsWith(entry);
      return host === entry;
    });
}

/**
 * `noProxy` without anything that could send a request to one of `domains` past the proxy, in any of
 * the forms HTTP clients accept: `*`, `*.domain`, `.domain`, `domain`, with or without a port, for
 * those domains, one below them (`api.anthropic.com`) or above them (`.com`). The rest (`localhost`,
 * an intranet's domain, address ranges) stays as it was.
 */
export function withoutDomains(noProxy: string | null, domains: readonly string[]): string {
  const wanted = domains.map((domain) => domain.toLowerCase()).filter(Boolean);
  return (noProxy ?? "")
    .split(/[,\s]+/)
    .filter((entry) => {
      if (!entry) return false;
      // Read the way the loosest client reads it. undici (Pi's) drops a port, a leading `*.` or `.`
      // and a trailing dot, and from 8.12 (Pi 1.5.0 on) takes `*`, alone or with a port (`*:443`),
      // for every host wherever it stands in the list.
      const host = entry
        .toLowerCase()
        .replace(/:\d*$/, "")
        .replace(/^\*?\.?/, "")
        .replace(/\.$/, "");
      if (!host || host === "*") return false;
      return !wanted.some((domain) => host === domain || domain.endsWith(`.${host}`) || host.endsWith(`.${domain}`));
    })
    .join(",");
}

/** Adds this machine's addresses, without duplicating entries. */
export function withRequiredNoProxy(noProxy: string | null): string {
  const entries = (noProxy ?? "").split(/[\s,]+/).filter(Boolean);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of [...REQUIRED_NO_PROXY, ...entries]) {
    const key = entry.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(entry);
    }
  }
  return result.join(",");
}

/**
 * Checks a proxy typed by the user and returns it in canonical form. Only http:// and https://
 * proxies are accepted: they're what Pi and ZeroSub's own requests can both use. One
 * still holding the hidden password it was shown with (see `maskProxy`) isn't a proxy to save.
 */
export function normalizeProxy(input: string): string {
  const value = input.trim();
  if (value.includes(HIDDEN)) throw new Error(`${HIDDEN} hides the proxy's password: type it in full`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Enter the proxy as a URL, like http://127.0.0.1:7890");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${url.protocol.replace(/:$/, "")} proxies aren't supported; use an http:// or https:// proxy`);
  }
  if (!url.hostname) throw new Error("The proxy needs a host, like http://127.0.0.1:7890");
  if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("The proxy is just scheme, host and port, like http://127.0.0.1:7890");
  }
  const auth = url.username || url.password ? `${url.username}${url.password ? `:${url.password}` : ""}@` : "";
  return `${url.protocol}//${auth}${url.host}`;
}

/**
 * The proxy for display: the password, if any, is hidden, and so is a user name with no password
 * (often a token). A proxy written without a scheme is read as http://,
 * and one that can't be read at all shows only what follows its last `@`.
 */
export function maskProxy(proxy: string): string {
  const value = proxy.trim();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
  let url: URL;
  try {
    url = new URL(scheme ? value : `http://${value}`);
  } catch {
    const at = value.lastIndexOf("@");
    return at === -1 ? HIDDEN : `${HIDDEN}${value.slice(at)}`;
  }
  if (!url.username && !url.password) return value;
  const prefix = scheme ? `${url.protocol}//` : "";
  const credentials = url.password ? `${url.username}:${HIDDEN}` : HIDDEN;
  return `${prefix}${credentials}@${url.host}`;
}

/**
 * Opens a raw tunnel to `host:port` through an HTTP(S) proxy with CONNECT. Anything other than an
 * http:// or https:// proxy is refused rather than skipped, so a misconfigured proxy never turns
 * into a direct connection.
 */
export function openTunnel(proxy: string, host: string, port: number, signal?: AbortSignal): Promise<Socket> {
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    return Promise.reject(new Error("The account's proxy isn't a valid URL"));
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return Promise.reject(new Error(`Proxy scheme ${url.protocol} isn't supported here; use an http:// or https:// proxy`));
  }
  const proxyPort = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
  const authority = `${host}:${port}`;
  const lines = [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`];
  if (url.username || url.password) {
    const credentials = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    lines.push(`Proxy-Authorization: Basic ${Buffer.from(credentials).toString("base64")}`);
  }

  return new Promise((resolve, reject) => {
    const socket: Socket =
      url.protocol === "https:"
        ? tlsConnect({ host: url.hostname, port: proxyPort, servername: url.hostname })
        : netConnect({ host: url.hostname, port: proxyPort });
    let head = Buffer.alloc(0);
    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error("Request aborted"));
    const onError = (error: Error) => fail(new Error(`Proxy connection failed: ${error.message}`));
    const onClose = () => fail(new Error("The proxy closed the connection before the tunnel opened"));
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) {
        if (head.length > 16 * 1024) fail(new Error("The proxy sent an oversized reply"));
        return;
      }
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(head.subarray(0, end).toString("latin1"));
      if (status?.[1] !== "200") {
        fail(new Error(`The proxy refused the tunnel (${status ? `HTTP ${status[1]}` : "unreadable reply"})`));
        return;
      }
      cleanup();
      const rest = head.subarray(end + 4);
      if (rest.length > 0) socket.unshift(rest);
      resolve(socket);
    };
    const cleanup = () => {
      socket.off("data", onData);
      socket.off("error", onError);
      socket.off("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
    socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => socket.write(`${lines.join("\r\n")}\r\n\r\n`));
  });
}

interface ProxiedInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * `fetch`, but through `proxy` when one is set, the way the account's CLI would reach the same
 * host for that account. Only https:// targets are supported; that's all ZeroSub calls.
 */
export async function proxiedFetch(proxy: string | null, target: string, init: ProxiedInit = {}): Promise<Response> {
  if (!proxy) return fetch(target, init);
  const url = new URL(target);
  if (url.protocol !== "https:") throw new Error("Only https:// requests go through the account's proxy");
  const port = Number(url.port) || 443;
  const tunnel = await openTunnel(proxy, url.hostname, port, init.signal);

  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = { ...init.headers };
    if (init.body !== undefined) headers["Content-Length"] = String(Buffer.byteLength(init.body));
    const req = httpsRequest(
      {
        host: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: init.method ?? "GET",
        headers,
        // No agent: Node only uses `createConnection` without one. `agent: false` would make a fresh
        // agent, which connects straight to the host and leaves the tunnel unused.
        servername: url.hostname,
        createConnection: () => tlsConnect({ socket: tunnel, servername: url.hostname }),
        signal: init.signal,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          const responseHeaders = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (Array.isArray(value)) for (const entry of value) responseHeaders.append(name, entry);
            else if (value !== undefined) responseHeaders.set(name, value);
          }
          const status = res.statusCode ?? 502;
          const empty = status === 204 || status === 304;
          resolve(new Response(empty ? null : new Uint8Array(Buffer.concat(chunks)), { status, headers: responseHeaders }));
        });
      },
    );
    req.on("error", (error) => {
      tunnel.destroy();
      reject(error);
    });
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}
