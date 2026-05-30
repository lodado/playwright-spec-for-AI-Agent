/**
 * Copy to your app repo as hermes-qa.config.mjs (or playwright-spec-qa.config.mjs).
 *
 *   npx playwright-spec-qa spec --page=billing \
 *     --spec-dir=tests/e2e/{page} \
 *     --output-dir=.qa/{page} \
 *     --project-root=. \
 *     --config=./hermes-qa.config.mjs
 */
export default {
  /** Project root — defaults to the directory containing this config file. */
  // root: process.cwd(),

  /** Global path templates. Use {page} and {root} placeholders. */
  paths: {
    specDir: "src/page/{page}/__tests__",
    outputDir: "src/page/{page}/__QA__",
  },

  /** Default staging paths when --target-path is omitted. */
  targetPaths: {
    dashboard: "/dashboard",
    pricing: "/pricing",
  },

  /** Pages that run Playwright evidence collection by default in `nightly`. */
  playwrightRunPages: ["dashboard"],

  /** Per-page overrides (optional). */
  pages: {
    dashboard: {
      targetPath: "/dashboard",
      playwrightRun: true,
      // specDir: "e2e/dashboard",
      // outputDir: "qa-artifacts/dashboard",
    },
    pricing: {
      targetPath: "/pricing",
      playwrightRun: false,
    },
    // "settings/billing": {
    //   targetPath: "/settings/billing",
    //   specDir: "tests/e2e/{page}",
    //   outputDir: ".qa/{page}",
    // },
  },
};
