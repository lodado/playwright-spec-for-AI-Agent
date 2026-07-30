import { describe, expect, it } from "vitest";
import { designBindingsFileSchema, designBindingSchema } from "../src/index.js";

const HASH = "sha256:" + "a".repeat(64);

function binding(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "pricing-card-root",
    caseIds: ["pricing-desktop"],
    figma: { fileKey: "abc123", nodeId: "1:2" },
    target: {
      kind: "intrinsic-jsx-element",
      filePath: "components/PricingCard.tsx",
      elementName: "section",
      occurrence: 0,
      sourceRange: {
        startLine: 12,
        startColumn: 4,
        endLine: 40,
        endColumn: 14,
      },
      sourceHash: HASH,
    },
    runtime: { attributeName: "data-design-node", attributeValue: "120:8" },
    status: "proposed",
    ...overrides,
  };
}

describe("designBindingSchema", () => {
  it("accepts a valid intrinsic-jsx-element binding and defaults arrays", () => {
    const parsed = designBindingSchema.parse(binding());
    expect(parsed.status).toBe("proposed");
    expect(parsed.absorbedNodeIds).toEqual([]);
    expect(parsed.evidence).toEqual({});
  });

  it("rejects an unknown status", () => {
    expect(
      designBindingSchema.safeParse(binding({ status: "trusted" })).success,
    ).toBe(false);
  });

  it("rejects a malformed attribute name", () => {
    const bad = binding({
      runtime: { attributeName: "designNode", attributeValue: "1" },
    });
    expect(designBindingSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-sha256 source hash", () => {
    const bad = binding({
      target: {
        kind: "intrinsic-jsx-element",
        filePath: "a.tsx",
        elementName: "div",
        occurrence: 0,
        sourceRange: { startLine: 1, startColumn: 0, endLine: 2, endColumn: 0 },
        sourceHash: "deadbeef",
      },
    });
    expect(designBindingSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an empty caseIds list", () => {
    expect(
      designBindingSchema.safeParse(binding({ caseIds: [] })).success,
    ).toBe(false);
  });

  it("accepts a component-root target discriminant", () => {
    const parsed = designBindingSchema.parse(
      binding({
        target: {
          kind: "component-root",
          filePath: "components/PricingCard.tsx",
          componentName: "PricingCard",
          occurrence: 0,
          sourceRange: {
            startLine: 1,
            startColumn: 0,
            endLine: 50,
            endColumn: 0,
          },
          sourceHash: HASH,
        },
      }),
    );
    expect(parsed.target.kind).toBe("component-root");
  });
});

describe("designBindingsFileSchema", () => {
  it("accepts a versioned bindings file", () => {
    const r = designBindingsFileSchema.safeParse({
      schemaVersion: 1,
      bindings: [binding()],
    });
    expect(r.success).toBe(true);
  });

  it("rejects a wrong schemaVersion", () => {
    const r = designBindingsFileSchema.safeParse({
      schemaVersion: 2,
      bindings: [],
    });
    expect(r.success).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    const r = designBindingsFileSchema.safeParse({
      schemaVersion: 1,
      bindings: [],
      extra: true,
    });
    expect(r.success).toBe(false);
  });
});
