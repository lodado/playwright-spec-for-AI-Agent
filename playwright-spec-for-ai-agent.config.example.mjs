/**
 * Copy to your app repo as playwright-spec-for-ai-agent.config.mjs.
 *
 *   npx playwright-spec-for-ai-agent spec --page=search
 *   npx playwright-spec-for-ai-agent judge --page=search
 *
 * `defineConfig` is an identity function — it exists so editors autocomplete
 * and type-check this file with no build step.
 *
 * Legacy config names (hermes-qa.config.*, playwright-spec-qa.config.*) are still discovered.
 * Run any command with --strict-config (or QA_STRICT_CONFIG=1) in CI so a typo'd
 * key fails the run instead of silently falling back to a default.
 */
import { defineConfig } from "playwright-spec-for-ai-agent/config";

export default defineConfig({
  paths: {
    specDir: "src/page/{page}/__tests__",
    outputDir: "src/page/{page}/__QA__",
  },

  /**
   * Staging origin and account expectations, applied to every page.
   * Any of these can be overridden per page below.
   */
  staging: {
    baseUrl: "https://staging.example.com",
    loginPath: "/login",
    authRequired: true,
    // De-branded name for the @qa-scenario account state to judge against.
    // The old key `expectedSubscriptionStatus` still works.
    expectedAccountState: "INACTIVE",
    expectedPlan: "BASIC",
    accountNotes: "QA account on staging — do not mutate billing",
    // Origins the run may navigate to. Defaults to the baseUrl origin;
    // set `false` to disable origin pinning entirely.
    allowedOrigins: ["https://staging.example.com"],
    // Optional: endpoint returning the deployed build id, so an unchanged
    // deploy can be skipped instead of re-judged.
    versionUrl: "https://staging.example.com/version.json",
  },

  pages: {
    // A plain read-only page: no login, no account state to speak of.
    search: {
      targetPath: "/search",
      authRequired: false,
    },
    settings: {
      targetPath: "/settings/profile",
      specDir: "src/page/settings/__tests__",
    },
    // Per-page baseUrl/loginPath: a second app in the same monorepo.
    billing: {
      baseUrl: "https://billing-staging.example.com",
      loginPath: "/accounts/sign-in",
      targetPath: "/settings/billing",
      expectedAccountState: "ACTIVE",
    },
  },

  /**
   * Project-specific `@qa-live-policy` values. Keys are the annotation value a
   * spec writes (`// @qa-live-policy: payments-mutation`), so a team can name a
   * policy in its own domain language; each must alias one of the built-in
   * verbs, which are what the run actually enforces.
   * Verbs: executable-readonly, executable-interaction,
   * judgment-interaction-no-confirm, judgment-mock-api,
   * blocked-subscription-mutation, blocked-auth-mock, blocked-live-skip.
   */
  livePolicies: {
    "payments-mutation": {
      liveRunPolicy: "blocked-subscription-mutation",
    },
  },

  /** Optional side effects after a stage lands. Both receive the artifact. */
  hooks: {
    onJudgment: judgment => {
      console.log(`[qa] ${judgment.page}: ${judgment.status}`);
    },
    onReview: review => {
      console.log(`[qa] review: ${review.status}`);
    },
  },
});
