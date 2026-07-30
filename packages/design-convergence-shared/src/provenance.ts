import { z } from "zod";

export const SOURCE_KINDS = [
  "fixture",
  "figma-rest",
  "browser",
  "manual",
  "generated",
] as const;

export type SourceKind = (typeof SOURCE_KINDS)[number];

export const sourceKindSchema = z.enum(SOURCE_KINDS);

/**
 * Git commit is either a real revision or an explicit "unavailable" with a
 * reason. We never store an empty string and pretend it is a commit.
 */
export const gitRefSchema = z.discriminatedUnion("available", [
  z
    .object({
      available: z.literal(true),
      commit: z.string().regex(/^[0-9a-f]{7,40}$/),
    })
    .strict(),
  z
    .object({
      available: z.literal(false),
      reason: z.string().min(1),
    })
    .strict(),
]);

export type GitRef = z.infer<typeof gitRefSchema>;

/**
 * Minimal provenance attached to every stored artifact. `schemaVersion` lives on
 * the envelope, not here, so it is not duplicated per payload.
 */
export const provenanceSchema = z
  .object({
    createdAt: z.string().datetime(),
    toolVersion: z.string().min(1),
    configHash: z.string().min(1),
    git: gitRefSchema,
    sourceKind: sourceKindSchema,
  })
  .strict();

export type Provenance = z.infer<typeof provenanceSchema>;

export function buildProvenance(input: Provenance): Provenance {
  return provenanceSchema.parse(input);
}
