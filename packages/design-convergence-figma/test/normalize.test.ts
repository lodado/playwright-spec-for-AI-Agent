import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import {
  findNode,
  getRootNode,
  loadFigmaFixture,
  normalizeNode,
} from "../src/index.js";

const fixture = (name: string): string =>
  fileURLToPath(
    new URL(
      `../../../fixtures/design-convergence/figma/${name}`,
      import.meta.url,
    ),
  );

function pricingRoot() {
  const response = loadFigmaFixture(fixture("pricing-card.raw.json"));
  return getRootNode(response, "1:2");
}

describe("normalizeNode: pricing card root frame", () => {
  it("normalizes geometry, layout, and appearance for the first vertical slice", () => {
    const root = pricingRoot();
    const node = normalizeNode(root, root);

    expect(node.designNodeId).toBe("1:2");
    expect(node.kind).toBe("frame");
    expect(node.geometry.box.height).toBe(480);
    expect(node.geometry.rootRelative).toEqual({ x: 0, y: 0 });
    expect(node.layout.padding).toEqual({
      top: 24,
      right: 24,
      bottom: 24,
      left: 24,
    });
    expect(node.layout.direction).toBe("vertical");
    expect(node.appearance.background).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(node.appearance.radius).toEqual({
      topLeft: 12,
      topRight: 12,
      bottomRight: 12,
      bottomLeft: 12,
    });
    expect(node.appearance.borders?.top.width).toBe(1);
    expect(node.appearance.borders?.top.color).toEqual({
      r: 0.9,
      g: 0.9,
      b: 0.9,
      a: 1,
    });
    expect(node.appearance.shadows).toHaveLength(1);
    expect(node.appearance.shadows[0]).toMatchObject({
      offsetY: 4,
      blur: 12,
      inset: false,
    });
    expect(node.typography).toBeNull();
  });
});

describe("normalizeNode: text node", () => {
  it("normalizes typography from a Figma text style", () => {
    const root = pricingRoot();
    const price = findNode(root, "1:4")!;
    const node = normalizeNode(price, root);

    expect(node.kind).toBe("text");
    expect(node.typography).toMatchObject({
      fontFamily: ["Inter"],
      fontSize: 48,
      fontWeight: 700,
      lineHeight: 56,
      letterSpacing: -0.5,
    });
    expect(node.typography?.color).toEqual({ r: 0.06, g: 0.06, b: 0.06, a: 1 });
    // Text sits 72px below the card top (272 - 200).
    expect(node.geometry.rootRelative.y).toBe(72);
  });
});

describe("normalizeNode: unsupported features", () => {
  it("records unsupported paints/effects instead of silently dropping them", () => {
    const response = loadFigmaFixture(
      fixture("pricing-card.unsupported.raw.json"),
    );
    const root = getRootNode(response, "2:1");
    const node = normalizeNode(root, root);

    // A gradient-mesh fill cannot become a canonical color; background stays null
    // and the feature is recorded, not treated as "equal".
    expect(node.appearance.background).toBeNull();
    const features = node.unsupported.map((u) => u.feature);
    expect(features).toContain("fill:GRADIENT_MESH");
    expect(features).toContain("effect:LAYER_BLUR");
  });
});
