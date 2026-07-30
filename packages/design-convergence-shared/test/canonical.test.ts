import { describe, expect, it } from "vitest";
import {
  canonicalStyleNodeSchema,
  type CanonicalStyleNode,
} from "../src/index.js";

function node(overrides: Record<string, unknown> = {}): unknown {
  return {
    designNodeId: "1:2",
    name: "Pricing Card / Pro",
    kind: "frame",
    geometry: {
      box: { x: 100, y: 200, width: 360, height: 480 },
      rootRelative: { x: 0, y: 0 },
    },
    layout: { padding: { top: 24, right: 24, bottom: 24, left: 24 } },
    appearance: {
      background: { r: 1, g: 1, b: 1, a: 1 },
      radius: { topLeft: 12, topRight: 12, bottomRight: 12, bottomLeft: 12 },
      borders: null,
      opacity: 1,
    },
    typography: null,
    ...overrides,
  };
}

describe("canonicalStyleNodeSchema", () => {
  it("accepts a node and applies array/layout defaults", () => {
    const parsed = canonicalStyleNodeSchema.parse(node());
    expect(parsed.absorbedNodeIds).toEqual([]);
    expect(parsed.unsupported).toEqual([]);
    expect(parsed.appearance.shadows).toEqual([]);
    expect(parsed.layout.direction).toBe("none");
    expect(parsed.layout.itemSpacing).toBeNull();
  });

  it("accepts a text node with typography", () => {
    const parsed = canonicalStyleNodeSchema.parse(
      node({
        kind: "text",
        typography: {
          fontFamily: ["Inter"],
          fontSize: 16,
          fontWeight: 600,
          lineHeight: 24,
          letterSpacing: 0,
          color: { r: 0, g: 0, b: 0, a: 1 },
        },
      }),
    );
    expect(parsed.typography?.fontWeight).toBe(600);
    expect(parsed.typography?.textAlign).toBeNull();
  });

  it("rejects an out-of-range color channel", () => {
    const bad = node({
      appearance: {
        background: { r: 2, g: 0, b: 0, a: 1 },
        radius: { topLeft: 0, topRight: 0, bottomRight: 0, bottomLeft: 0 },
        borders: null,
        opacity: 1,
      },
    });
    expect(canonicalStyleNodeSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects unknown keys", () => {
    expect(canonicalStyleNodeSchema.safeParse(node({ extra: 1 })).success).toBe(
      false,
    );
  });

  it("keeps unsupported records instead of dropping them", () => {
    const parsed = canonicalStyleNodeSchema.parse(
      node({
        unsupported: [
          { feature: "mesh-gradient", reason: "not representable in CSS" },
        ],
      }),
    );
    expect(parsed.unsupported).toHaveLength(1);
    expect(parsed.unsupported[0]!.feature).toBe("mesh-gradient");
  });
});
