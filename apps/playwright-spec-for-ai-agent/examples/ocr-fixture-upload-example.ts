// @qa-page: ocr
// @qa-scenario: LOGGED_IN_EMPTY

import { expect, test } from "@playwright/test";

test.describe("OCR Home - fixture upload example", () => {
  // @qa-live-policy: safe-interaction
  test("opens template upload dialog from add-template card", async ({
    page,
  }) => {
    await page.getByTestId("add-template-card").click();
    await expect(page.getByText("템플릿 업로드")).toBeVisible();
  });

  // @qa-live-policy: safe-interaction
  test("uploads template PDF using file-level @qa-fixture key", async ({
    page,
  }) => {
    const dialog = page.getByRole("dialog", { name: /템플릿 업로드/i });
    await dialog
      .locator('input[type="file"]')
      .setInputFiles("src/page/home/__QA__/fixtures/tax_invoice.pdf");
    await expect(page).toHaveURL(/\/deep-ocr\/templates\/\d+(?:\?|$)/);
  });

  // @qa-live-policy: safe-interaction
  // @qa-fixture: workspace_pdf=src/page/home/__QA__/fixtures/workspace_upload.pdf
  test("uploads workspace PDF after selecting template", async ({ page }) => {
    await page.getByTestId("workspace-empty-area").click();
    await page.getByRole("button", { name: "다음" }).click();

    const dialog = page.getByRole("dialog");
    await dialog
      .locator('input[type="file"]')
      .first()
      .setInputFiles("src/page/home/__QA__/fixtures/workspace_upload.pdf");

    await expect(
      dialog.getByRole("button", { name: "파일 업로드" }).last(),
    ).toBeEnabled();
  });
});
