import { createHash } from "node:crypto";
import { parse } from "@babel/parser";
import type { File } from "@babel/types";
import { DesignConvergenceError } from "@design-convergence/shared";
import type { DesignBinding, SourceRange } from "@design-convergence/shared";
import { describe, expect, it } from "vitest";
import { collectJsxOpeningElements } from "../src/resolve-target.js";
import { instrumentationPlugin } from "../src/babel-plugin.js";

const FILE = "components/PricingCard.tsx";
const ROOT = "/repo";

const SOURCE = `export function PricingCard() {
  return (
    <section className="card">
      <h2>Pro</h2>
    </section>
  );
}
`;

function sourceHash(source: string): string {
  return `sha256:${createHash("sha256").update(source, "utf8").digest("hex")}`;
}

function locOf(source: string, name: string, occurrence: number): SourceRange {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
  const el = collectJsxOpeningElements(ast.program, name)[occurrence];
  if (!el?.loc) throw new Error(`no <${name}> #${occurrence}`);
  return {
    startLine: el.loc.start.line,
    startColumn: el.loc.start.column,
    endLine: el.loc.end.line,
    endColumn: el.loc.end.column,
  };
}

function binding(
  overrides: Partial<DesignBinding["runtime"]> = {},
): DesignBinding {
  return {
    id: "b1",
    caseIds: ["pricing-desktop"],
    figma: { fileKey: "k", nodeId: "1:2" },
    target: {
      kind: "intrinsic-jsx-element",
      filePath: FILE,
      elementName: "section",
      occurrence: 0,
      sourceRange: locOf(SOURCE, "section", 0),
      sourceHash: sourceHash(SOURCE),
    },
    runtime: {
      attributeName: "data-design-node",
      attributeValue: "1:2",
      ...overrides,
    },
    status: "proposed",
    absorbedNodeIds: [],
    evidence: {},
  };
}

/** Parse and run the plugin's Program visitor over a hand-built pass. */
function run(source: string, options: Record<string, unknown>): File {
  const ast = parse(source, {
    sourceType: "module",
    plugins: ["jsx", "typescript"],
  });
  const plugin = instrumentationPlugin(null, options);
  const state = { file: { code: source, opts: { filename: FILE } } };
  plugin.visitor.Program?.({ node: ast.program }, state as never);
  return ast;
}

function designNodeAttributes(ast: File): { name: string; value: string }[] {
  const found: { name: string; value: string }[] = [];
  for (const el of collectJsxOpeningElements(ast.program, "section")) {
    for (const attr of el.attributes) {
      if (
        attr.type === "JSXAttribute" &&
        attr.name.type === "JSXIdentifier" &&
        attr.name.name === "data-design-node" &&
        attr.value?.type === "StringLiteral"
      ) {
        found.push({ name: attr.name.name, value: attr.value.value });
      }
    }
  }
  return found;
}

describe("instrumentationPlugin", () => {
  it("injects exactly one data-design-node on the resolved element when enabled", () => {
    const ast = run(SOURCE, {
      enabled: true,
      projectRoot: ROOT,
      bindings: [binding()],
    });
    expect(designNodeAttributes(ast)).toEqual([
      { name: "data-design-node", value: "1:2" },
    ]);
  });

  it("injects nothing when disabled and never reads the bindings file", () => {
    const ast = run(SOURCE, {
      enabled: false,
      projectRoot: ROOT,
      bindingsPath: "/does/not/exist.json",
    });
    expect(designNodeAttributes(ast)).toEqual([]);
  });

  it("ignores a binding that targets a different file", () => {
    const other = binding();
    const ast = run(SOURCE, {
      enabled: true,
      projectRoot: ROOT,
      bindings: [
        {
          ...other,
          target: { ...other.target, filePath: "components/Other.tsx" },
        },
      ],
    });
    expect(designNodeAttributes(ast)).toEqual([]);
  });

  it("throws a stale error before injecting when the source hash drifts", () => {
    const stale = binding();
    expect(() =>
      run(SOURCE, {
        enabled: true,
        projectRoot: ROOT,
        bindings: [
          {
            ...stale,
            target: { ...stale.target, sourceHash: sourceHash("x") },
          },
        ],
      }),
    ).toThrowError(DesignConvergenceError);
  });

  it("rejects a conflicting pre-existing attribute with a different value", () => {
    const conflicting = `export function PricingCard() {
  return (
    <section data-design-node="9:9" className="card">
      <h2>Pro</h2>
    </section>
  );
}
`;
    expect(() =>
      run(conflicting, {
        enabled: true,
        projectRoot: ROOT,
        bindings: [
          {
            ...binding(),
            target: {
              ...binding().target,
              sourceRange: locOf(conflicting, "section", 0),
              sourceHash: sourceHash(conflicting),
            },
          },
        ],
      }),
    ).toThrowError(/attribute/i);
  });
});
