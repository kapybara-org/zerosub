import { describe, expect, it } from "vitest";
import { canSignInWithBrowser } from "./machine";

const nothing = () => false;

describe("canSignInWithBrowser", () => {
  it("trusts desktop operating systems", () => {
    expect(canSignInWithBrowser({}, "darwin", nothing)).toBe(true);
    expect(canSignInWithBrowser({}, "win32", nothing)).toBe(true);
  });

  it("uses a code for daemons started over SSH", () => {
    expect(canSignInWithBrowser({ SSH_CONNECTION: "10.0.0.2 51234 10.0.0.9 22" }, "darwin", nothing)).toBe(false);
    expect(canSignInWithBrowser({ SSH_TTY: "/dev/pts/0", DISPLAY: ":0" }, "linux", nothing)).toBe(false);
  });

  it("needs a display on Linux", () => {
    expect(canSignInWithBrowser({}, "linux", nothing)).toBe(false);
    expect(canSignInWithBrowser({ DISPLAY: ":0" }, "linux", nothing)).toBe(true);
    expect(canSignInWithBrowser({ WAYLAND_DISPLAY: "wayland-0" }, "linux", nothing)).toBe(true);
  });

  it("uses a code inside containers", () => {
    expect(canSignInWithBrowser({ DISPLAY: ":0" }, "linux", (path) => path === "/.dockerenv")).toBe(false);
    expect(canSignInWithBrowser({ DISPLAY: ":0" }, "linux", (path) => path === "/run/.containerenv")).toBe(false);
  });
});
