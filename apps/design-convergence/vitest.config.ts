import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve sibling workspace packages from source so tests run without a build.
export default defineConfig({
  resolve: {
    alias: {
      "@design-convergence/shared": fileURLToPath(
        new URL(
          "../../packages/design-convergence-shared/src/index.ts",
          import.meta.url,
        ),
      ),
      "@design-convergence/config": fileURLToPath(
        new URL(
          "../../packages/design-convergence-config/src/index.ts",
          import.meta.url,
        ),
      ),
      "@design-convergence/instrumentation": fileURLToPath(
        new URL(
          "../../packages/design-convergence-instrumentation/src/index.ts",
          import.meta.url,
        ),
      ),
    },
  },
});
