import type { Category, Severity } from "./types.js";

/** Default per-category tolerance (px for lengths/size, ΔE for color, ratio/weight). */
export const DEFAULT_TOLERANCE: Record<Category, number> = {
  size: 0.5,
  length: 0.5,
  color: 1.0,
  opacity: 0.01,
  weight: 0,
};

function lengthSeverity(abs: number): Severity {
  if (abs > 8) return "high";
  if (abs >= 3) return "medium";
  return abs > 0 ? "low" : "info";
}

/**
 * Map an absolute/relative delta to a severity using the specification's default
 * thresholds. Size uses a >20% relative override → critical; lengths use the
 * 3px/8px bands; color/opacity/weight have their own bands.
 */
export function severityFor(
  category: Category,
  delta: number,
  expected: number,
): Severity {
  const abs = Math.abs(delta);
  switch (category) {
    case "size": {
      const percent =
        expected !== 0 ? (abs / Math.abs(expected)) * 100 : Infinity;
      if (percent > 20) return "critical";
      return lengthSeverity(abs);
    }
    case "length":
      return lengthSeverity(abs);
    case "color":
      if (abs >= 11) return "high";
      if (abs >= 3) return "medium";
      return abs > 0 ? "low" : "info";
    case "opacity":
      if (abs > 0.2) return "high";
      if (abs > 0.05) return "medium";
      return abs > 0 ? "low" : "info";
    case "weight":
      if (abs >= 200) return "high";
      if (abs >= 100) return "medium";
      return abs > 0 ? "low" : "info";
  }
}
