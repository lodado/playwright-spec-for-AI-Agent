import { z } from "zod";
import { provenanceSchema } from "./provenance.js";

export const SCHEMA_VERSION = 1 as const;

/**
 * Every stored artifact is wrapped in this envelope: a fixed schema version,
 * provenance, and a payload validated by a phase-specific schema. Unknown
 * top-level keys are rejected so a stale or tampered artifact fails loudly.
 *
 * Per-artifact payload schemas (CanonicalStyleNode, DesignBinding, StyleDiff,
 * RuntimeBindingValidation, DiffMetrics, PatchVerificationResult) are added to
 * this package by the phase that first produces them, not up front.
 */
export function envelope<T extends z.ZodTypeAny>(payload: T) {
  return z
    .object({
      schemaVersion: z.literal(SCHEMA_VERSION),
      provenance: provenanceSchema,
      payload,
    })
    .strict();
}

export type Envelope<T> = {
  schemaVersion: typeof SCHEMA_VERSION;
  provenance: z.infer<typeof provenanceSchema>;
  payload: T;
};
