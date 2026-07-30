import type { CanonicalStyleNode } from "@design-convergence/shared";
import { describe, expect, it } from "vitest";
import { diffCanonicalNodes } from "../src/diff.js";
import { REGISTRY } from "../src/registry.js";
import type { StyleDiff } from "../src/types.js";

function baseNode(): CanonicalStyleNode {
  return {
    designNodeId: "1:2",
    name: "Card",
    kind: "FRAME",
    geometry: {
      box: { x: 0, y: 0, width: 320, height: 480 },
      rootRelative: { x: 0, y: 0 },
    },
    layout: {
      padding: { top: 24, right: 24, bottom: 24, left: 24 },
      direction: "vertical",
      itemSpacing: 8,
      overflow: null,
    },
    appearance: {
      background: { r: 1, g: 1, b: 1, a: 1 },
      radius: { topLeft: 8, topRight: 8, bottomRight: 8, bottomLeft: 8 },
      borders: null,
      opacity: 1,
      shadows: [],
    },
    typography: {
      fontFamily: ["Inter"],
      fontSize: 16,
      fontWeight: 600,
      lineHeight: 24,
      letterSpacing: 0,
      color: { r: 0, g: 0, b: 0, a: 1 },
      textAlign: null,
    },
    absorbedNodeIds: [],
    unsupported: [],
    approximations: [],
  };
}

const find = (diffs: StyleDiff[], property: string) =>
  diffs.find((d) => d.property === property);

describe("diffCanonicalNodes", () => {
  it("passes with no diffs when nodes are identical", () => {
    const report = diffCanonicalNodes(baseNode(), baseNode());
    expect(report.status).toBe("pass");
    expect(report.diffs).toEqual([]);
    expect(report.metrics.fidelityScore).toBe(100);
    expect(report.metrics.comparedPropertyCount).toBe(REGISTRY.length);
    expect(report.metrics.unsupportedCount).toBe(0);
  });

  it("flags a >20% height change as critical and fails", () => {
    const actual = structuredClone(baseNode());
    actual.geometry.box.height = 600;
    const report = diffCanonicalNodes(baseNode(), actual);
    expect(report.status).toBe("fail");
    const d = find(report.diffs, "geometry.box.height")!;
    expect(d.status).toBe("mismatch");
    expect(d.severity).toBe("critical");
    expect(d.delta).toBe(120);
    expect(report.metrics.remainingHighCritical).toBeGreaterThanOrEqual(1);
  });

  it("bands padding deltas: 10px -> high", () => {
    const actual = structuredClone(baseNode());
    actual.layout.padding.top = 34;
    const d = find(
      diffCanonicalNodes(baseNode(), actual).diffs,
      "layout.padding.top",
    )!;
    expect(d.severity).toBe("high");
    expect(d.delta).toBe(10);
  });

  it("bands a 5px padding delta as medium", () => {
    const actual = structuredClone(baseNode());
    actual.layout.padding.left = 29;
    const d = find(
      diffCanonicalNodes(baseNode(), actual).diffs,
      "layout.padding.left",
    )!;
    expect(d.severity).toBe("medium");
  });

  it("flags a background color mismatch via Delta E", () => {
    const actual = structuredClone(baseNode());
    actual.appearance.background = { r: 0, g: 0, b: 0, a: 1 };
    const d = find(
      diffCanonicalNodes(baseNode(), actual).diffs,
      "appearance.background",
    )!;
    expect(d.status).toBe("mismatch");
    expect(d.unit).toBe("deltaE");
    expect(d.severity).toBe("high");
    expect(d.delta).toBeGreaterThan(95);
  });

  it("flags a 200-unit font-weight change as high", () => {
    const actual = structuredClone(baseNode());
    actual.typography!.fontWeight = 400;
    const d = find(
      diffCanonicalNodes(baseNode(), actual).diffs,
      "typography.fontWeight",
    )!;
    expect(d.severity).toBe("high");
    expect(d.delta).toBe(-200);
  });

  it("treats a within-tolerance delta as a match (no diff, still passes)", () => {
    const actual = structuredClone(baseNode());
    actual.geometry.box.height = 480.3; // < 0.5 default tolerance
    const report = diffCanonicalNodes(baseNode(), actual);
    expect(report.status).toBe("pass");
    expect(find(report.diffs, "geometry.box.height")).toBeUndefined();
  });

  it("records a property present in Figma but absent in the render as missing-actual", () => {
    const actual = structuredClone(baseNode());
    actual.typography!.color = null;
    const d = find(
      diffCanonicalNodes(baseNode(), actual).diffs,
      "typography.color",
    )!;
    expect(d.status).toBe("missing-actual");
    expect(d.severity).toBe("high");
  });

  it("computes normalized weighted difference and fidelity from the formula", () => {
    const actual = structuredClone(baseNode());
    actual.layout.padding.top = 29; // 5px -> medium (weight 3), the only mismatch
    const report = diffCanonicalNodes(baseNode(), actual);
    const expectedNormalized = (100 * 3) / (REGISTRY.length * 20);
    expect(report.metrics.weightedDifference).toBe(3);
    expect(report.metrics.normalizedWeightedDifference).toBeCloseTo(
      expectedNormalized,
      6,
    );
    expect(report.metrics.fidelityScore).toBeCloseTo(
      100 - expectedNormalized,
      6,
    );
  });

  it("honors a per-property tolerance override", () => {
    const actual = structuredClone(baseNode());
    actual.layout.padding.top = 30; // 6px
    const report = diffCanonicalNodes(baseNode(), actual, {
      tolerance: { "layout.padding.top": 10 },
    });
    expect(find(report.diffs, "layout.padding.top")).toBeUndefined();
    expect(report.status).toBe("pass");
  });
});
