import { describe, expect, it } from "vitest";
import { parseReadOnlyExpectations } from "../dashboard-spec-parser.mjs";

describe("Playwright locator assertions as static QA intent", () => {
  it.each([
    ["getByRole", `page.getByRole("button", { name: "Save" })`, { kind: "role", value: "button", name: { kind: "literal", value: "Save" } }],
    ["getByLabel", `page.getByLabel("Email")`, { kind: "label", value: "Email" }],
    ["getByPlaceholder", `page.getByPlaceholder("Search")`, { kind: "placeholder", value: "Search" }],
    ["getByAltText", `page.getByAltText("Logo")`, { kind: "altText", value: "Logo" }],
    ["getByTitle", `page.getByTitle("Close")`, { kind: "title", value: "Close" }],
    ["locator", `page.locator(".toast")`, { kind: "css", value: ".toast" }],
  ])("to be parsed for %s", (_name, locatorSource, locator) => {
    expect(parseReadOnlyExpectations(`await expect(${locatorSource}).toBeVisible();`)).toEqual([
      { type: "visible", locator },
    ]);
  });

  it.each([
    ["toBeHidden", "", { type: "notVisible" }],
    ["toHaveText", `"Hello"`, { type: "haveText", expected: { kind: "literal", value: "Hello" } }],
    ["toHaveText regex", `/hello/i`, { type: "haveText", expected: { kind: "regex", pattern: "hello", flags: "i" } }],
    ["toHaveCount", "3", { type: "count", expected: 3 }],
    ["toHaveValue", `"ready"`, { type: "value", expected: { kind: "literal", value: "ready" } }],
    ["toBeEnabled", "", { type: "enabled" }],
    ["toBeDisabled", "", { type: "disabled" }],
    ["toBeChecked", "", { type: "checked" }],
    ["toBeEditable", "", { type: "editable" }],
    ["toBeEmpty", "", { type: "empty" }],
    ["toBeFocused", "", { type: "focused" }],
    ["toBeAttached", "", { type: "attached" }],
    ["toBeInViewport", "", { type: "inViewport" }],
  ])("to preserve %s", (matcher, argument, expected) => {
    const method = matcher.split(" ")[0];
    const [parsed] = parseReadOnlyExpectations(
      `await expect(page.getByTestId("target")).${method}(${argument});`,
    );
    expect(parsed).toMatchObject({
      ...expected,
      locator: { kind: "testId", value: "target" },
    });
  });
});
