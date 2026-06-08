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
    },
  },
};
