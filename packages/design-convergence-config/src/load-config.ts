import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  DesignConvergenceError,
  resolveWithinRoot,
} from "@design-convergence/shared";
import {
  configSchema,
  type CaseConfig,
  type DesignConvergenceConfig,
} from "./schema.js";

export interface LoadedConfig {
  readonly config: DesignConvergenceConfig;
  readonly configPath: string;
  readonly configDir: string;
  readonly rootDir: string;
}

/**
 * Read and validate `design-convergence.config.json`. No code from the target
 * repository is executed — the config is pure JSON validated by Zod.
 */
export function loadConfig(configPath: string): LoadedConfig {
  const absConfigPath = resolve(configPath);

  let raw: string;
  try {
    raw = readFileSync(absConfigPath, "utf8");
  } catch {
    throw new DesignConvergenceError(
      "configuration",
      "cannot read config file",
      {
        configPath: absConfigPath,
      },
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new DesignConvergenceError(
      "configuration",
      "config is not valid JSON",
      {
        configPath: absConfigPath,
      },
    );
  }

  const parsed = configSchema.safeParse(json);
  if (!parsed.success) {
    throw new DesignConvergenceError(
      "configuration",
      "config failed validation",
      {
        issues: parsed.error.issues,
      },
    );
  }

  const configDir = dirname(absConfigPath);
  // rootDir anchors containment for every other path. It is resolved from the
  // config directory but is itself the boundary, so it is not containment-checked.
  const rootDir = resolve(configDir, parsed.data.project.rootDir);

  // Fail loudly now if any declared project-relative path escapes rootDir.
  for (const c of parsed.data.cases) {
    if (c.prepare !== undefined) resolveWithinRoot(rootDir, c.prepare);
  }

  return { config: parsed.data, configPath: absConfigPath, configDir, rootDir };
}

/** Resolve a project-relative path against the loaded root, enforcing containment. */
export function resolveProjectPath(
  loaded: LoadedConfig,
  relPath: string,
): string {
  return resolveWithinRoot(loaded.rootDir, relPath);
}

/** Look up a case by id, or throw a configuration error naming the available ids. */
export function selectCase(loaded: LoadedConfig, caseId: string): CaseConfig {
  const found = loaded.config.cases.find((c) => c.id === caseId);
  if (!found) {
    throw new DesignConvergenceError(
      "configuration",
      `unknown case id: ${caseId}`,
      {
        available: loaded.config.cases.map((c) => c.id),
      },
    );
  }
  return found;
}
