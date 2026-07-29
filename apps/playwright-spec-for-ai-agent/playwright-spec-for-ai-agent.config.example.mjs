/**
 * Copy to your app repo as playwright-spec-for-ai-agent.config.mjs.
 *
 * Consumed by the `qa-native` remediation commands (remediate, propose-patch,
 * verify-patch, publish) via loadProjectConfig. Only the `remediation` section
 * is used; the run itself is driven by the qa-native CLI flags:
 *
 *   qa-native execute --spec=<file> --base-url=<url> --run-dir=.qa/runs/<id> --provider=hermes --mode=adaptive
 *   qa-native judge   --run-dir=.qa/runs/<id>
 *   qa-native report  --run-dir=.qa/runs/<id> --repository-root=.
 *
 * Legacy config names (hermes-qa.config.*, playwright-spec-qa.config.*) are still discovered.
 */
export default {
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
