import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@design-convergence/shared": fileURLToPath(
        new URL("../design-convergence-shared/src/index.ts", import.meta.url),
      ),
    },
  },
});
