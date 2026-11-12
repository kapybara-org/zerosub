import { HIDDEN } from "../shared/model";

/** The order Node clients read them in (undici's `EnvHttpProxyAgent`, as Pi uses): the first one set wins. */
export const PROXY_KEYS = ["https_proxy", "HTTPS_PROXY", "http_proxy", "HTTP_PROXY"] as const;

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
      if (entry === "*") return false;
      const host = entry
        .toLowerCase()
        .replace(/:\d*$/, "")
        .replace(/^\*?\.?/, "");
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
