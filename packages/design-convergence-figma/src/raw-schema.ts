import { z } from "zod";

/**
 * A deliberately loose schema over the parts of the Figma REST node tree we
 * read. `.passthrough()` tolerates the many fields Figma returns that we ignore;
 * only the shapes we actually normalize are typed and validated.
 */

export interface FigmaRawColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface FigmaRawPaint {
  type: string;
  visible?: boolean;
  opacity?: number;
  color?: FigmaRawColor;
}

export interface FigmaRawEffect {
  type: string;
  visible?: boolean;
  radius?: number;
  spread?: number;
  color?: FigmaRawColor;
  offset?: { x: number; y: number };
}

export interface FigmaRawTextStyle {
  fontFamily?: string;
  fontPostScriptName?: string | null;
  fontWeight?: number;
  fontSize?: number;
  lineHeightPx?: number;
  letterSpacing?: number;
  textAlignHorizontal?: string;
}

export interface FigmaRawNode {
  id: string;
  name: string;
  type: string;
  visible?: boolean;
  opacity?: number;
  absoluteBoundingBox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  } | null;
  fills?: FigmaRawPaint[];
  strokes?: FigmaRawPaint[];
  strokeWeight?: number;
  cornerRadius?: number;
  rectangleCornerRadii?: number[];
  paddingLeft?: number;
  paddingRight?: number;
  paddingTop?: number;
  paddingBottom?: number;
  layoutMode?: string;
  itemSpacing?: number;
  clipsContent?: boolean;
  effects?: FigmaRawEffect[];
  style?: FigmaRawTextStyle;
  characters?: string;
  children?: FigmaRawNode[];
}

const rgbaSchema = z
  .object({ r: z.number(), g: z.number(), b: z.number(), a: z.number() })
  .passthrough();

const paintSchema = z
  .object({
    type: z.string(),
    visible: z.boolean().optional(),
    opacity: z.number().optional(),
    color: rgbaSchema.optional(),
  })
  .passthrough();

const effectSchema = z
  .object({
    type: z.string(),
    visible: z.boolean().optional(),
    radius: z.number().optional(),
    spread: z.number().optional(),
    color: rgbaSchema.optional(),
    offset: z.object({ x: z.number(), y: z.number() }).passthrough().optional(),
  })
  .passthrough();

const textStyleSchema = z
  .object({
    fontFamily: z.string().optional(),
    fontPostScriptName: z.string().nullable().optional(),
    fontWeight: z.number().optional(),
    fontSize: z.number().optional(),
    lineHeightPx: z.number().optional(),
    letterSpacing: z.number().optional(),
    textAlignHorizontal: z.string().optional(),
  })
  .passthrough();

export const figmaRawNodeSchema: z.ZodType<FigmaRawNode> = z.lazy(() =>
  z
    .object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      visible: z.boolean().optional(),
      opacity: z.number().optional(),
      absoluteBoundingBox: z
        .object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        })
        .passthrough()
        .nullable()
        .optional(),
      fills: z.array(paintSchema).optional(),
      strokes: z.array(paintSchema).optional(),
      strokeWeight: z.number().optional(),
      cornerRadius: z.number().optional(),
      rectangleCornerRadii: z.array(z.number()).optional(),
      paddingLeft: z.number().optional(),
      paddingRight: z.number().optional(),
      paddingTop: z.number().optional(),
      paddingBottom: z.number().optional(),
      layoutMode: z.string().optional(),
      itemSpacing: z.number().optional(),
      clipsContent: z.boolean().optional(),
      effects: z.array(effectSchema).optional(),
      style: textStyleSchema.optional(),
      characters: z.string().optional(),
      children: z.array(figmaRawNodeSchema).optional(),
    })
    .passthrough(),
);

export const figmaNodesResponseSchema = z
  .object({
    nodes: z.record(
      z.string(),
      z.object({ document: figmaRawNodeSchema }).passthrough(),
    ),
  })
  .passthrough();

export type FigmaNodesResponse = z.infer<typeof figmaNodesResponseSchema>;
