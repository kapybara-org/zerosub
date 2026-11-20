import { describe, expect, it, vi } from "vitest";

vi.mock("@getpaseo/plugin/client/react-native", () => ({ Icon: "Icon" }));
vi.mock("react-native", () => ({ Modal: "Modal", Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text", View: "View", useWindowDimensions: () => ({ width: 1200, height: 800 }) }));

const { popoverColor } = await import("./account-pill-button");

describe("the account control's menu", () => {
  it("takes Paseo's popover colour: the page's in a light theme, a step up in a dark one", () => {
    expect(popoverColor({ surface0: "#ffffff", surface2: "#f4f4f5" })).toBe("#ffffff");
    expect(popoverColor({ surface0: "#18181b", surface2: "#27272a" })).toBe("#27272a");
    // A colour it can't read counts as light.
    expect(popoverColor({ surface0: "white", surface2: "#27272a" })).toBe("white");
  });
});
