import type {
  CanonicalColor,
  CanonicalStyleNode,
} from "@design-convergence/shared";
import { colorDeltaE } from "./color.js";
import { computeMetrics } from "./metrics.js";
import { REGISTRY, type PropertySpec } from "./registry.js";
import { DEFAULT_TOLERANCE, severityFor } from "./severity.js";
import {
  DEFAULT_BLOCKING,
  DEFAULT_WEIGHTS,
  type CompareOptions,
  type ComparisonReport,
  type StyleDiff,
} from "./types.js";

const round = (x: number): number => Math.round(x * 1000) / 1000;

function rgbaString(c: CanonicalColor): string {
  const to255 = (x: number): number => Math.round(x * 255);
  return `rgba(${to255(c.r)}, ${to255(c.g)}, ${to255(c.b)}, ${Number(c.a.toFixed(3))})`;
}

function toleranceFor(spec: PropertySpec, options: CompareOptions): number {
  return (
    options.tolerance?.[spec.property] ??
    options.tolerance?.[spec.category] ??
    DEFAULT_TOLERANCE[spec.category]
  );
}

function compareProperty(
  spec: PropertySpec,
  expected: CanonicalStyleNode,
  actual: CanonicalStyleNode,
  options: CompareOptions,
): StyleDiff {
  const tolerance = toleranceFor(spec, options);
  const base = {
    schemaVersion: 1 as const,
    property: spec.property,
    category: spec.category,
    unit: spec.unit,
    tolerance,
  };

  if (spec.kind === "color") {
    const e = spec.get(expected);
    const a = spec.get(actual);
    if (e === null && a === null)
      return {
        ...base,
        status: "match",
        expected: null,
        actual: null,
        delta: 0,
        severity: "info",
      };
    if (e !== null && a === null)
      return {
        ...base,
        status: "missing-actual",
        expected: rgbaString(e),
        actual: null,
        delta: null,
        severity: "high",
      };
    if (e === null && a !== null)
      return {
        ...base,
        status: "missing-expected",
        expected: null,
        actual: rgbaString(a),
        delta: null,
        severity: "info",
      };
    const dE = colorDeltaE(e!, a!);
    const matched = dE <= tolerance;
    return {
      ...base,
      status: matched ? "match" : "mismatch",
      expected: rgbaString(e!),
      actual: rgbaString(a!),
      delta: round(dE),
      severity: matched ? "info" : severityFor("color", dE, 0),
    };
  }

  const e = spec.get(expected);
  const a = spec.get(actual);
  if (e === null && a === null)
    return {
      ...base,
      status: "match",
      expected: null,
      actual: null,
      delta: 0,
      severity: "info",
    };
  if (e !== null && a === null)
    return {
      ...base,
      status: "missing-actual",
      expected: e,
      actual: null,
      delta: null,
      severity: "high",
    };
  if (e === null && a !== null)
    return {
      ...base,
      status: "missing-expected",
      expected: null,
      actual: a,
      delta: null,
      severity: "info",
    };
  if (!Number.isFinite(e!) || !Number.isFinite(a!))
    return {
      ...base,
      status: "unsupported",
      expected: Number.isFinite(e!) ? e : null,
      actual: Number.isFinite(a!) ? a : null,
      delta: null,
      severity: "info",
    };

  const delta = a! - e!;
  const matched = Math.abs(delta) <= tolerance;
  return {
    ...base,
    status: matched ? "match" : "mismatch",
    expected: e!,
    actual: a!,
    delta: round(delta),
    severity: matched ? "info" : severityFor(spec.category, delta, e!),
  };
}

/**
 * Deterministically diff two canonical style nodes (expected = Figma,
 * actual = browser) over the fixed property registry. Emits only non-matching
 * or unsupported records; pass/fail comes from configured blocking severities,
 * never from the fidelity score. AI is not in this code path.
 */
export function diffCanonicalNodes(
  expected: CanonicalStyleNode,
  actual: CanonicalStyleNode,
  options: CompareOptions = {},
): ComparisonReport {
  const weights = options.severityWeights ?? DEFAULT_WEIGHTS;
  const blocking = new Set(options.blockingSeverities ?? DEFAULT_BLOCKING);

  const records = REGISTRY.map((spec) =>
    compareProperty(spec, expected, actual, options),
  );
  const metrics = computeMetrics(records, weights);
  const status = records.some((r) => blocking.has(r.severity))
    ? "fail"
    : "pass";
  const diffs = records.filter((r) => r.status !== "match");

  return { schemaVersion: 1, status, diffs, metrics };
}
