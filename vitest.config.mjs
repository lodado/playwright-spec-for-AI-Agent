import { defineConfig } from "vitest/config";

// Suites that re-check the formal Oracle run need its local artifacts (.ai/oracles, ignored by git)
// or the Bend toolchain; `npm run test:formal` runs them (vitest.formal.config.mjs).
export const FORMAL_SUITES = [
  "scripts/__tests__/refactor-verdict.world.test.ts",
  "scripts/__tests__/bend-proof.test.ts",
  "scripts/__tests__/bend-adequacy.test.ts",
];

// Only this package's suites — stray tool/scratch directories (.omx, fixtures
// copied by editors) must not be collected as tests.
export default defineConfig({
  test: {
    include: ["scripts/__tests__/**/*.test.ts"],
    exclude: FORMAL_SUITES,
    // These suites spawn browsers and CLI processes; one worker avoids CPU-contention timeouts.
    maxWorkers: 1,
  },
});
