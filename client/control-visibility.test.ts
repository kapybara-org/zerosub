import { afterEach, describe, expect, it, vi } from "vitest";
import { controlShown, forgetControlsShown, inDialog, onScreen, setControlShown, subscribeControlShown } from "./control-visibility";

afterEach(() => forgetControlsShown());

describe("which agents' Account controls are on screen", () => {
  it("counts an agent as shown while any of its mounts is, and says when that changes", () => {
    const changed = vi.fn();
    const stop = subscribeControlShown(changed);
    const toolbar = {};
    const sheet = {};
    setControlShown("a", toolbar, true);
    setControlShown("a", sheet, true);
    expect(controlShown("a")).toBe(true);
    expect(changed).toHaveBeenCalledTimes(1);
    setControlShown("a", toolbar, false);
    expect(controlShown("a")).toBe(true);
    setControlShown("a", sheet, false);
    expect(controlShown("a")).toBe(false);
    expect(changed).toHaveBeenCalledTimes(2);
    // A mount going off that was never on changes nothing.
    setControlShown("b", {}, false);
    expect(changed).toHaveBeenCalledTimes(2);
    stop();
    setControlShown("a", toolbar, true);
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it("asks a web element whether it's visible, counting hidden and transparent as off screen", () => {
    const checkVisibility = vi.fn(() => true);
    expect(onScreen({ checkVisibility })).toBe(true);
    expect(checkVisibility).toHaveBeenCalledWith({ opacityProperty: true, visibilityProperty: true });
    expect(onScreen({ checkVisibility: () => false })).toBe(false);
  });

  it("counts a view that can't say (a phone app's) as off screen, so the account button stays", () => {
    expect(onScreen(null)).toBe(false);
    expect(onScreen({})).toBe(false);
    expect(
      onScreen({
        checkVisibility() {
          throw new Error("detached");
        },
      }),
    ).toBe(false);
  });

  it("tells a control in one of Paseo's dialogs (the composer's sheet) from one in the toolbar", () => {
    const closest = vi.fn((_selector: string) => ({}));
    expect(inDialog({ closest })).toBe(true);
    expect(closest).toHaveBeenCalledWith('[role="dialog"], [aria-modal="true"]');
    expect(inDialog({ closest: () => null })).toBe(false);
    // A phone app's view can't say.
    expect(inDialog({})).toBe(false);
    expect(inDialog(null)).toBe(false);
  });
});
