import { parseArgs } from "node:util";
import { loadConfig, selectCase } from "@design-convergence/config";
import { DesignConvergenceError } from "@design-convergence/shared";
import { createLogger } from "../logger.js";
import type { Io } from "../main.js";

const DEFAULT_CONFIG = "design-convergence.config.json";

/**
 * v0.1 Phase 1: `run --case <id>` validates the config and deterministically
 * selects the case. It starts no application and no browser and classifies no
 * design mismatch — that arrives in Phase 4. Exit 0 = valid config + case
 * selected; exit 2 = configuration/usage failure.
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
    logger.info({
      message:
        "config and case validated; runtime render/diff begins in Phase 4 (no app or browser started)",
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
