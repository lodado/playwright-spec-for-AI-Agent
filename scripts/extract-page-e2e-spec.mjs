#!/usr/bin/env node
/**
 * Generic QA spec extractor for any page.
 *
 * Usage:
 *   node scripts/extract-page-e2e-spec.mjs --page=dashboard
 *   node scripts/extract-page-e2e-spec.mjs --page=pricing
 *   node scripts/extract-page-e2e-spec.mjs --page=my-feature/detail
 *
 * Reads @qa-scenario / @qa-page / @qa-live-skip annotations from spec files in
 * src/page/{page}/__tests__/ and writes JSON + Markdown to src/page/{page}/__QA__/.
 *
 * Output files:
 *   {outputDir}/{slug}-qa-spec.json
 *   {outputDir}/{slug}-qa-spec.md
 *
 * Env override:
 *   QA_OUTPUT_DIR  — override output directory (for any page)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import {
  describeLiveRunPolicy,
  formatScenarioCoverageSummary,
  parseSpecDirectory,
} from "./dashboard-spec-parser.mjs";
import {
  artifactPaths,
  parsePageArg,
  resolveSpecDir,
} from "./page-qa-paths.mjs";

function pageLabel(page) {
  return page
    .split("/")
    .map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function renderMarkdown(spec, page) {
  const label = pageLabel(page);
  const lines = [
    `# ${label} QA Spec`,
    "",
    `Generated at: ${spec.generatedAt}`,
    "",
    `Parsed from \`src/page/${page}/__tests__/\` Playwright specs.`,
    "Playwright `node scripts/run-staging-page-ai-qa.mjs` replays **read-only** expectations for the inferred scenario.",
    "Hermes browse judge may execute tests with `liveRunPolicy: executable-interaction` (UI-only clicks).",
    "Subscription/billing mutations, auth mocks, and `@qa-live-skip` stay blocked.",
    "`judgment-mock-api` tests skip on Playwright but Hermes judges live equivalents.",
    "",
  ];

  for (const scenario of spec.scenarios) {
    lines.push(`## ${scenario.label}`, "");
    lines.push(`- Scenario ID: \`${scenario.scenarioId}\``);
    lines.push(`- Source: \`${scenario.sourceFile}\``);
    if (scenario.alwaysRun) {
      lines.push(
        "- Always run: **yes** (runs on every Hermes browse, regardless of plan/status)"
      );
    }
    if (scenario.liveSkip) {
      lines.push("- Live run: **skipped** (@qa-live-skip: true)");
    }
    lines.push("");

    for (const test of scenario.tests) {
      lines.push(`### ${test.title}`);
      lines.push(`- Staging mode: \`${test.stagingMode}\``);
      lines.push(`- Live run policy: \`${test.liveRunPolicy}\``);
      if (test.livePolicyAnnotation) {
        lines.push(
          `- QA annotation: \`@qa-live-policy: ${test.livePolicyAnnotation}\``
        );
      }

      const policyNote = describeLiveRunPolicy(test.liveRunPolicy);
      if (test.liveRunPolicy !== "executable-readonly") {
        if (policyNote) {
          lines.push(`- Live run: ${policyNote}`);
        }
        if (
          test.liveRunPolicy === "judgment-mock-api" &&
          test.expectations.length > 0
        ) {
          lines.push("- Reference expectations (Hermes adapts on live):");
          for (const expectation of test.expectations) {
            lines.push(
              `  - \`${expectation.type}\`: ${JSON.stringify(expectation)}`
            );
          }
        }
        lines.push("");
        continue;
      }

      if (test.expectations.length === 0) {
        lines.push("- Live run: no parsed read-only expectations");
        lines.push("");
        continue;
      }

      lines.push("- Live expectations:");
      for (const expectation of test.expectations) {
        const when = expectation.runWhenScenario
          ? ` (when scenario ${expectation.runWhenScenario.join("|")})`
          : "";
        lines.push(
          `  - \`${expectation.type}\`${when}: ${JSON.stringify(expectation)}`
        );
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const page = parsePageArg(argv);
  const specDir = resolveSpecDir(page);
  const { outputDir, specJson: jsonPath, specMd: mdPath } = artifactPaths(page);

  mkdirSync(outputDir, { recursive: true });

  const spec = parseSpecDirectory(specDir);

  writeFileSync(jsonPath, `${JSON.stringify(spec, null, 2)}\n`);
  writeFileSync(mdPath, renderMarkdown(spec, page));

  const scenarioIds = [...new Set(spec.scenarios.map(s => s.scenarioId))];
  const liveScenarios = spec.scenarios.filter(s => !s.liveSkip);
  const skipCount = spec.scenarios.length - liveScenarios.length;

  const summary = scenarioIds.map(scenarioId =>
    formatScenarioCoverageSummary(spec, scenarioId)
  );

  console.log(`${label(page)} QA spec written: ${jsonPath}`);
  console.log(`${label(page)} QA markdown written: ${mdPath}`);
  for (const line of summary) console.log(`  - ${line}`);
  if (skipCount > 0) {
    console.log(`  (${skipCount} scenario(s) skipped via @qa-live-skip)`);
  }
}

function label(page) {
  return pageLabel(page);
}

main();
