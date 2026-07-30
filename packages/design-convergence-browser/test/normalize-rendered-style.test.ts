import { describe, expect, it } from "vitest";
import {
  normalizeRenderedStyle,
  type RenderedComputed,
  type RenderedStyleCapture,
} from "../src/normalize-rendered-style.js";

const BASE_COMPUTED: RenderedComputed = {
  paddingTop: "24px",
  paddingRight: "24px",
  paddingBottom: "24px",
  paddingLeft: "24px",
  display: "flex",
  flexDirection: "column",
  rowGap: "8px",
  overflow: "visible",
  backgroundColor: "rgb(255, 255, 255)",
  opacity: "1",
  borderTopLeftRadius: "8px",
  borderTopRightRadius: "8px",
  borderBottomRightRadius: "8px",
  borderBottomLeftRadius: "8px",
  borderTopWidth: "0px",
  borderRightWidth: "0px",
  borderBottomWidth: "0px",
  borderLeftWidth: "0px",
  borderTopStyle: "none",
  borderRightStyle: "none",
  borderBottomStyle: "none",
  borderLeftStyle: "none",
  borderTopColor: "rgb(0, 0, 0)",
  borderRightColor: "rgb(0, 0, 0)",
  borderBottomColor: "rgb(0, 0, 0)",
  borderLeftColor: "rgb(0, 0, 0)",
  fontFamily: "Inter, sans-serif",
  fontSize: "16px",
  fontWeight: "600",
  lineHeight: "24px",
  letterSpacing: "normal",
  color: "rgb(0, 0, 0)",
  textAlign: "left",
};

function capture(
  overrides: Partial<RenderedComputed> = {},
  rest: Partial<RenderedStyleCapture> = {},
): RenderedStyleCapture {
  return {
    designNodeId: "1:2",
    box: { x: 0, y: 0, width: 320, height: 480 },
    rootRelative: { x: 0, y: 0 },
    hasText: true,
    computed: { ...BASE_COMPUTED, ...overrides },
    ...rest,
  };
}

describe("normalizeRenderedStyle", () => {
  it("normalizes a well-formed capture into a canonical node", () => {
    const n = normalizeRenderedStyle(capture());
    expect(n.geometry.box).toEqual({ x: 0, y: 0, width: 320, height: 480 });
    expect(n.layout.padding).toEqual({
      top: 24,
      right: 24,
      bottom: 24,
      left: 24,
    });
    expect(n.layout.direction).toBe("vertical");
    expect(n.layout.itemSpacing).toBe(8);
    expect(n.appearance.background).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(n.appearance.radius).toEqual({
      topLeft: 8,
      topRight: 8,
      bottomRight: 8,
      bottomLeft: 8,
    });
    expect(n.appearance.borders).toBeNull();
    expect(n.appearance.opacity).toBe(1);
    expect(n.typography?.fontSize).toBe(16);
    expect(n.typography?.fontWeight).toBe(600);
    expect(n.typography?.color).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(n.typography?.lineHeight).toBe(24);
    expect(n.typography?.letterSpacing).toBe(0);
    expect(n.unsupported).toEqual([]);
  });

  it("treats a transparent background as no background, not a color", () => {
    expect(
      normalizeRenderedStyle(capture({ backgroundColor: "rgba(0, 0, 0, 0)" }))
        .appearance.background,
    ).toBeNull();
    expect(
      normalizeRenderedStyle(capture({ backgroundColor: "transparent" }))
        .appearance.background,
    ).toBeNull();
  });

  it("records a gradient background as unsupported instead of coercing it", () => {
    const n = normalizeRenderedStyle(
      capture({ backgroundColor: "linear-gradient(0deg, #fff, #000)" }),
    );
    expect(n.appearance.background).toBeNull();
    expect(n.unsupported).toContainEqual(
      expect.objectContaining({ feature: "background" }),
    );
  });

  it("builds a border only when a side has non-zero width", () => {
    const n = normalizeRenderedStyle(
      capture({
        borderTopWidth: "2px",
        borderTopStyle: "solid",
        borderTopColor: "rgb(10, 20, 30)",
      }),
    );
    expect(n.appearance.borders?.top).toEqual({
      width: 2,
      style: "solid",
      color: { r: 10 / 255, g: 20 / 255, b: 30 / 255, a: 1 },
    });
  });

  it("yields null typography for a node with no text", () => {
    expect(
      normalizeRenderedStyle(capture({}, { hasText: false })).typography,
    ).toBeNull();
  });

  it("maps line-height 'normal' to null and letter-spacing 'normal' to 0", () => {
    const n = normalizeRenderedStyle(
      capture({ lineHeight: "normal", letterSpacing: "normal" }),
    );
    expect(n.typography?.lineHeight).toBeNull();
    expect(n.typography?.letterSpacing).toBe(0);
  });

  it("parses #rrggbb hex colors", () => {
    const n = normalizeRenderedStyle(capture({ backgroundColor: "#ffffff" }));
    expect(n.appearance.background).toEqual({ r: 1, g: 1, b: 1, a: 1 });
  });
});
