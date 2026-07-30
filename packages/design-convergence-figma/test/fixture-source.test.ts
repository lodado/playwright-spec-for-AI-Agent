import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { findNode, getRootNode, loadFigmaFixture } from "../src/index.js";

const fixture = (name: string): string =>
  fileURLToPath(
    new URL(
      `../../../fixtures/design-convergence/figma/${name}`,
      import.meta.url,
    ),
  );

describe("loadFigmaFixture / getRootNode / findNode", () => {
  it("loads a fixture and returns the requested root node", () => {
    const response = loadFigmaFixture(fixture("pricing-card.raw.json"));
    const root = getRootNode(response, "1:2");
    expect(root.name).toBe("Pricing Card / Pro");
    expect(root.type).toBe("FRAME");
  });

  it("throws figma-fetch for a node not present in the fixture", () => {
    const response = loadFigmaFixture(fixture("pricing-card.raw.json"));
    expect(() => getRootNode(response, "9:9")).toThrow(/not present/);
  });

  it("finds a descendant text node by id", () => {
    const response = loadFigmaFixture(fixture("pricing-card.raw.json"));
    const root = getRootNode(response, "1:2");
    const price = findNode(root, "1:4");
    expect(price?.characters).toBe("$29");
  });

  it("throws when the fixture file is missing", () => {
    expect(() => loadFigmaFixture(fixture("does-not-exist.raw.json"))).toThrow(
      /cannot read/,
    );
  });
});
