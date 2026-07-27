/**
 * Copy to your app repo as playwright-spec-for-ai-agent.config.mjs.
 *
 *   npx playwright-spec-for-ai-agent spec --page=billing
 *   npx playwright-spec-for-ai-agent judge --page=billing
 *
 * Legacy config names (hermes-qa.config.*, playwright-spec-qa.config.*) are still discovered.
 */
export default {
  paths: {
    specDir: "src/page/{page}/__tests__",
  },

  /**
   * Staging origin and account expectations for Hermes judge.
   * When pageUrl or targetPath is set under pages.*, judge uses it automatically.
   */
  staging: {
    baseUrl: "https://staging.example.com",
    loginPath: "/login",
    authRequired: true,
    expectedSubscriptionStatus: "INACTIVE",
    expectedPlan: "BASIC",
    accountNotes: "QA account on staging — do not mutate billing",
  },

  pages: {
    dashboard: {
      pageUrl: "https://staging.example.com/dashboard",
      expectedSubscriptionStatus: "ACTIVE",
    },
    pricing: {
      targetPath: "/pricing",
      authRequired: false,
    },
  },

  remediation: {
    patch: {
      minimumConfidence: 0.5,
      maxFiles: 5,
      maxChangedLines: 200,
      allowedPaths: ["src", "tests"],
      deniedPaths: ["src/secrets"],
    },
    verification: {
      perCommandTimeoutMs: 120_000,
      totalTimeoutMs: 600_000,
      maxOutputBytes: 65_536,
      checks: {
        format: { command: "pnpm", args: ["run", "format:check"] },
        lint: { command: "pnpm", args: ["run", "lint"] },
        typecheck: { command: "pnpm", args: ["run", "typecheck"] },
        unit: { command: "pnpm", args: ["run", "test"] },
        playwright: { command: "pnpm", args: ["exec", "playwright", "test", "tests/e2e"] },
      },
    },
    publication: {
      minimumConfidence: 0.8,
    },
    review: {
      model: "hermes",
    },
  },
};
