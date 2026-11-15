import { describe, expect, it } from "vitest";
import { ringPercent, ringSvg } from "./ring";

describe("ringSvg", () => {
  it("draws the share used as an arc over a faint track", () => {
    const svg = ringSvg(25);
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('stroke-opacity="0.28"');
    // A quarter of a 6-radius circle.
    expect(svg).toContain('stroke-dasharray="9.42 37.70"');
    expect(svg).not.toMatch(/style|script|href|\son[a-z]+=/i);
  });

  it("draws no arc at 0%, a closed one at 100%, and a dot when picked", () => {
    expect(ringSvg(0).match(/<circle/g)).toHaveLength(1);
    expect(ringSvg(100, { arc: "#e5484d" })).toContain('stroke="#e5484d"/>');
    expect(ringSvg(40, { selected: true })).toContain('r="2.25" fill="currentColor"');
    expect(ringSvg(40, { dashed: true })).not.toContain("rotate(");
  });

  it("only takes plain colours, never anything that would break out of the attribute", () => {
    expect(ringSvg(50, { arc: 'red" onload="x' })).toContain('stroke="currentColor" stroke-linecap');
    expect(ringPercent(140)).toBe(100);
    expect(ringPercent(-3)).toBe(0);
  });
});
