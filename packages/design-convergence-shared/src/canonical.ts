import { z } from "zod";

/**
 * The canonical, framework-neutral shape both a Figma node and a browser
 * element are normalized into before diffing. Colors are stored as 0..1 RGBA
 * (Figma-native; browser rgb() is divided down) and lengths as CSS pixels.
 *
 * A value that cannot be represented is recorded in `unsupported`, never
 * silently dropped to undefined and treated as equal. Approximate conversions
 * are named in `approximations`.
 */

export const colorSchema = z
  .object({
    r: z.number().min(0).max(1),
    g: z.number().min(0).max(1),
    b: z.number().min(0).max(1),
    a: z.number().min(0).max(1),
  })
  .strict();
export type CanonicalColor = z.infer<typeof colorSchema>;

export const boxSchema = z
  .object({
    x: z.number(),
    y: z.number(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

export const geometrySchema = z
  .object({
    box: boxSchema,
    rootRelative: z.object({ x: z.number(), y: z.number() }).strict(),
  })
  .strict();

export const edgesSchema = z
  .object({
    top: z.number(),
    right: z.number(),
    bottom: z.number(),
    left: z.number(),
  })
  .strict();

export const cornersSchema = z
  .object({
    topLeft: z.number().nonnegative(),
    topRight: z.number().nonnegative(),
    bottomRight: z.number().nonnegative(),
    bottomLeft: z.number().nonnegative(),
  })
  .strict();

export const borderSideSchema = z
  .object({
    width: z.number().nonnegative(),
    style: z.string(),
    color: colorSchema.nullable(),
  })
  .strict();

export const bordersSchema = z
  .object({
    top: borderSideSchema,
    right: borderSideSchema,
    bottom: borderSideSchema,
    left: borderSideSchema,
  })
  .strict();

export const shadowSchema = z
  .object({
    inset: z.boolean(),
    offsetX: z.number(),
    offsetY: z.number(),
    blur: z.number().nonnegative(),
    spread: z.number(),
    color: colorSchema,
    approximation: z.boolean().default(false),
  })
  .strict();

export const layoutSchema = z
  .object({
    padding: edgesSchema,
    direction: z.enum(["horizontal", "vertical", "none"]).default("none"),
    itemSpacing: z.number().nullable().default(null),
    overflow: z.string().nullable().default(null),
  })
  .strict();

export const appearanceSchema = z
  .object({
    background: colorSchema.nullable(),
    radius: cornersSchema,
    borders: bordersSchema.nullable(),
    opacity: z.number().min(0).max(1),
    shadows: z.array(shadowSchema).default([]),
  })
  .strict();

export const typographySchema = z
  .object({
    fontFamily: z.array(z.string()).min(1),
    fontSize: z.number().positive(),
    fontWeight: z.number().int().positive(),
    lineHeight: z.number().nullable(),
    letterSpacing: z.number(),
    color: colorSchema.nullable(),
    textAlign: z.string().nullable().default(null),
  })
  .strict();

export const unsupportedRecordSchema = z
  .object({ feature: z.string(), reason: z.string() })
  .strict();
export type UnsupportedRecord = z.infer<typeof unsupportedRecordSchema>;

export const canonicalStyleNodeSchema = z
  .object({
    designNodeId: z.string().min(1),
    name: z.string(),
    kind: z.string().min(1),
    geometry: geometrySchema,
    layout: layoutSchema,
    appearance: appearanceSchema,
    // null when the node carries no meaningful text
    typography: typographySchema.nullable(),
    absorbedNodeIds: z.array(z.string()).default([]),
    unsupported: z.array(unsupportedRecordSchema).default([]),
    approximations: z.array(z.string()).default([]),
  })
  .strict();
export type CanonicalStyleNode = z.infer<typeof canonicalStyleNodeSchema>;
