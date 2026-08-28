/**
 * Failure taxonomy shared by every command.
 *
 * Exit codes are part of the CLI contract — CI can branch on them:
 *   0 judged green (pass, or nothing to judge)
 *   1 verdict failure — the product under test was judged `fail`
 *   2 usage — wrong flags, missing --page, unusable config
 *   3 environment — agent CLI/model/credentials/staging missing or unreachable
 *   4 agent output — the adapter ran but returned output we cannot use
 *
 * A verdict failure (1) and an infrastructure failure (3, 4) must never share
 * an exit code: a nightly that cannot tell "staging is broken" from "staging is
 * down" pages the wrong person.
 */
export const EXIT_OK = 0;
export const EXIT_VERDICT_FAIL = 1;
export const EXIT_USAGE = 2;
export const EXIT_ENVIRONMENT = 3;
export const EXIT_AGENT_OUTPUT = 4;

export class QaError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number, hint?: string, cause?: unknown }} [options]
   */
  constructor(message, { exitCode = EXIT_USAGE, hint = "", cause } = {}) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
    this.hint = hint;
    if (cause !== undefined) this.cause = cause;
  }
}

/** Wrong flags, missing arguments, unusable config: the operator can fix it. */
export class UsageError extends QaError {
  constructor(message, options = {}) {
    super(message, { exitCode: EXIT_USAGE, ...options });
  }
}

/** Missing agent CLI, model, credentials, or unreachable staging. */
export class EnvironmentError extends QaError {
  constructor(message, options = {}) {
    super(message, { exitCode: EXIT_ENVIRONMENT, ...options });
  }
}

/** The adapter ran but returned output we cannot parse or trust. */
export class AgentOutputError extends QaError {
  constructor(message, options = {}) {
    super(message, { exitCode: EXIT_AGENT_OUTPUT, ...options });
  }
}

export function isQaError(error) {
  return error instanceof QaError;
}

/**
 * Expected failures print a message plus the next step. Unexpected ones keep
 * their stack, because a stack is the right output for a bug.
 */
export function formatQaError(error) {
  if (!isQaError(error)) return error?.stack ?? String(error?.message ?? error);
  return error.hint ? `${error.message}\n\n${error.hint}` : error.message;
}

/**
 * Entry-script wrapper: runs `fn`, maps its return value or thrown error to an
 * exit code, and never lets an expected failure surface as a stack trace.
 *
 * @param {() => Promise<number | void>} fn
 */
export async function runMain(fn) {
  try {
    const code = await fn();
    if (typeof code === "number" && code !== 0) process.exitCode = code;
  } catch (error) {
    console.error(formatQaError(error));
    process.exitCode = isQaError(error) ? error.exitCode : EXIT_USAGE;
  }
}
