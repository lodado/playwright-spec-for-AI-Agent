import { describe, expect, it } from "vitest";
import { extractStaticAuthority } from "../index.mjs";

describe("static authority", () => {
  it("extracts identity and policy without compiling behavioral meaning", () => {
    const source = `// @qa-scenario: GENERIC
// @qa-page: /items
// @qa-live-policy: safe-interaction
test("opens an item", async ({ page }) => {
  await page.getByRole("button", { name: "Open" }).click();
  await expect(page.getByText("Opened")).toBeVisible();
});`;

    const authority = extractStaticAuthority({ source, sourcePath: "items.spec.ts" });

    expect(authority.scenario.page).toBe("/items");
    expect(authority.tests).toHaveLength(1);
    expect(authority.tests[0]).toMatchObject({ title: "opens an item", livePolicyAnnotation: "safe-interaction", policy: { navigation: "ALLOWED", click: "SAFE_ONLY" } });
    expect(authority.tests[0]).not.toHaveProperty("actions");
    expect(authority.tests[0]).not.toHaveProperty("expectations");
  });

  it("fails closed when live authority is not explicitly allowed", () => {
    const source = `// @qa-scenario: GENERIC
test("observes", async ({ page }) => { await expect(page.locator("main")).toBeVisible(); });`;

    expect(extractStaticAuthority({ source, sourcePath: "items.spec.ts" }).tests[0].policy.navigation).toBe("BLOCKED");
  });
});
