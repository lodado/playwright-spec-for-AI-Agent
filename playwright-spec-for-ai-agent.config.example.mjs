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
    // PLACEHOLDER — every example.com host (subdomains included) is refused
    // before a live run. Replace it with your real staging origin.
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
    // Optional: a Playwright storageState JSON that already holds a session —
    // normally the one your e2e auth setup writes. Relative paths resolve from
    // the project root. Use it for apps that mint their session in code and
    // have no login form for `login` to drive; no credential is needed then.
    // storageState: "playwright/.auth/user.json",
  },

  /**
   * `issues` only. The footer is appended below the handoff document in every
   * filed issue, and it is the only place an agent trigger can come from —
   * deciding who acts on a verdict is yours, not this tool's.
   */
  // github: {
  //   issueFooter:
  //     "@claude Classify each check above and open a PR with the smallest fix. Do not weaken a check to make it pass.",
  // },

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
      // A second app has its own session; this overrides staging.storageState.
      // storageState: "apps/billing/playwright/.auth/user.json",
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
