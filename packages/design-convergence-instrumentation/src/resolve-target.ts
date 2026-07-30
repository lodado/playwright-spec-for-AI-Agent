import { createHash } from "node:crypto";
import { parse, type ParseResult } from "@babel/parser";
import type {
  File,
  JSXOpeningElement,
  Node,
  SourceLocation,
} from "@babel/types";
import {
  DesignConvergenceError,
  type DesignBinding,
  type SourceRange,
} from "@design-convergence/shared";

/**
 * A binding target resolved against the current file's parsed source. The
 * caller injects the runtime attribute at `location`; the binding stays
 * `proposed` until Phase 4 runtime validation promotes it.
 */
export interface ResolvedTarget {
  readonly binding: DesignBinding;
  readonly filePath: string;
  readonly location: SourceRange;
}

// AST bookkeeping keys carry positions/comments, never child nodes to visit.
const SKIP_KEYS = new Set([
  "loc",
  "start",
  "end",
  "range",
  "leadingComments",
  "trailingComments",
  "innerComments",
  "comments",
  "tokens",
  "errors",
]);

function computeSourceHash(source: string): string {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

function locToRange(loc: SourceLocation): SourceRange {
  return {
    startLine: loc.start.line,
    startColumn: loc.start.column,
    endLine: loc.end.line,
    endColumn: loc.end.column,
  };
}

function rangesEqual(a: SourceRange, b: SourceRange): boolean {
  return (
    a.startLine === b.startLine &&
    a.startColumn === b.startColumn &&
    a.endLine === b.endLine &&
    a.endColumn === b.endColumn
  );
}

/** Typed instrumentation failure carrying only non-source metadata. */
function fail(
  reason: string,
  binding: DesignBinding,
  filePath: string,
  extra: Record<string, unknown> = {},
): never {
  throw new DesignConvergenceError(
    "instrumentation",
    `binding ${binding.id}: ${reason}`,
    { reason, bindingId: binding.id, filePath, ...extra },
  );
}

/**
 * Collect every `<elementName>` opening element in document order. A generic
 * descent is used instead of `@babel/traverse` to avoid the heavier dependency;
 * results are sorted by source position so `occurrence` indexing is stable.
 */
export function collectJsxOpeningElements(
  root: Node,
  elementName: string,
): JSXOpeningElement[] {
  const out: JSXOpeningElement[] = [];
  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    const node = value as Record<string, unknown>;
    if (typeof node.type !== "string") return;
    if (node.type === "JSXOpeningElement") {
      const name = node.name as Record<string, unknown> | undefined;
      if (name?.type === "JSXIdentifier" && name.name === elementName) {
        out.push(node as unknown as JSXOpeningElement);
      }
    }
    for (const key of Object.keys(node)) {
      if (SKIP_KEYS.has(key)) continue;
      visit(node[key]);
    }
  };
  visit(root);
  out.sort(
    (a, b) =>
      a.loc!.start.line - b.loc!.start.line ||
      a.loc!.start.column - b.loc!.start.column,
  );
  return out;
}

/**
 * Resolve one manual binding to exactly one JSX opening element, or throw a
 * typed `instrumentation` error. Identity is `elementName` + `occurrence`;
 * `sourceRange` and `sourceHash` are stale-content guards, never the sole
 * identity signal, and no nearest-element fallback is ever used.
 */
export function resolveTarget(params: {
  binding: DesignBinding;
  filePath: string;
  source: string;
}): ResolvedTarget {
  const { binding, filePath, source } = params;
  const { target } = binding;

  if (target.kind !== "intrinsic-jsx-element") {
    fail("unsupported-target-kind", binding, filePath, { kind: target.kind });
  }
  if (target.filePath !== filePath) {
    fail("file-path-mismatch", binding, filePath, {
      targetFilePath: target.filePath,
    });
  }
  if (computeSourceHash(source) !== target.sourceHash) {
    fail("source-hash-mismatch", binding, filePath);
  }

  let ast: ParseResult<File>;
  try {
    ast = parse(source, {
      sourceType: "module",
      plugins: ["jsx", "typescript"],
    });
  } catch {
    fail("parse-failed", binding, filePath);
  }

  const candidates = collectJsxOpeningElements(ast.program, target.elementName);
  if (target.occurrence >= candidates.length) {
    fail("missing-target", binding, filePath, {
      occurrence: target.occurrence,
      candidateCount: candidates.length,
    });
  }

  const stored = target.sourceRange;
  const rangeOwnerIndex = candidates.findIndex(
    (el) => el.loc != null && rangesEqual(locToRange(el.loc), stored),
  );
  if (rangeOwnerIndex === -1) {
    fail("source-range-mismatch", binding, filePath, {
      occurrence: target.occurrence,
      expected: stored,
      candidateCount: candidates.length,
    });
  }
  if (rangeOwnerIndex !== target.occurrence) {
    fail("occurrence-range-conflict", binding, filePath, {
      recordedOccurrence: target.occurrence,
      rangeOccurrence: rangeOwnerIndex,
    });
  }

  return {
    binding,
    filePath,
    location: locToRange(candidates[target.occurrence]!.loc!),
  };
}
