import { z } from "zod";

/**
 * Every failure in Design Convergence carries exactly one of these kinds.
 * Infrastructure failures (app-startup, page-setup, style-extraction, ...) must
 * never be collapsed into a product mismatch (diff), and vice versa.
 */
export const RUNTIME_ERROR_KINDS = [
  "configuration",
  "figma-auth",
  "figma-fetch",
  "source-index",
  "binding-proposal",
  "binding-static-validation",
  "binding-runtime-validation",
  "instrumentation",
  "application-startup",
  "page-setup",
  "style-extraction",
  "normalization",
  "diff",
  "source-attribution",
  "patch-generation",
  "patch-application",
  "verification",
  "report-generation",
  "github",
] as const;

export type RuntimeErrorKind = (typeof RUNTIME_ERROR_KINDS)[number];

export const runtimeErrorKindSchema = z.enum(RUNTIME_ERROR_KINDS);

/**
 * The only error type the runtime throws. `detail` is structured context for
 * logs/artifacts; callers must keep secrets out of it (see redaction utilities).
 */
export class DesignConvergenceError extends Error {
  readonly kind: RuntimeErrorKind;
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    kind: RuntimeErrorKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DesignConvergenceError";
    this.kind = kind;
    this.detail = detail;
  }
}
