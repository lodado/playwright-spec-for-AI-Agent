import { z } from "zod";

export const SEVERITIES = [
  "info",
  "low",
  "medium",
  "high",
  "critical",
] as const;
export type Severity = (typeof SEVERITIES)[number];

export const CATEGORIES = [
  "size",
  "length",
  "color",
  "opacity",
  "weight",
] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * A single property comparison. `acknowledged` is a reserved schema slot for a
 * future triage/baseline workflow — no v0.1 code produces it — so a known
 * mismatch can be marked without a schema migration. This is triage, not the
 * forbidden "raise tolerance to hide failure".
 */
export const STATUSES = [
  "match",
  "mismatch",
  "unsupported",
  "missing-expected",
  "missing-actual",
  "acknowledged",
] as const;
export type DiffStatus = (typeof STATUSES)[number];

export const styleDiffSchema = z
  .object({
    schemaVersion: z.literal(1),
    property: z.string().min(1),
    category: z.enum(CATEGORIES),
    status: z.enum(STATUSES),
    expected: z.union([z.number(), z.string(), z.null()]),
    actual: z.union([z.number(), z.string(), z.null()]),
    delta: z.number().nullable(),
    unit: z.enum(["px", "deltaE", "ratio", "weight"]).nullable(),
    tolerance: z.number(),
    severity: z.enum(SEVERITIES),
  })
  .strict();
export type StyleDiff = z.infer<typeof styleDiffSchema>;

export const comparisonMetricsSchema = z
  .object({
    comparedPropertyCount: z.number().int().nonnegative(),
    unsupportedCount: z.number().int().nonnegative(),
    weightedDifference: z.number().nonnegative(),
    normalizedWeightedDifference: z.number().nonnegative(),
    fidelityScore: z.number(),
    remainingHighCritical: z.number().int().nonnegative(),
  })
  .strict();
export type ComparisonMetrics = z.infer<typeof comparisonMetricsSchema>;

export const comparisonReportSchema = z
  .object({
    schemaVersion: z.literal(1),
    status: z.enum(["pass", "fail"]),
    diffs: z.array(styleDiffSchema),
    metrics: comparisonMetricsSchema,
  })
  .strict();
export type ComparisonReport = z.infer<typeof comparisonReportSchema>;

export interface SeverityWeights {
  readonly info: number;
  readonly low: number;
  readonly medium: number;
  readonly high: number;
  readonly critical: number;
}

export const DEFAULT_WEIGHTS: SeverityWeights = {
  info: 0,
  low: 1,
  medium: 3,
  high: 8,
  critical: 20,
};

export const DEFAULT_BLOCKING: readonly Severity[] = ["high", "critical"];

export interface CompareOptions {
  /** Tolerance override by property path or by category; falls back to defaults. */
  readonly tolerance?: Readonly<Record<string, number>>;
  readonly severityWeights?: SeverityWeights;
  readonly blockingSeverities?: readonly Severity[];
}
