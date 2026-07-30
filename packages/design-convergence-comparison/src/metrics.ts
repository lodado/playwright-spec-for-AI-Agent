import type { ComparisonMetrics, SeverityWeights, StyleDiff } from "./types.js";

/**
 * Aggregate per-property records into the comparison metrics.
 *
 * - `comparedPropertyCount` excludes unsupported properties (they are counted
 *   separately but must not dilute the denominator).
 * - `weightedDifference = Σ severityWeight` (match/unsupported are `info` = 0).
 * - `normalizedWeightedDifference = 100 × wd / (compared × criticalWeight)`.
 * - `fidelityScore = max(0, 100 − normalized)` — a project-relative QA metric,
 *   never a universal visual-quality score. Pass/fail is decided from blocking
 *   severities elsewhere, not from this score.
 */
export function computeMetrics(
  records: readonly StyleDiff[],
  weights: SeverityWeights,
): ComparisonMetrics {
  const compared = records.filter((r) => r.status !== "unsupported").length;
  const unsupportedCount = records.length - compared;
  const weightedDifference = records.reduce(
    (sum, r) => sum + weights[r.severity],
    0,
  );
  const critical = weights.critical || 1; // guard a misconfigured zero weight
  const normalizedWeightedDifference =
    compared === 0 ? 0 : (100 * weightedDifference) / (compared * critical);
  const fidelityScore = Math.max(0, 100 - normalizedWeightedDifference);
  const remainingHighCritical = records.filter(
    (r) => r.severity === "high" || r.severity === "critical",
  ).length;

  return {
    comparedPropertyCount: compared,
    unsupportedCount,
    weightedDifference,
    normalizedWeightedDifference,
    fidelityScore,
    remainingHighCritical,
  };
}
