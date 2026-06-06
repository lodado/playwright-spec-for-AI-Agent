/**
 * Copy to your app repo as playwright-spec-for-ai-agent.config.mjs.
 *
 *   npx playwright-spec-for-ai-agent spec --page=billing
 *   npx playwright-spec-for-ai-agent judge --page=billing --target-path=/settings/billing
 *
 * Legacy config names (hermes-qa.config.*, playwright-spec-qa.config.*) are still discovered.
 */
export default {
  paths: {
    specDir: "src/page/{page}/__tests__",
    outputDir: "src/page/{page}/__QA__",
  },

  targetPaths: {
    dashboard: "/dashboard",
    pricing: "/pricing",
  },

  /**
   * Staging account expectations for Hermes judge.
   * When set, Hermes uses this @qa-scenario instead of inferring from the live page.
   */
  staging: {
    expectedSubscriptionStatus: "INACTIVE",
    expectedPlan: "BASIC",
    accountNotes: "QA account on staging — do not mutate billing",
  },

  pages: {
    dashboard: {
      targetPath: "/dashboard",
      expectedSubscriptionStatus: "ACTIVE",
    },
    pricing: {
      targetPath: "/pricing",
    },
  },
};
