import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
import { DesignConvergenceError } from "@design-convergence/shared";
import type { DesignBinding, SourceRange } from "@design-convergence/shared";
import { describe, expect, it } from "vitest";
import { resolveTarget } from "../src/resolve-target.js";

const FILE = "components/PricingCard.tsx";

const SOURCE = `export function PricingCard() {
  return (
    <section className="card">
      <h2>Pro</h2>
      <button>Start Free</button>
    </section>
  );
}
`;

const TWO_SECTIONS = `export function Cards() {
  return (
    <div>
      <section className="a">A</section>
      <section className="b">B</section>
    </div>
  );
}
`;

function sourceHash(source: string): string {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

/** Oracle: read the real location of the Nth `<name>` opening element. */
function locOf(source: string, name: string, occurrence: number): SourceRange {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
  const found: SourceRange[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const n = node as Record<string, unknown>;
    if (
      n.type === "JSXOpeningElement" &&
      (n.name as Record<string, unknown> | undefined)?.name === name
    ) {
      const loc = n.loc as {
        start: { line: number; column: number };
        end: { line: number; column: number };
      };
      found.push({
        startLine: loc.start.line,
        startColumn: loc.start.column,
        endLine: loc.end.line,
        endColumn: loc.end.column,
      });
    }
    for (const key of Object.keys(n)) {
      if (key === "loc") continue;
      visit(n[key]);
    }
  };
  visit(ast);
  found.sort(
    (a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn,
  );
  const at = found[occurrence];
  if (!at) throw new Error(`no <${name}> #${occurrence} in oracle`);
  return at;
}

function binding(
  source: string,
  overrides: {
    elementName?: string;
    occurrence?: number;
    sourceRange?: SourceRange;
    sourceHash?: string;
    filePath?: string;
  } = {},
): DesignBinding {
  const elementName = overrides.elementName ?? "section";
  const occurrence = overrides.occurrence ?? 0;
  return {
    id: "b1",
    caseIds: ["pricing-desktop"],
    figma: { fileKey: "k", nodeId: "1:2" },
    target: {
      kind: "intrinsic-jsx-element",
      filePath: overrides.filePath ?? FILE,
      elementName,
      occurrence,
      sourceRange:
        overrides.sourceRange ?? locOf(source, elementName, occurrence),
      sourceHash: overrides.sourceHash ?? sourceHash(source),
    },
    runtime: { attributeName: "data-design-node", attributeValue: "1:2" },
    status: "proposed",
    absorbedNodeIds: [],
    evidence: {},
  };
}

describe("resolveTarget", () => {
  it("resolves a valid section occurrence exactly once", () => {
    const resolved = resolveTarget({
      binding: binding(SOURCE),
      filePath: FILE,
      source: SOURCE,
    });
    const expected = locOf(SOURCE, "section", 0);
    expect(resolved.location).toEqual(expected);
    expect(resolved.binding.id).toBe("b1");
  });

  it("throws when the file content hash no longer matches (edited file)", () => {
    const stale = binding(SOURCE, { sourceHash: sourceHash("other source") });
    expect(() =>
      resolveTarget({ binding: stale, filePath: FILE, source: SOURCE }),
    ).toThrowError(DesignConvergenceError);
    try {
      resolveTarget({ binding: stale, filePath: FILE, source: SOURCE });
    } catch (error) {
      expect((error as DesignConvergenceError).kind).toBe("instrumentation");
      expect((error as DesignConvergenceError).detail.reason).toBe(
        "source-hash-mismatch",
      );
    }
  });

  it("throws stale when the stored range matches no such element (moved)", () => {
    const moved = binding(SOURCE, {
      sourceRange: {
        startLine: 99,
        startColumn: 4,
        endLine: 99,
        endColumn: 20,
      },
    });
    try {
      resolveTarget({ binding: moved, filePath: FILE, source: SOURCE });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as DesignConvergenceError).kind).toBe("instrumentation");
      expect((error as DesignConvergenceError).detail.reason).toBe(
        "source-range-mismatch",
      );
    }
  });

  it("throws when the stored range points at a different occurrence (ambiguous identity)", () => {
    // occurrence 0 recorded, but range is that of occurrence 1
    const conflicting = binding(TWO_SECTIONS, {
      occurrence: 0,
      sourceRange: locOf(TWO_SECTIONS, "section", 1),
    });
    try {
      resolveTarget({
        binding: conflicting,
        filePath: FILE,
        source: TWO_SECTIONS,
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as DesignConvergenceError).kind).toBe("instrumentation");
      expect((error as DesignConvergenceError).detail.reason).toBe(
        "occurrence-range-conflict",
      );
    }
  });

  it("throws when the occurrence index is out of range (missing target)", () => {
    const missing = binding(SOURCE, {
      occurrence: 5,
      sourceRange: locOf(SOURCE, "section", 0),
    });
    try {
      resolveTarget({ binding: missing, filePath: FILE, source: SOURCE });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as DesignConvergenceError).detail.reason).toBe(
        "missing-target",
      );
    }
  });

  it("rejects a binding whose target file differs from the parsed file", () => {
    const other = binding(SOURCE, { filePath: "components/Other.tsx" });
    try {
      resolveTarget({ binding: other, filePath: FILE, source: SOURCE });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as DesignConvergenceError).detail.reason).toBe(
        "file-path-mismatch",
      );
    }
  });

  it("rejects a component-root target until Phase 5", () => {
    const b = binding(SOURCE);
    const componentRoot: DesignBinding = {
      ...b,
      target: {
        kind: "component-root",
        filePath: FILE,
        componentName: "PricingCard",
        occurrence: 0,
        sourceRange: locOf(SOURCE, "section", 0),
        sourceHash: sourceHash(SOURCE),
      },
    };
    try {
      resolveTarget({ binding: componentRoot, filePath: FILE, source: SOURCE });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect((error as DesignConvergenceError).detail.reason).toBe(
        "unsupported-target-kind",
      );
    }
  });
});
