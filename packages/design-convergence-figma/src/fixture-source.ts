import { readFileSync } from "node:fs";
import { DesignConvergenceError } from "@design-convergence/shared";
import {
  figmaNodesResponseSchema,
  type FigmaNodesResponse,
  type FigmaRawNode,
} from "./raw-schema.js";

/** Load a fixture-backed Figma `GET /v1/files/:key/nodes` response from disk. */
export function loadFigmaFixture(filePath: string): FigmaNodesResponse {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new DesignConvergenceError(
      "figma-fetch",
      "cannot read Figma fixture",
      {
        filePath,
      },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DesignConvergenceError(
      "figma-fetch",
      "Figma fixture is not valid JSON",
      {
        filePath,
      },
    );
  }

  const parsed = figmaNodesResponseSchema.safeParse(json);
  if (!parsed.success) {
    throw new DesignConvergenceError(
      "figma-fetch",
      "Figma fixture failed schema validation",
      { issues: parsed.error.issues },
    );
  }
  return parsed.data;
}

/** The requested node's document, used as the comparison root for the case. */
export function getRootNode(
  response: FigmaNodesResponse,
  nodeId: string,
): FigmaRawNode {
  const entry = response.nodes[nodeId];
  if (!entry) {
    throw new DesignConvergenceError(
      "figma-fetch",
      `node ${nodeId} not present in fixture`,
      {
        available: Object.keys(response.nodes),
      },
    );
  }
  return entry.document;
}

/** Depth-first search for a node by id within a tree. */
export function findNode(
  root: FigmaRawNode,
  nodeId: string,
): FigmaRawNode | null {
  if (root.id === nodeId) return root;
  for (const child of root.children ?? []) {
    const found = findNode(child, nodeId);
    if (found) return found;
  }
  return null;
}
