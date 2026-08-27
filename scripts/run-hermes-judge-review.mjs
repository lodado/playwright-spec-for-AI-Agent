#!/usr/bin/env node
/**
 * Post-judge QA review — Hermes re-checks judgment quality (no browsing).
 *
 * Usage:
 *   npx playwright-spec-for-ai-agent review --page=dashboard
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgent } from "./ai-agent-adapter.mjs";
import {
  formatJudgmentForReview,
  normalizeJudgeReview,
  reviewWarrantsExitCode,
} from "./normalize-judge-review.mjs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
} from "./page-qa-paths.mjs";
import { assertRunNotInvalid } from "./qa-run-invalid.mjs";

const HERMES_MAX_TURNS_REVIEW = 6;

function readText(path) {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function readJson(path) {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function buildJudgeReviewHermesQuery({
  page,
  targetPath,
  testPlanDocument,
  judgmentDocument,
}) {
  return [
    "You are a senior QA reviewer. You do **not** browse the web or re-run tests.",
    "",
    "You receive (1) the original **Given / When / Then** test plan and (2) the **judge agent's results** from live staging.",
    "Your job is to **re-review the judge's work**, not to re-test the product.",
    "",
    "## Evaluate these two criteria separately",
    "",
    "### Criterion 1 — `sufficient-evidence`",
    "**Question:** Did the judge actually validate the screen state in a reasonable, evidence-based way?",
    "- Check whether each result cites concrete UI observations (visible text, controls, dialog behavior, URL/state).",
    "- `skip` / `manual_review` are fine when they are explained with live-safety or ambiguity reasons.",
    "- **pass** = evidence is generally enough to trust the run; **concern** = some checks are weak/vague; **fail** = many conclusions are unsupported.",
    "",
    "### Criterion 2 — `not-overly-pedantic`",
    "**Question:** Did the judge avoid nitpicky failures and handle missing account states reasonably?",
    "- For **mock-api/non-deterministic** tests: reasonable intent match should be **pass** (or **manual_review** if ambiguous), not fail due to CI mock literal mismatch.",
    "- If a scenario/state is unavailable on the live account (e.g., zero-credit boundary not present), a clear **skip** with rationale is acceptable.",
    "- Do **not** penalize the judge for not force-creating unavailable live states; penalize only if they fail to mention or justify the limitation.",
    "- **pass** = practical, intent-based judgment with sensible skips; **concern** = minor nitpicks or weak handling; **fail** = repeated pedantic fails / unjustified state handling.",
    "",
    "## Output rules",
    "- Judge **each criterion on its own** (do not merge into one score).",
    "- Reference specific test **titles** from the judge results when citing issues.",
    "- If a check looks pedantic or mishandles unavailable state coverage, list it under `affectedChecks` and optional `pedanticExamples` (criterion 2).",
    "- `recommendations` is optional: suggest a different result only when you are confident (e.g. fail → pass or manual_review).",
    "",
    "## Response format",
    "Reply with **only** one raw JSON object (no markdown fences):",
    "{",
    '  "overallReview": "approved" | "flagged",',
    '  "summary": "2-4 sentences",',
    '  "criteria": [',
    "    {",
    '      "id": "sufficient-evidence",',
    '      "verdict": "pass" | "concern" | "fail",',
    '      "detail": "...",',
    '      "affectedChecks": ["exact test title", ...]',
    "    },",
    "    {",
    '      "id": "not-overly-pedantic",',
    '      "verdict": "pass" | "concern" | "fail",',
    '      "detail": "...",',
    '      "affectedChecks": ["..."],',
    '      "pedanticExamples": ["optional short examples"]',
    "    }",
    "  ],",
    '  "recommendations": [{ "item": "test title", "currentResult": "fail", "suggestedResult": "pass|manual_review", "reason": "..." }],',
    '  "source": "hermes-agent"',
    "}",
    "",
    "Set `overallReview` to **flagged** if either criterion is **concern** or **fail**.",
    "",
    "---",
    "",
    `## Context`,
    "",
    `- Page: ${page}`,
    `- Target path: ${targetPath ?? "(unknown)"}`,
    "",
    "---",
    "",
    "## Original test plan (Given / When / Then)",
    "",
    testPlanDocument.trimEnd(),
    "",
    "---",
    "",
    "## Judge results to review",
    "",
    judgmentDocument.trimEnd(),
  ].join("\n");
}

function renderReviewMarkdown(review, page) {
  const criterionRows = review.criteria.map(c => {
    return `| ${c.id} | ${c.verdict} | ${c.detail.replace(/\|/g, "\\|")} |`;
  });

  const recRows =
    review.recommendations?.length > 0
      ? review.recommendations.map(
          r =>
            `| ${r.item} | ${r.currentResult} → ${r.suggestedResult} | ${r.reason.replace(/\|/g, "\\|")} |`
        )
      : [];

  return [
    `# Hermes judge review — ${page}`,
    "",
    `- **Overall review:** ${review.overallReview}`,
    `- **Reviewed at:** ${review.reviewedAt}`,
    `- **Original judge status:** ${review.reviewedJudgment?.status ?? "unknown"}`,
    "",
    "## Summary",
    "",
    review.summary,
    "",
    "## Criteria",
    "",
    "| Criterion | Verdict | Detail |",
    "|-----------|---------|--------|",
    ...criterionRows,
    "",
    ...(recRows.length
      ? [
          "## Recommendations",
          "",
          "| Test | Suggestion | Reason |",
          "|------|------------|--------|",
          ...recRows,
          "",
        ]
      : []),
  ].join("\n");
}

function hasFlag(argv, flag) {
  return argv.includes(flag);
}

async function main() {
  const argv = process.argv.slice(2);
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const dryRun = hasFlag(argv, "--dry-run");
  const paths = artifactPaths(page);

  mkdirSync(paths.outputDir, { recursive: true });

  assertRunNotInvalid(paths, "review");

  const judgment = readJson(paths.hermesJudgmentJson);
  if (!judgment) {
    throw new Error(
      `Missing ${paths.slug}-hermes-judgment.json. Run judge --page=${page} first.`
    );
  }

  if (!existsSync(paths.specLiveMd)) {
    throw new Error(
      `Missing ${paths.slug}-qa-spec-live.md. Run abstract-ai --page=${page} first.`
    );
  }

  const testPlanPath = paths.specLiveMd;

  const targetPathArg = argv.find(a => a.startsWith("--target-path="));
  const targetPath = targetPathArg?.slice("--target-path=".length) ?? null;

  const query = buildJudgeReviewHermesQuery({
    page,
    targetPath,
    testPlanDocument: readText(testPlanPath),
    judgmentDocument: formatJudgmentForReview(judgment),
  });

  if (dryRun) {
    writeFileSync(paths.hermesReviewQuery, query);
    console.log(`Dry run — review query written: ${paths.hermesReviewQuery}`);
    return;
  }

  const raw = runAgent(query, HERMES_MAX_TURNS_REVIEW, {
    paths: {
      hermesReviewQuery: paths.hermesReviewQuery,
      hermesReviewRawOutput: paths.hermesReviewRawOutput,
    },
    requiredKeys: ["criteria", "overallReview"],
    mode: "text-only",
  });

  const review = normalizeJudgeReview(raw, judgment);

  writeFileSync(
    paths.hermesReviewJson,
    `${JSON.stringify(review, null, 2)}\n`
  );
  writeFileSync(paths.hermesReviewMd, renderReviewMarkdown(review, page));

  console.log(`Judge review: ${review.overallReview}`);
  for (const criterion of review.criteria) {
    console.log(`  - ${criterion.id}: ${criterion.verdict}`);
  }

  if (reviewWarrantsExitCode(review)) {
    process.exitCode = 1;
  }
}

const isDirectRun =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isDirectRun) {
  main().catch(error => {
    console.error(error.stack ?? error.message);
    process.exit(1);
  });
}
