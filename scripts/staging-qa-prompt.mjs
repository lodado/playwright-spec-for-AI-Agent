import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  applyStagingAccountDefaults,
  applyStagingUrlDefaults,
} from "./hermes-qa-project-config.mjs";
import {
  assertRealBaseUrl,
  assertStagingQaCredentials,
  buildJudgeTargetUrl,
  isAuthRequired,
  parseStagingQaArgs,
  redactEmail,
  resolveFinalJudgeTarget,
} from "./staging-qa-config.mjs";

const NON_INTERACTIVE_FLAGS = new Set(["--non-interactive", "--yes", "-y"]);

/** Completions only — `@qa-scenario` is free-form intent text. */
const SUGGESTED_ACCOUNT_STATES = ["ACTIVE", "INACTIVE", "CANCEL_PENDING"];

export function normalizeScenarioId(value) {
  if (!value) return "";
  return String(value).trim().toUpperCase();
}

export function shouldPromptInteractively(argv = process.argv.slice(2)) {
  if (argv.some(arg => NON_INTERACTIVE_FLAGS.has(arg))) return false;
  if (process.env.CI === "true" || process.env.CI === "1") return false;
  return Boolean(input.isTTY);
}

function createPromptInterface() {
  return createInterface({ input, output });
}

async function promptLine(question, defaultValue = "") {
  const rl = createPromptInterface();
  try {
    const suffix = defaultValue ? ` (${defaultValue})` : "";
    const answer = (await rl.question(`${question}${suffix}: `)).trim();
    return answer || defaultValue;
  } finally {
    rl.close();
  }
}

// Raw-mode control codes, by code point: EOT and ETX are not printable here.
const CHAR_END_OF_TRANSMISSION = 4;
const CHAR_INTERRUPT = 3;
const CHAR_DELETE = 127;
const CHAR_BACKSPACE = 8;

/**
 * Fold one raw-mode stdin chunk into the buffer. A pasted password arrives as a
 * single multi-character chunk (often with a trailing newline), so control
 * characters have to be found inside the chunk, not compared against it.
 *
 * @returns {{ value: string, done: boolean, cancelled: boolean }}
 */
export function applyHiddenInputChunk(value, chunk) {
  let next = value;

  for (const char of String(chunk)) {
    const code = char.charCodeAt(0);

    if (char === "\n" || char === "\r" || code === CHAR_END_OF_TRANSMISSION) {
      return { value: next, done: true, cancelled: false };
    }
    if (code === CHAR_INTERRUPT) {
      return { value: next, done: true, cancelled: true };
    }
    if (code === CHAR_DELETE || code === CHAR_BACKSPACE) {
      next = next.slice(0, -1);
      continue;
    }

    next += char;
  }

  return { value: next, done: false, cancelled: false };
}

async function promptHidden(question) {
  if (!input.isTTY) {
    throw new Error("Cannot prompt for password without an interactive TTY.");
  }

  output.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");

  let value = "";

  return new Promise((resolve, reject) => {
    const onData = chunk => {
      const result = applyHiddenInputChunk(value, chunk);
      value = result.value;
      if (!result.done) return;

      input.setRawMode(false);
      input.pause();
      input.removeListener("data", onData);
      output.write("\n");

      if (result.cancelled) {
        reject(new Error("Prompt cancelled."));
        return;
      }
      resolve(value);
    };

    input.on("data", onData);
  });
}

async function promptConfirm(question, defaultYes = true) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await promptLine(
    `${question} ${hint}`,
    defaultYes ? "y" : "n"
  );
  if (!answer) return defaultYes;
  return /^y(es)?$/i.test(answer);
}

/**
 * @param {ReturnType<typeof parseStagingQaArgs>} config
 * @param {{ stepLabel?: string, target?: { targetPath?: string | null, pageUrl?: string | null } | null, requireCredentials?: boolean }} [options]
 */
export async function promptRunConfig(
  config,
  { stepLabel = "Hermes judge", target = null, requireCredentials = true } = {}
) {
  output.write(`\n--- Page QA: ${stepLabel} ---\n\n`);

  if (!requireCredentials) {
    // Pre-authenticated browser session: the run needs no credentials at all.
    output.write("Using the pre-authenticated QA browser session.\n");
  } else if (isAuthRequired(config)) {
    if (config.email) {
      const keepEmail = await promptConfirm(
        `Use email ${redactEmail(config.email)}?`,
        true
      );
      if (!keepEmail) {
        config.email = await promptLine("Staging email");
      }
    } else {
      config.email = await promptLine("Staging email");
    }

    if (config.password) {
      const keepPassword = await promptConfirm(
        "Use STAGING_QA_PASSWORD from env?",
        true
      );
      if (!keepPassword) {
        config.password = await promptHidden("Staging password: ");
      }
    } else {
      config.password = await promptHidden("Staging password: ");
    }
  } else {
    output.write("Login disabled for this run (authRequired=false).\n");
  }

  if (!config.expectedSubscriptionStatus) {
    const override = await promptLine(
      `Expected account state (any @qa-scenario id, e.g. ${SUGGESTED_ACCOUNT_STATES.join("/")}; empty=let the judge infer from the live page)`
    );
    const normalized = normalizeScenarioId(override);
    if (normalized) {
      config.expectedSubscriptionStatus = normalized;
      config.expectedAccountState = normalized;
    }
  } else {
    output.write(
      `Using expected account state from config/env: ${config.expectedSubscriptionStatus}\n`
    );
  }

  if (requireCredentials) assertStagingQaCredentials(config);

  let resolvedTarget = target ?? {
    targetPath: config.dashboardPath,
    pageUrl: null,
  };
  let targetUrl = buildJudgeTargetUrl(resolvedTarget, config.baseUrl);

  const proceed = await promptConfirm(`Proceed with ${targetUrl}?`, true);
  if (!proceed) {
    const customInput = await promptLine("Target page URL or path");
    const parsed = resolveFinalJudgeTarget(resolvedTarget, config.baseUrl, {
      confirmed: false,
      customInput,
    });
    if (!parsed) {
      output.write("Aborted.\n");
      process.exit(0);
    }
    resolvedTarget = parsed;
    targetUrl = buildJudgeTargetUrl(resolvedTarget, config.baseUrl);
    output.write(`Using target: ${targetUrl}\n`);
  }

  return { config, target: resolvedTarget };
}

/**
 * @param {string[]} [argv]
 * @param {{ stepLabel?: string, target?: { targetPath?: string | null, pageUrl?: string | null } | null, page?: string | null }} [options]
 */
export async function resolveStagingQaConfig(
  argv = process.argv.slice(2),
  { stepLabel, target = null, page = null, requireCredentials = true } = {}
) {
  const config = parseStagingQaArgs(argv);
  if (page) {
    applyStagingAccountDefaults(config, page);
    applyStagingUrlDefaults(config, argv);
  }
  // Fail before prompting: no answer makes the placeholder origin judgeable.
  assertRealBaseUrl(config);
  if (!shouldPromptInteractively(argv)) {
    if (requireCredentials) assertStagingQaCredentials(config);
    return { config, target };
  }

  return promptRunConfig(config, { stepLabel, target, requireCredentials });
}
