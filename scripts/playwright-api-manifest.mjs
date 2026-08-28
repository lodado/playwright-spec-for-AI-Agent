export const SUPPORTED_LOCATOR_METHODS = Object.freeze([
  "getByAltText",
  "getByLabel",
  "getByPlaceholder",
  "getByRole",
  "getByTestId",
  "getByText",
  "getByTitle",
  "locator",
]);

export const SUPPORTED_ASSERTION_METHODS = Object.freeze([
  "toBeAttached",
  "toBeChecked",
  "toBeDisabled",
  "toBeEditable",
  "toBeEmpty",
  "toBeEnabled",
  "toBeFocused",
  "toBeHidden",
  "toBeInViewport",
  "toBeVisible",
  "toContainText",
  "toHaveCount",
  "toHaveText",
  "toHaveValue",
]);

export const SUPPORTED_ACTION_METHODS = Object.freeze([
  "blur", "check", "click", "dblclick", "dragTo", "fill", "focus",
  "hover", "press", "selectOption", "setInputFiles", "uncheck",
]);

export const PLAYWRIGHT_1_60_LOCATOR_ASSERTIONS = Object.freeze([
  "toBeAttached", "toBeChecked", "toBeDisabled", "toBeEditable", "toBeEmpty",
  "toBeEnabled", "toBeFocused", "toBeHidden", "toBeInViewport", "toBeVisible",
  "toContainClass", "toContainText", "toHaveAccessibleDescription",
  "toHaveAccessibleErrorMessage", "toHaveAccessibleName", "toHaveAttribute",
  "toHaveCSS", "toHaveClass", "toHaveCount", "toHaveId", "toHaveJSProperty",
  "toHaveRole", "toHaveScreenshot", "toHaveText", "toHaveValue", "toHaveValues",
  "toMatchAriaSnapshot",
]);

export function parseLocatorAssertionMethods(source) {
  const start = source.indexOf("interface LocatorAssertions");
  if (start === -1) return [];
  const rest = source.slice(start);
  const nextInterface = rest.slice(1).search(/\n(?:export\s+)?interface\s+/);
  const block = nextInterface === -1 ? rest : rest.slice(0, nextInterface + 1);
  return [...new Set(
    [...block.matchAll(/^\s{2,}([A-Za-z_$][\w$]*)\s*\(/gm)].map(match => match[1])
  )].sort();
}

export function computeApiCoverage(playwrightMethods) {
  const supportedSet = new Set(SUPPORTED_ASSERTION_METHODS);
  const supported = playwrightMethods.filter(method => supportedSet.has(method));
  return {
    total: playwrightMethods.length,
    supported: supported.length,
    missing: playwrightMethods.filter(method => !supportedSet.has(method)),
  };
}
