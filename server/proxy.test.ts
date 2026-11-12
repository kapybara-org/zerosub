import { describe, expect, it } from "vitest";
import { bypassesProxy, maskProxy, noProxyFromEnv, normalizeProxy, withRequiredNoProxy, withoutDomains } from "./proxy";

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
  });

  it("keep this machine direct when a proxy is installed", () => {
    expect(withRequiredNoProxy("corp.example,localhost,::1")).toBe("localhost,127.0.0.1,::1,corp.example");
  });
});
