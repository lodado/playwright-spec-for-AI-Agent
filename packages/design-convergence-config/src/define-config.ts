import type { DesignConvergenceConfigInput } from "./schema.js";

/**
 * Identity helper for authoring a config in TypeScript with full type-checking.
 * The v0.1 CLI loads JSON, so a user who prefers TS emits JSON from their own
 * build and passes that to the CLI; this helper only provides editor types.
 */
export function defineConfig(
  config: DesignConvergenceConfigInput,
): DesignConvergenceConfigInput {
  return config;
}
