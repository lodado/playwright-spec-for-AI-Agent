import {
  canonicalStyleNodeSchema,
  DesignConvergenceError,
  type CanonicalColor,
  type CanonicalStyleNode,
  type UnsupportedRecord,
} from "@design-convergence/shared";
import type {
  FigmaRawColor,
  FigmaRawNode,
  FigmaRawPaint,
} from "./raw-schema.js";

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function rawColor(color: FigmaRawColor, alphaScale = 1): CanonicalColor {
  return {
    r: clamp01(color.r),
    g: clamp01(color.g),
    b: clamp01(color.b),
    a: clamp01((color.a ?? 1) * alphaScale),
  };
}

/** Topmost visible SOLID paint, or null. Non-solid paints are recorded unsupported. */
function pickSolidColor(
  paints: FigmaRawPaint[] | undefined,
  unsupported: UnsupportedRecord[],
  context: string,
): CanonicalColor | null {
  let picked: CanonicalColor | null = null;
  for (const paint of paints ?? []) {
    if (paint.visible === false) continue;
    if (paint.type === "SOLID" && paint.color) {
      picked = rawColor(paint.color, paint.opacity ?? 1);
    } else if (paint.type !== "SOLID") {
      unsupported.push({
        feature: `${context}:${paint.type}`,
        reason: "non-solid paint is not represented as a canonical color",
      });
    }
  }
  return picked;
}

function normalizeCorners(
  node: FigmaRawNode,
): CanonicalStyleNode["appearance"]["radius"] {
  const radii = node.rectangleCornerRadii;
  if (radii && radii.length === 4) {
    return {
      topLeft: radii[0]!,
      topRight: radii[1]!,
      bottomRight: radii[2]!,
      bottomLeft: radii[3]!,
    };
  }
  const r = node.cornerRadius ?? 0;
  return { topLeft: r, topRight: r, bottomRight: r, bottomLeft: r };
}

function normalizeBorders(
  node: FigmaRawNode,
  unsupported: UnsupportedRecord[],
): CanonicalStyleNode["appearance"]["borders"] {
  const width = node.strokeWeight ?? 0;
  const color = pickSolidColor(node.strokes, unsupported, "stroke");
  if (width <= 0 || color === null) return null;
  const side = { width, style: "solid", color };
  return {
    top: side,
    right: { ...side },
    bottom: { ...side },
    left: { ...side },
  };
}

function normalizeShadows(
  node: FigmaRawNode,
  unsupported: UnsupportedRecord[],
): CanonicalStyleNode["appearance"]["shadows"] {
  const shadows: CanonicalStyleNode["appearance"]["shadows"] = [];
  for (const effect of node.effects ?? []) {
    if (effect.visible === false) continue;
    if (effect.type === "DROP_SHADOW" || effect.type === "INNER_SHADOW") {
      shadows.push({
        inset: effect.type === "INNER_SHADOW",
        offsetX: effect.offset?.x ?? 0,
        offsetY: effect.offset?.y ?? 0,
        blur: effect.radius ?? 0,
        spread: effect.spread ?? 0,
        color: effect.color
          ? rawColor(effect.color)
          : { r: 0, g: 0, b: 0, a: 1 },
        approximation: false,
      });
    } else {
      unsupported.push({
        feature: `effect:${effect.type}`,
        reason: "effect is not represented in the canonical shadow model",
      });
    }
  }
  return shadows;
}

function normalizeLayout(node: FigmaRawNode): CanonicalStyleNode["layout"] {
  const direction =
    node.layoutMode === "HORIZONTAL"
      ? "horizontal"
      : node.layoutMode === "VERTICAL"
        ? "vertical"
        : "none";
  return {
    padding: {
      top: node.paddingTop ?? 0,
      right: node.paddingRight ?? 0,
      bottom: node.paddingBottom ?? 0,
      left: node.paddingLeft ?? 0,
    },
    direction,
    itemSpacing: node.itemSpacing ?? null,
    overflow:
      node.clipsContent === true
        ? "hidden"
        : node.clipsContent === false
          ? "visible"
          : null,
  };
}

function normalizeTypography(
  node: FigmaRawNode,
  unsupported: UnsupportedRecord[],
): CanonicalStyleNode["typography"] {
  if (node.type !== "TEXT" || !node.style) return null;
  const style = node.style;
  return {
    fontFamily: style.fontFamily ? [style.fontFamily] : ["sans-serif"],
    fontSize: style.fontSize ?? 16,
    fontWeight: style.fontWeight ?? 400,
    lineHeight: style.lineHeightPx ?? null,
    letterSpacing: style.letterSpacing ?? 0,
    color: pickSolidColor(node.fills, unsupported, "text-fill"),
    textAlign: style.textAlignHorizontal
      ? style.textAlignHorizontal.toLowerCase()
      : null,
  };
}

/**
 * Normalize one Figma node into a CanonicalStyleNode. `root` supplies the
 * comparison-root box so geometry is expressed both absolutely and relative to
 * the root. The result is validated against the canonical schema so a missing
 * or malformed field fails loudly rather than diffing as "equal".
 */
export function normalizeNode(
  node: FigmaRawNode,
  root: FigmaRawNode,
): CanonicalStyleNode {
  const box = node.absoluteBoundingBox;
  if (!box) {
    throw new DesignConvergenceError(
      "normalization",
      `node ${node.id} has no bounding box`,
      {
        nodeId: node.id,
      },
    );
  }
  const rootBox = root.absoluteBoundingBox ?? box;
  const unsupported: UnsupportedRecord[] = [];

  const result = {
    designNodeId: node.id,
    name: node.name,
    kind: node.type.toLowerCase(),
    geometry: {
      box: { x: box.x, y: box.y, width: box.width, height: box.height },
      rootRelative: { x: box.x - rootBox.x, y: box.y - rootBox.y },
    },
    layout: normalizeLayout(node),
    appearance: {
      background: pickSolidColor(node.fills, unsupported, "fill"),
      radius: normalizeCorners(node),
      borders: normalizeBorders(node, unsupported),
      opacity: node.opacity ?? 1,
      shadows: normalizeShadows(node, unsupported),
    },
    typography: normalizeTypography(node, unsupported),
    absorbedNodeIds: [],
    unsupported,
    approximations: [],
  };

  return canonicalStyleNodeSchema.parse(result);
}
