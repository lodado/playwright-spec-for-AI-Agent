import { z } from "zod";

export const sourceRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    startColumn: z.number().int().nonnegative(),
    endLine: z.number().int().positive(),
    endColumn: z.number().int().nonnegative(),
  })
  .strict();
export type SourceRange = z.infer<typeof sourceRangeSchema>;

/**
 * A binding status is never `validated` on authorship. Manual and AI bindings
 * both start `proposed`/`review-required` and are promoted only after static
 * and runtime validation both pass (Phases 3-5).
 */
export const bindingStatusSchema = z.enum([
  "proposed",
  "review-required",
  "validated",
  "rejected",
]);
export type BindingStatus = z.infer<typeof bindingStatusSchema>;

/**
 * v0.1 supports `intrinsic-jsx-element` targets first; `component-root` support
 * arrives in Phase 5 once the React index exists. `sourceHash` pins the file
 * content at binding time so a moved/edited target is caught as stale.
 */
export const bindingTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("intrinsic-jsx-element"),
      filePath: z.string().min(1),
      elementName: z.string().min(1),
      occurrence: z.number().int().nonnegative(),
      sourceRange: sourceRangeSchema,
      sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    })
    .strict(),
  z
    .object({
      kind: z.literal("component-root"),
      filePath: z.string().min(1),
      componentName: z.string().min(1),
      occurrence: z.number().int().nonnegative(),
      sourceRange: sourceRangeSchema,
      sourceHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    })
    .strict(),
]);
export type BindingTarget = z.infer<typeof bindingTargetSchema>;

export const designBindingSchema = z
  .object({
    id: z.string().min(1),
    caseIds: z.array(z.string().min(1)).min(1),
    figma: z
      .object({ fileKey: z.string().min(1), nodeId: z.string().min(1) })
      .strict(),
    target: bindingTargetSchema,
    runtime: z
      .object({
        attributeName: z.string().regex(/^data-[a-z0-9]+(?:-[a-z0-9]+)*$/),
        attributeValue: z.string().min(1),
      })
      .strict(),
    status: bindingStatusSchema,
    absorbedNodeIds: z.array(z.string()).default([]),
    evidence: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();
export type DesignBinding = z.infer<typeof designBindingSchema>;

/** The on-disk `design-bindings.json` shape: a versioned wrapper over bindings. */
export const designBindingsFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    bindings: z.array(designBindingSchema),
  })
  .strict();
export type DesignBindingsFile = z.infer<typeof designBindingsFileSchema>;
