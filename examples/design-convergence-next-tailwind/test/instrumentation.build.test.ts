import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "@babel/core";
import { instrumentationPlugin } from "@design-convergence/instrumentation";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CARD = join(ROOT, "components/PricingCard.tsx");
const CONFIG = join(ROOT, "babel.config.js");

const originalEnv = process.env.DESIGN_CONVERGENCE;
afterEach(() => {
  if (originalEnv === undefined) delete process.env.DESIGN_CONVERGENCE;
  else process.env.DESIGN_CONVERGENCE = originalEnv;
});

/** Transform PricingCard.tsx through the example's real babel.config.cjs. */
function transformThroughConfig(enabled: boolean): string {
  if (enabled) process.env.DESIGN_CONVERGENCE = "true";
  else delete process.env.DESIGN_CONVERGENCE;
  const out = transformSync(readFileSync(CARD, "utf8"), {
    filename: CARD,
    configFile: CONFIG,
    babelrc: false,
  });
  return out?.code ?? "";
}

describe("example Babel instrumentation", () => {
  it("injects exactly one data-design-node attribute when enabled", () => {
    const code = transformThroughConfig(true);
    expect(code.match(/data-design-node/g) ?? []).toHaveLength(1);
    expect(code).toContain('"1:2"');
  });

  it("injects no design-node attribute in the default (disabled) build", () => {
    const code = transformThroughConfig(false);
    expect(code).not.toContain("data-design-node");
  });

  it("fails the build when the binding is stale, before any app starts", () => {
    process.env.DESIGN_CONVERGENCE = "true";
    expect(() =>
      transformSync(readFileSync(CARD, "utf8"), {
        filename: CARD,
        configFile: false,
        babelrc: false,
        presets: ["next/babel"],
        plugins: [
          [
            instrumentationPlugin,
            {
              enabled: true,
              projectRoot: ROOT,
              bindings: [
                {
                  id: "pricing-card-root",
                  caseIds: ["pricing-desktop"],
                  figma: { fileKey: "k", nodeId: "1:2" },
                  target: {
                    kind: "intrinsic-jsx-element",
                    filePath: "components/PricingCard.tsx",
                    elementName: "section",
                    occurrence: 0,
                    sourceRange: {
                      startLine: 10,
                      startColumn: 4,
                      endLine: 13,
                      endColumn: 5,
                    },
                    sourceHash: `sha256:${"0".repeat(64)}`,
                  },
                  runtime: {
                    attributeName: "data-design-node",
                    attributeValue: "1:2",
                  },
                  status: "proposed",
                  absorbedNodeIds: [],
                  evidence: {},
                },
              ],
            },
          ],
        ],
      }),
    ).toThrow(/instrumentation|hash/i);
  });
});
