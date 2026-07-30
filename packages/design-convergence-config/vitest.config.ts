import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Resolve the sibling workspace package from source so `pnpm --filter test`
// runs without a prior build step. Runtime/build still use the dist exports.
export default defineConfig({
  resolve: {
    alias: {
      "@design-convergence/shared": fileURLToPath(
        new URL("../design-convergence-shared/src/index.ts", import.meta.url),
      ),
    },
  },
});
