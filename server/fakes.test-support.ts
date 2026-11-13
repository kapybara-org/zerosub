import type { FamilyAdapter } from "./adapter";

/**
 * A Pi adapter for tests whose host has no Pi: never available, so the service registers no Pi
 * account and never starts `pi`. Test-only (kept out of the package, see package.json `files`).
 */
export function absentPi(): FamilyAdapter {
  const refuse = () => Promise.reject(new Error("Pi isn't installed (test)"));
  return {
    family: "pi",
    portable: true,
    usageSpacingMs: 60_000,
    available: async () => ({ ok: false, detail: "pi: not installed (test)" }),
    prepareHome: async () => undefined,
    env: async () => ({}),
    identity: refuse,
    usage: refuse,
    redeemReset: refuse,
    login: refuse,
    logout: async () => undefined,
    detectLimit: () => null,
    detectSignOut: () => null,
  };
}
