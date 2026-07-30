import { describe, expect, it } from "vitest";
import { colorDeltaE, labCiede2000, rgbToLab, type Lab } from "../src/color.js";

// Reference pairs from Sharma, Wu & Dalal (2005), the canonical CIEDE2000 dataset.
const SHARMA: [Lab, Lab, number][] = [
  [{ L: 50, a: 2.6772, b: -79.7751 }, { L: 50, a: 0, b: -82.7485 }, 2.0425],
  [{ L: 50, a: 3.1571, b: -77.2803 }, { L: 50, a: 0, b: -82.7485 }, 2.8615],
  [{ L: 50, a: 2.8361, b: -74.02 }, { L: 50, a: 0, b: -82.7485 }, 3.4412],
  [{ L: 50, a: -1.3802, b: -84.2814 }, { L: 50, a: 0, b: -82.7485 }, 1.0],
  [{ L: 50, a: -1.1848, b: -84.8006 }, { L: 50, a: 0, b: -82.7485 }, 1.0],
  [{ L: 50, a: 2.5, b: 0 }, { L: 50, a: 0, b: -2.5 }, 4.3065],
  [
    { L: 60.2574, a: -34.0099, b: 36.2677 },
    { L: 60.4626, a: -34.1751, b: 39.4387 },
    1.2644,
  ],
];

describe("labCiede2000", () => {
  it("matches the Sharma reference vectors within 1e-4", () => {
    for (const [a, b, expected] of SHARMA) {
      expect(labCiede2000(a, b)).toBeCloseTo(expected, 4);
    }
  });

  it("is zero for identical colors", () => {
    const lab = { L: 32, a: 10, b: -5 };
    expect(labCiede2000(lab, lab)).toBe(0);
  });
});

describe("rgbToLab", () => {
  it("maps sRGB white to L=100, a=b=0", () => {
    const lab = rgbToLab({ r: 1, g: 1, b: 1, a: 1 });
    expect(lab.L).toBeCloseTo(100, 3);
    expect(lab.a).toBeCloseTo(0, 3);
    expect(lab.b).toBeCloseTo(0, 3);
  });

  it("maps sRGB black to L=0", () => {
    expect(rgbToLab({ r: 0, g: 0, b: 0, a: 1 }).L).toBeCloseTo(0, 3);
  });
});

describe("colorDeltaE", () => {
  it("is zero for identical rgba", () => {
    const c = { r: 0.2, g: 0.4, b: 0.6, a: 1 };
    expect(colorDeltaE(c, c)).toBe(0);
  });

  it("is large for black vs white", () => {
    const d = colorDeltaE(
      { r: 0, g: 0, b: 0, a: 1 },
      { r: 1, g: 1, b: 1, a: 1 },
    );
    expect(d).toBeGreaterThan(95);
  });
});
