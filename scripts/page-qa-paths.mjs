import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const APP_ROOT = resolve(new URL("..", import.meta.url).pathname);

export const DEFAULT_TARGET_PATHS = {
  dashboard: "/dashboard",
  pricing: "/pricing",
};

export const PAGES_WITH_PLAYWRIGHT_RUN = new Set(["dashboard"]);

export const PAGE_QA_DIR_NAME = "__QA__";

export function pageSlug(page) {
  return page.replace(/\//g, "-");
}

export function pageSupportsPlaywrightRun(page) {
  return PAGES_WITH_PLAYWRIGHT_RUN.has(page);
}

export function parsePageArg(argv, { required = true } = {}) {
  const pageArg = argv.find(arg => arg.startsWith("--page="));
  if (!pageArg) {
    if (!required) return null;
    console.error(
      [
        "Missing --page= argument.",
        "Examples:",
        "  node scripts/extract-page-e2e-spec.mjs --page=dashboard",
        "  node scripts/run-hermes-page-judge.mjs --page=pricing --target-path=/pricing",
      ].join("\n")
    );
    process.exit(1);
  }
  return pageArg.slice("--page=".length).trim();
}

export function parseTargetPathArg(argv, page) {
  const targetPathArg = argv.find(arg => arg.startsWith("--target-path="));
  if (targetPathArg) {
    return targetPathArg.slice("--target-path=".length).trim();
  }

  const defaultPath = DEFAULT_TARGET_PATHS[page];
  if (!defaultPath) {
    console.error(
      `Missing --target-path= for page "${page}". Example: --target-path=/${page}`
    );
    process.exit(1);
  }
  return defaultPath;
}

export function resolvePageQaDir(page) {
  return join(APP_ROOT, "src/page", page, PAGE_QA_DIR_NAME);
}

export function resolveOutputDir(page) {
  if (process.env.QA_OUTPUT_DIR) {
    return resolve(process.env.QA_OUTPUT_DIR);
  }
  if (page === "dashboard" && process.env.DASHBOARD_QA_OUTPUT_DIR) {
    return resolve(process.env.DASHBOARD_QA_OUTPUT_DIR);
  }
  return resolve(resolvePageQaDir(page));
}

export function resolveSpecDir(page) {
  return join(APP_ROOT, "src/page", page, "__tests__");
}

export function listAnnotatedSpecFiles(specDir) {
  return readdirSync(specDir)
    .filter(file => file.endsWith(".spec.ts"))
    .filter(file => {
      const source = readFileSync(join(specDir, file), "utf8");
      const hasScenario = /\/\/\s*@qa-scenario:/.test(source);
      const isLiveSkip = /\/\/\s*@qa-live-skip:\s*true/.test(source);
      return hasScenario && !isLiveSkip;
    })
    .sort();
}

export function artifactPaths(page, outputDir = resolveOutputDir(page)) {
  const slug = pageSlug(page);
  return {
    outputDir,
    slug,
    specJson: join(outputDir, `${slug}-qa-spec.json`),
    specMd: join(outputDir, `${slug}-qa-spec.md`),
    runResult: join(outputDir, `${slug}-run-result.json`),
    runReport: join(outputDir, `${slug}-run-report.md`),
    screenshot: join(outputDir, `${slug}-screenshot.png`),
    hermesJudgmentJson: join(outputDir, `${slug}-hermes-judgment.json`),
    hermesJudgmentMd: join(outputDir, `${slug}-hermes-judgment.md`),
    hermesRawOutput: join(outputDir, `${slug}-hermes-raw-output.txt`),
    hermesQuery: join(outputDir, `${slug}-hermes-query.txt`),
  };
}

export { APP_ROOT };
