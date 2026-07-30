import type {
  CanonicalColor,
  CanonicalStyleNode,
} from "@design-convergence/shared";
import type { Category } from "./types.js";

type Unit = "px" | "deltaE" | "ratio" | "weight";

interface NumberSpec {
  readonly property: string;
  readonly category: Exclude<Category, "color">;
  readonly unit: "px" | "ratio" | "weight";
  readonly kind: "number";
  readonly get: (node: CanonicalStyleNode) => number | null;
}

interface ColorSpec {
  readonly property: string;
  readonly category: "color";
  readonly unit: "deltaE";
  readonly kind: "color";
  readonly get: (node: CanonicalStyleNode) => CanonicalColor | null;
}

export type PropertySpec = NumberSpec | ColorSpec;
export type { Unit };

const num = (
  property: string,
  category: Exclude<Category, "color">,
  unit: "px" | "ratio" | "weight",
  get: (node: CanonicalStyleNode) => number | null,
): NumberSpec => ({ property, category, unit, kind: "number", get });

const color = (
  property: string,
  get: (node: CanonicalStyleNode) => CanonicalColor | null,
): ColorSpec => ({
  property,
  category: "color",
  unit: "deltaE",
  kind: "color",
  get,
});

/**
 * The fixed property registry the diff walks — never arbitrary object keys.
 * Covers the Phase 4 required mismatch set (height, four paddings, background,
 * four radii, font size/weight, text color, borders) plus width and opacity.
 */
export const REGISTRY: readonly PropertySpec[] = [
  num("geometry.box.width", "size", "px", (n) => n.geometry.box.width),
  num("geometry.box.height", "size", "px", (n) => n.geometry.box.height),

  num("layout.padding.top", "length", "px", (n) => n.layout.padding.top),
  num("layout.padding.right", "length", "px", (n) => n.layout.padding.right),
  num("layout.padding.bottom", "length", "px", (n) => n.layout.padding.bottom),
  num("layout.padding.left", "length", "px", (n) => n.layout.padding.left),
  num("layout.itemSpacing", "length", "px", (n) => n.layout.itemSpacing),

  color("appearance.background", (n) => n.appearance.background),
  num("appearance.opacity", "opacity", "ratio", (n) => n.appearance.opacity),

  num(
    "appearance.radius.topLeft",
    "length",
    "px",
    (n) => n.appearance.radius.topLeft,
  ),
  num(
    "appearance.radius.topRight",
    "length",
    "px",
    (n) => n.appearance.radius.topRight,
  ),
  num(
    "appearance.radius.bottomRight",
    "length",
    "px",
    (n) => n.appearance.radius.bottomRight,
  ),
  num(
    "appearance.radius.bottomLeft",
    "length",
    "px",
    (n) => n.appearance.radius.bottomLeft,
  ),

  num(
    "appearance.borders.top.width",
    "length",
    "px",
    (n) => n.appearance.borders?.top.width ?? null,
  ),
  num(
    "appearance.borders.right.width",
    "length",
    "px",
    (n) => n.appearance.borders?.right.width ?? null,
  ),
  num(
    "appearance.borders.bottom.width",
    "length",
    "px",
    (n) => n.appearance.borders?.bottom.width ?? null,
  ),
  num(
    "appearance.borders.left.width",
    "length",
    "px",
    (n) => n.appearance.borders?.left.width ?? null,
  ),

  num(
    "typography.fontSize",
    "length",
    "px",
    (n) => n.typography?.fontSize ?? null,
  ),
  num(
    "typography.fontWeight",
    "weight",
    "weight",
    (n) => n.typography?.fontWeight ?? null,
  ),
  num(
    "typography.lineHeight",
    "length",
    "px",
    (n) => n.typography?.lineHeight ?? null,
  ),
  num(
    "typography.letterSpacing",
    "length",
    "px",
    (n) => n.typography?.letterSpacing ?? null,
  ),
  color("typography.color", (n) => n.typography?.color ?? null),
];
