import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import {
  loadConfig,
  resolveProjectPath,
  selectCase,
  type LoadedConfig,
} from "@design-convergence/config";
import {
  DesignConvergenceError,
  designBindingsFileSchema,
} from "@design-convergence/shared";
import { resolveTarget } from "@design-convergence/instrumentation";
import { createLogger } from "../logger.js";
import type { Io } from "../main.js";

const DEFAULT_CONFIG = "design-convergence.config.json";

/**
 * Static instrumentation preflight: read the manual bindings, keep the ones for
 * this case, and resolve each against its source file. A stale, ambiguous, or
 * unreadable mapping throws `instrumentation` (or a config error for a malformed
 * bindings file) before any app or browser starts. An absent bindings file
 * means zero eligible bindings. Returns the eligible count.
 */
function preflightEligibleBindings(
  loaded: LoadedConfig,
  caseId: string,
): number {
  const bindingsPath = resolveProjectPath(loaded, loaded.config.bindings);

  let content: string;
  try {
    content = readFileSync(bindingsPath, "utf8");
  } catch {
    return 0; // no bindings file yet: nothing statically eligible
  }

  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    throw new DesignConvergenceError(
      "configuration",
      "bindings file is not valid JSON",
      { bindingsPath },
    );
  }
  const parsed = designBindingsFileSchema.safeParse(json);
  if (!parsed.success) {
    throw new DesignConvergenceError(
      "binding-static-validation",
      "bindings file failed validation",
      { issues: parsed.error.issues },
    );
  }

  const eligible = parsed.data.bindings.filter((b) =>
    b.caseIds.includes(caseId),
  );
  for (const binding of eligible) {
    const filePath = binding.target.filePath;
    let source: string;
    try {
      source = readFileSync(resolveProjectPath(loaded, filePath), "utf8");
    } catch {
      throw new DesignConvergenceError(
        "instrumentation",
        `binding ${binding.id}: cannot read source file`,
        { reason: "source-unreadable", bindingId: binding.id, filePath },
      );
    }
    resolveTarget({ binding, filePath, source });
  }
  return eligible.length;
}

/**
 * v0.1 Phase 3: `run --case <id>` validates the config, selects the case, and
 * runs the static instrumentation preflight over the manual bindings. It starts
 * no application and no browser and classifies no design mismatch — that arrives
 * in Phase 4. Exit 0 = valid config + case + bindings; exit 2 =
 * configuration/usage/instrumentation failure.
 */
export async function runCommand(argv: string[], io: Io): Promise<number> {
  let values: {
    case?: string;
    config?: string;
    json?: boolean;
    verbose?: boolean;
    quiet?: boolean;
  };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        case: { type: "string" },
        config: { type: "string" },
        json: { type: "boolean" },
        verbose: { type: "boolean" },
        quiet: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (error) {
    createLogger({ write: io.out, writeErr: io.err }).error({
      kind: "configuration",
      message: (error as Error).message,
    });
    return 2;
  }

  const logger = createLogger({
    json: values.json,
    verbose: values.verbose,
    quiet: values.quiet,
    write: io.out,
    writeErr: io.err,
  });

  if (!values.case) {
    logger.error({
      kind: "configuration",
      message: "run requires --case <id>",
    });
    return 2;
  }

  try {
    const loaded = loadConfig(values.config ?? DEFAULT_CONFIG);
    const selected = selectCase(loaded, values.case);
    logger.info({
      message: `selected case ${selected.id}`,
      caseId: selected.id,
      route: selected.route,
      configPath: loaded.configPath,
    });
    const eligibleBindings = preflightEligibleBindings(loaded, selected.id);
    logger.info({
      message: `instrumentation preflight passed: ${eligibleBindings} statically eligible binding(s)`,
      eligibleBindings,
      caseId: selected.id,
    });
    logger.info({
      message:
        "config, case, and bindings validated; runtime render/diff begins in Phase 4 (no app or browser started)",
    });
    return 0;
  } catch (error) {
    if (error instanceof DesignConvergenceError) {
      logger.error({
        kind: error.kind,
        message: error.message,
        ...error.detail,
      });
      return 2;
    }
    throw error;
  }
}
