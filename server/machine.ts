import { existsSync } from "node:fs";

/**
 * Whether a browser on this machine can finish a sign-in. The providers' browser sign-ins redirect
 * to `localhost`, which reaches the daemon only from the machine it runs on. Servers, containers
 * and daemons started over SSH have nobody at a browser there, so they sign in with a code.
 */
export function canSignInWithBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return false;
  if (platform === "darwin" || platform === "win32") return true;
  if (exists("/.dockerenv") || exists("/run/.containerenv")) return false;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
