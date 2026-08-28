import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { EXIT_USAGE } from "./errors.mjs";
import {
  getProjectConfig,
  loadProjectConfig,
  resolveJudgeTarget,
  resolveOutputDirForPage,
  resolveSpecDirForPage,
  resolveTargetPathForPage,
} from "./hermes-qa-project-config.mjs";

export const PAGE_QA_DIR_NAME = "__QA__";

export function pageSlug(page) {
  return page.replace(/\//g, "-");
}

export async function ensureProjectConfig(argv = process.argv.slice(2)) {
  return loadProjectConfig(argv);
}

export function parsePageArg(argv, { required = true } = {}) {
  const pageArg = argv.find(arg => arg.startsWith("--page="));
  if (!pageArg) {
    if (!required) return null;
    console.error(
      [
        "Missing --page= argument.",
        "Examples:",
        "  npx playwright-spec-for-ai-agent spec --page=dashboard",
        "  npx playwright-spec-for-ai-agent judge --page=pricing --target-path=/pricing",
      ].join("\n")
    );
    process.exit(EXIT_USAGE);
  }
  return pageArg.slice("--page=".length).trim();
}

export function parseTargetPathArg(argv, page) {
  const target = resolveJudgeTarget(argv, page);
  if (target.pageUrl) {
    try {
      const url = new URL(target.pageUrl);
      return `${url.pathname}${url.search}${url.hash}` || "/";
    } catch {
      return target.pageUrl;
    }
  }

  if (target.targetPath) {
    return target.targetPath;
  }

  console.error(
    [
      `Missing --target-path= for page "${page}".`,
      `Set pages.${page}.pageUrl, pages.${page}.targetPath, or targetPaths.${page} in playwright-spec-for-ai-agent.config.*,`,
      `or pass --target-path=/${page}`,
    ].join(" ")
  );
  process.exit(EXIT_USAGE);
}

export { resolveJudgeTarget };

export function resolvePageQaDir(page) {
  return resolveOutputDirForPage(page);
}

export function resolveOutputDir(page) {
  return resolveOutputDirForPage(page);
}

export function resolveSpecDir(page) {
  return resolveSpecDirForPage(page);
}

export function formatSpecDirLabel(page) {
  const config = getProjectConfig();
  const specDir = resolveSpecDir(page);
  return relative(config.root, specDir) || specDir;
}

// Anchored to a whole comment line: prose that merely mentions an annotation
// ("// @qa-live-skip: true means Hermes skips it") must not activate it.
const SCENARIO_LINE = /^[ \t]*\/\/[ \t]*@qa-scenario:[ \t]*\S/m;
const LIVE_SKIP_LINE = /^[ \t]*\/\/[ \t]*@qa-live-skip:[ \t]*true[ \t]*$/m;

export function listAnnotatedSpecFiles(specDir) {
  return readdirSync(specDir)
    .filter(file => file.endsWith(".spec.ts"))
    .filter(file => {
      const source = readFileSync(join(specDir, file), "utf8");
      return SCENARIO_LINE.test(source) && !LIVE_SKIP_LINE.test(source);
    })
    .sort();
}

export function artifactPaths(page, outputDir = resolveOutputDir(page)) {
  const slug = pageSlug(page);
  return {
    outputDir,
    slug,
    specJson: join(outputDir, `${slug}-qa-spec.json`),
    specAbstractedJson: join(outputDir, `${slug}-qa-spec-abstracted.json`),
    specLiveJson: join(outputDir, `${slug}-qa-spec-live.json`),
    specLiveMd: join(outputDir, `${slug}-qa-spec-live.md`),
    specJudgePlanMd: join(outputDir, `${slug}-qa-judge-plan.md`),
    abstractAuditJson: join(outputDir, `${slug}-qa-abstract-audit.json`),
    hermesJudgmentJson: join(outputDir, `${slug}-hermes-judgment.json`),
    hermesJudgmentMd: join(outputDir, `${slug}-hermes-judgment.md`),
    hermesRawOutput: join(outputDir, `${slug}-hermes-raw-output.txt`),
    hermesQuery: join(outputDir, `${slug}-hermes-query.txt`),
    hermesAbstractQuery: join(outputDir, `${slug}-hermes-abstract-query.txt`),
    hermesAbstractRawOutput: join(
      outputDir,
      `${slug}-hermes-abstract-raw-output.txt`
    ),
    runInvalidMarker: join(outputDir, `${slug}-qa-run.invalid`),
    runsLedger: join(outputDir, `${slug}-qa-runs.jsonl`),
    evidenceManifestJson: join(outputDir, `${slug}-qa-evidence-manifest.json`),
    verdictHistoryJson: join(outputDir, `${slug}-qa-verdict-history.json`),
    judgmentCtrfJson: join(outputDir, `${slug}-qa-report.ctrf.json`),
    ackJson: join(outputDir, `${slug}-qa-ack.json`),
    evidenceDir: join(outputDir, "evidence"),
    videosDir: join(outputDir, "videos"),
    hermesReviewJson: join(outputDir, `${slug}-hermes-judge-review.json`),
    hermesReviewMd: join(outputDir, `${slug}-hermes-judge-review.md`),
    hermesReviewQuery: join(outputDir, `${slug}-hermes-judge-review-query.txt`),
    hermesReviewRawOutput: join(
      outputDir,
      `${slug}-hermes-judge-review-raw-output.txt`
    ),
  };
}

/** @deprecated Use getProjectConfig().root */
export function getProjectRoot() {
  return getProjectConfig().root;
}
