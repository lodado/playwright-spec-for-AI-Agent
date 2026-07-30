import { createLogger } from "./logger.js";
import { runCommand } from "./commands/run.js";

export interface Io {
  out: (line: string) => void;
  err: (line: string) => void;
}

const defaultIo: Io = {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
};

const COMMANDS = ["run"] as const;
type CommandName = (typeof COMMANDS)[number];

const HELP = `design-convergence <command> [options]

Commands:
  run --case <id> [--config <path>]   Validate config and select a case

Options:
  --config <path>   Config file (default: design-convergence.config.json)
  --json            Emit machine-readable JSON logs
  --verbose         Include structured fields in human output
  --quiet           Suppress info output (errors still shown)
`;

/**
 * Parse argv, dispatch to a command, and return an exit code. Pure and testable:
 * all IO goes through the injected `io`. Exit codes follow the project policy —
 * 0 success, 1 deterministic product mismatch (Phase 4+), 2 config/usage/infra.
 */
export async function main(
  argv: string[],
  io: Io = defaultIo,
): Promise<number> {
  const command = argv[0];

  if (
    !command ||
    command === "--help" ||
    command === "-h" ||
    command === "help"
  ) {
    io.out(HELP);
    return command ? 0 : 2;
  }

  if (!COMMANDS.includes(command as CommandName)) {
    createLogger({ write: io.out, writeErr: io.err }).error({
      kind: "configuration",
      message: `unknown command: ${command}`,
    });
    return 2;
  }

  const rest = argv.slice(1);
  switch (command as CommandName) {
    case "run":
      return runCommand(rest, io);
  }
}
