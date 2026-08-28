#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  PLAYWRIGHT_1_60_LOCATOR_ASSERTIONS,
  computeApiCoverage,
  parseLocatorAssertionMethods,
} from "./playwright-api-manifest.mjs";

const require = createRequire(import.meta.url);
const playwrightPackage = require.resolve("playwright/package.json");
const typePath = join(dirname(playwrightPackage), "types", "test.d.ts");
const actual = parseLocatorAssertionMethods(readFileSync(typePath, "utf8"));
const reviewed = [...PLAYWRIGHT_1_60_LOCATOR_ASSERTIONS].sort();
const added = actual.filter(method => !reviewed.includes(method));
const removed = reviewed.filter(method => !actual.includes(method));
const coverage = computeApiCoverage(actual);

console.log(
  `Playwright LocatorAssertions: ${coverage.supported}/${coverage.total} supported; ${coverage.missing.length} diagnostic-only.`
);
if (added.length || removed.length) {
  if (added.length) console.error(`Added API(s): ${added.join(", ")}`);
  if (removed.length) console.error(`Removed API(s): ${removed.join(", ")}`);
  console.error("Review and update PLAYWRIGHT_1_60_LOCATOR_ASSERTIONS explicitly.");
  process.exitCode = 1;
}
