import { redact, type RuntimeErrorKind } from "@design-convergence/shared";

export interface LogEvent {
  message: string;
  [key: string]: unknown;
}

export interface ErrorEvent extends LogEvent {
  kind: RuntimeErrorKind;
}

export interface Logger {
  info(event: LogEvent): void;
  error(event: ErrorEvent): void;
}

export interface LoggerOptions {
  json?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  /** Known secret values scrubbed from every rendered line, in addition to secret-named keys. */
  secretValues?: readonly string[];
  write?: (line: string) => void;
  writeErr?: (line: string) => void;
}

type Level = "info" | "error";

/**
 * Renders the same event object as either human text or JSON. `verbose`/`quiet`
 * only change presentation, never the underlying event or a verdict. Every line
 * passes through the central redactor first, so a secret cannot leak in any mode.
 */
export function createLogger(options: LoggerOptions = {}): Logger {
  const write =
    options.write ?? ((line: string) => process.stdout.write(line + "\n"));
  const writeErr =
    options.writeErr ?? ((line: string) => process.stderr.write(line + "\n"));
  const secrets = options.secretValues ?? [];

  const render = (level: Level, event: LogEvent): string => {
    const safe = redact({ level, ...event }, secrets) as Record<
      string,
      unknown
    > & {
      message: string;
    };
    if (options.json) return JSON.stringify(safe);

    const prefix = level === "error" ? "error: " : "";
    const extras = Object.entries(safe).filter(
      ([key]) => key !== "level" && key !== "message",
    );
    const suffix =
      options.verbose && extras.length > 0
        ? "  " +
          extras
            .map(
              ([key, value]) =>
                `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`,
            )
            .join(" ")
        : "";
    return `${prefix}${safe.message}${suffix}`;
  };

  return {
    info(event) {
      if (options.quiet) return;
      write(render("info", event));
    },
    error(event) {
      // Errors are shown even under --quiet; a suppressed error is a lie.
      writeErr(render("error", event));
    },
  };
}
