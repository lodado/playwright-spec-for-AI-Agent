import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/**
 * Static fixture contract (no browser): Phase 4's deterministic waiting and
 * text-overlap checks depend on a stable ready marker and stable copy. This
 * fails if the fixture drifts from that contract.
 */
describe("pricing fixture", () => {
  it("exposes the page-ready marker used for deterministic waiting", () => {
    expect(read("app/pricing/page.tsx")).toContain('data-page-ready="true"');
  });

  it("keeps the bound section marker and the expected static copy", () => {
    const card = read("components/PricingCard.tsx");
    expect(card).toContain("<section");
    expect(card).toContain('data-ready="true"');
    for (const copy of ["Pro", "$29", "Start Free"]) {
      expect(card).toContain(copy);
    }
  });
});
