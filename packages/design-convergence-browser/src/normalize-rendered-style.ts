import {
  canonicalStyleNodeSchema,
  type CanonicalColor,
  type CanonicalStyleNode,
  type UnsupportedRecord,
} from "@design-convergence/shared";
import {
  parseCssColor,
  parseFontFamily,
  parseFontWeight,
  parseLengthPx,
} from "./parse-css.js";

/** Raw computed-style strings + layout box captured in the page, normalized here. */
export interface RenderedComputed {
  readonly paddingTop: string;
  readonly paddingRight: string;
  readonly paddingBottom: string;
  readonly paddingLeft: string;
  readonly display: string;
  readonly flexDirection: string;
  readonly rowGap: string;
  readonly overflow: string;
  readonly backgroundColor: string;
  readonly opacity: string;
  readonly borderTopLeftRadius: string;
  readonly borderTopRightRadius: string;
  readonly borderBottomRightRadius: string;
  readonly borderBottomLeftRadius: string;
  readonly borderTopWidth: string;
  readonly borderRightWidth: string;
  readonly borderBottomWidth: string;
  readonly borderLeftWidth: string;
  readonly borderTopStyle: string;
  readonly borderRightStyle: string;
  readonly borderBottomStyle: string;
  readonly borderLeftStyle: string;
  readonly borderTopColor: string;
  readonly borderRightColor: string;
  readonly borderBottomColor: string;
  readonly borderLeftColor: string;
  readonly fontFamily: string;
  readonly fontSize: string;
  readonly fontWeight: string;
  readonly lineHeight: string;
  readonly letterSpacing: string;
  readonly color: string;
  readonly textAlign: string;
}

export interface RenderedStyleCapture {
  readonly designNodeId: string;
  readonly name?: string;
  readonly box: { x: number; y: number; width: number; height: number };
  readonly rootRelative: { x: number; y: number };
  readonly hasText: boolean;
  readonly computed: RenderedComputed;
}

/**
 * Normalize a bounded raw browser capture into the canonical style node the
 * comparison engine diffs. Unrepresentable values are recorded in `unsupported`
 * rather than silently coerced. Runs outside the page context.
 */
export function normalizeRenderedStyle(
  capture: RenderedStyleCapture,
): CanonicalStyleNode {
  const c = capture.computed;
  const unsupported: UnsupportedRecord[] = [];

  const len = (raw: string, feature: string): number => {
    const v = parseLengthPx(raw);
    if (v === null) {
      unsupported.push({ feature, reason: `unparseable length: ${raw}` });
      return 0;
    }
    return v;
  };

  const color = (raw: string, feature: string): CanonicalColor | null => {
    const parsed = parseCssColor(raw);
    if (parsed.kind === "color") return parsed.value;
    if (parsed.kind === "none") return null;
    unsupported.push({ feature, reason: `unsupported color: ${parsed.raw}` });
    return null;
  };

  const widths = {
    top: len(c.borderTopWidth, "borders.top.width"),
    right: len(c.borderRightWidth, "borders.right.width"),
    bottom: len(c.borderBottomWidth, "borders.bottom.width"),
    left: len(c.borderLeftWidth, "borders.left.width"),
  };
  const hasBorder =
    widths.top > 0 || widths.right > 0 || widths.bottom > 0 || widths.left > 0;
  const borders = hasBorder
    ? {
        top: {
          width: widths.top,
          style: c.borderTopStyle,
          color: color(c.borderTopColor, "borders.top.color"),
        },
        right: {
          width: widths.right,
          style: c.borderRightStyle,
          color: color(c.borderRightColor, "borders.right.color"),
        },
        bottom: {
          width: widths.bottom,
          style: c.borderBottomStyle,
          color: color(c.borderBottomColor, "borders.bottom.color"),
        },
        left: {
          width: widths.left,
          style: c.borderLeftStyle,
          color: color(c.borderLeftColor, "borders.left.color"),
        },
      }
    : null;

  const opacityNum = Number.parseFloat(c.opacity);
  const opacity = Number.isFinite(opacityNum)
    ? Math.min(1, Math.max(0, opacityNum))
    : (unsupported.push({
        feature: "opacity",
        reason: `unparseable: ${c.opacity}`,
      }),
      1);

  const isFlex = c.display.includes("flex");
  const direction = isFlex
    ? c.flexDirection.startsWith("column")
      ? "vertical"
      : "horizontal"
    : "none";
  const itemSpacing =
    c.rowGap.trim() === "normal" ? null : parseLengthPx(c.rowGap);

  const typography = capture.hasText
    ? {
        fontFamily: parseFontFamily(c.fontFamily),
        fontSize: len(c.fontSize, "typography.fontSize") || 1,
        fontWeight:
          parseFontWeight(c.fontWeight) ??
          (unsupported.push({
            feature: "typography.fontWeight",
            reason: c.fontWeight,
          }),
          400),
        lineHeight:
          c.lineHeight.trim() === "normal" ? null : parseLengthPx(c.lineHeight),
        letterSpacing:
          c.letterSpacing.trim() === "normal"
            ? 0
            : (parseLengthPx(c.letterSpacing) ?? 0),
        color: color(c.color, "typography.color"),
        textAlign: c.textAlign || null,
      }
    : null;

  const node: CanonicalStyleNode = {
    designNodeId: capture.designNodeId,
    name: capture.name ?? capture.designNodeId,
    kind: "browser-element",
    geometry: { box: capture.box, rootRelative: capture.rootRelative },
    layout: {
      padding: {
        top: len(c.paddingTop, "padding.top"),
        right: len(c.paddingRight, "padding.right"),
        bottom: len(c.paddingBottom, "padding.bottom"),
        left: len(c.paddingLeft, "padding.left"),
      },
      direction,
      itemSpacing,
      overflow: c.overflow || null,
    },
    appearance: {
      background: color(c.backgroundColor, "background"),
      radius: {
        topLeft: len(c.borderTopLeftRadius, "radius.topLeft"),
        topRight: len(c.borderTopRightRadius, "radius.topRight"),
        bottomRight: len(c.borderBottomRightRadius, "radius.bottomRight"),
        bottomLeft: len(c.borderBottomLeftRadius, "radius.bottomLeft"),
      },
      borders,
      opacity,
      shadows: [],
    },
    typography,
    absorbedNodeIds: [],
    unsupported,
    approximations: [],
  };

  // Validate the shape we hand to the comparison engine.
  return canonicalStyleNodeSchema.parse(node);
}
