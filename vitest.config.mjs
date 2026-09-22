import { defineConfig } from "vitest/config";

// Only this package's suites — stray tool/scratch directories (.omx, fixtures
// copied by editors) must not be collected as tests.
export default defineConfig({
  test: {
    include: ["scripts/__tests__/**/*.test.ts"],
    // These suites spawn browsers and CLI processes; one worker avoids CPU-contention timeouts.
    maxWorkers: 1,
  },
});
