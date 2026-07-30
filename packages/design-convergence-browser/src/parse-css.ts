import type { CanonicalColor } from "@design-convergence/shared";

/**
 * A parsed CSS color. `none` is a legitimate absence (transparent / alpha 0);
 * `unsupported` is a value we cannot represent as a plain color (gradients,
 * currentColor) and must be recorded, never silently treated as equal.
 */
export type ColorParse =
  | { readonly kind: "color"; readonly value: CanonicalColor }
  | { readonly kind: "none" }
  | { readonly kind: "unsupported"; readonly raw: string };

/** Parse a finite CSS pixel or unitless length; null when unparseable. */
export function parseLengthPx(input: string): number | null {
  const s = input.trim();
  const px = s.match(/^(-?\d*\.?\d+)px$/);
  if (px) return Number.parseFloat(px[1]!);
  const unitless = s.match(/^(-?\d*\.?\d+)$/);
  if (unitless) return Number.parseFloat(unitless[1]!);
  return null;
}

const hexChannel = (h: string): number => Number.parseInt(h, 16) / 255;

/** Parse `rgb()/rgba()/#hex/transparent`; other forms are `unsupported`. */
export function parseCssColor(input: string): ColorParse {
  const s = input.trim().toLowerCase();
  if (s === "transparent" || s === "none" || s === "") return { kind: "none" };

  const rgb = s.match(/^rgba?\(([^)]+)\)$/);
  if (rgb) {
    const parts = rgb[1]!.split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return { kind: "unsupported", raw: input };
    const [r, g, b] = parts;
    const a = parts[3];
    const value: CanonicalColor = {
      r: Number.parseFloat(r!) / 255,
      g: Number.parseFloat(g!) / 255,
      b: Number.parseFloat(b!) / 255,
      a: a === undefined ? 1 : Number.parseFloat(a),
    };
    if (![value.r, value.g, value.b, value.a].every(Number.isFinite))
      return { kind: "unsupported", raw: input };
    return value.a === 0 ? { kind: "none" } : { kind: "color", value };
  }

  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1]!;
    let rr: string,
      gg: string,
      bb: string,
      aa = "ff";
    if (h.length === 3 || h.length === 4) {
      rr = h[0]! + h[0]!;
      gg = h[1]! + h[1]!;
      bb = h[2]! + h[2]!;
      if (h.length === 4) aa = h[3]! + h[3]!;
    } else if (h.length === 6 || h.length === 8) {
      rr = h.slice(0, 2);
      gg = h.slice(2, 4);
      bb = h.slice(4, 6);
      if (h.length === 8) aa = h.slice(6, 8);
    } else {
      return { kind: "unsupported", raw: input };
    }
    const value: CanonicalColor = {
      r: hexChannel(rr),
      g: hexChannel(gg),
      b: hexChannel(bb),
      a: hexChannel(aa),
    };
    return value.a === 0 ? { kind: "none" } : { kind: "color", value };
  }

  return { kind: "unsupported", raw: input };
}

/** Ordered font-family list with quotes stripped; never empty. */
export function parseFontFamily(input: string): string[] {
  const families = input
    .split(",")
    .map((f) => f.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean);
  return families.length > 0 ? families : ["sans-serif"];
}

/** CSS font-weight keyword/number to a numeric weight. */
export function parseFontWeight(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (s === "normal") return 400;
  if (s === "bold") return 700;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}
