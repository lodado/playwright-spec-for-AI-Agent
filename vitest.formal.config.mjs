import { defineConfig } from "vitest/config";
import { FORMAL_SUITES } from "./vitest.config.mjs";

// The formal Oracle re-checks: world and trace conformance generated from the Bend models (they pin the
// Oracle package under .ai/oracles by SHA-256) and the Bend proof/adequacy checks (they need the Bend
// binary and the frontend-oracle-design skill, located through BEND_BIN and ORACLE_SKILL_DIR).
export default defineConfig({
  test: {
    include: [...FORMAL_SUITES, "scripts/__tests__/formal/**/*.test.mjs"],
    maxWorkers: 1,
  },
});
