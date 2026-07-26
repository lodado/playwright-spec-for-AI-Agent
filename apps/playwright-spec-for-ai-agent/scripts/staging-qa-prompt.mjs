import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  applyStagingAccountDefaults,
  applyStagingUrlDefaults,
} from "./hermes-qa-project-config.mjs";
import {
  assertStagingQaCredentials,
  buildJudgeTargetUrl,
  isAuthRequired,
  parseStagingQaArgs,
  redactEmail,
  resolveFinalJudgeTarget,
} from "./staging-qa-config.mjs";

const NON_INTERACTIVE_FLAGS = new Set(["--non-interactive", "--yes", "-y"]);
const VALID_SCENARIO_IDS = new Set(["ACTIVE", "INACTIVE", "CANCEL_PENDING"]);

export function normalizeScenarioId(value) {
  if (!value) return "";
  const normalized = String(value).trim().toUpperCase();
  return VALID_SCENARIO_IDS.has(normalized) ? normalized : "";
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
    const onData = char => {
      if (char === "\n" || char === "\r" || char === "\u0004") {
        input.setRawMode(false);
        input.pause();
        input.removeListener("data", onData);
        output.write("\n");
        resolve(value);
        return;
      }

      if (char === "\u0003") {
        input.setRawMode(false);
        input.pause();
        input.removeListener("data", onData);
        output.write("\n");
        reject(new Error("Prompt cancelled."));
        return;
      }

      if (char === "\u007f" || char === "\b") {
        value = value.slice(0, -1);
        return;
      }

      value += char;
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
 * @param {{ stepLabel?: string, target?: { targetPath?: string | null, pageUrl?: string | null } | null }} [options]
 */
export async function promptRunConfig(
  config,
  { stepLabel = "Hermes judge", target = null } = {}
) {
  output.write(`\n--- Page QA: ${stepLabel} ---\n\n`);

  if (isAuthRequired(config)) {
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
      "Expected subscription status (ACTIVE/INACTIVE/CANCEL_PENDING, empty=let Hermes infer on live page)"
    );
    const normalized = normalizeScenarioId(override);
    if (normalized) {
      config.expectedSubscriptionStatus = normalized;
    }
  } else {
    output.write(
      `Using expected subscription status from config/env: ${config.expectedSubscriptionStatus}\n`
    );
  }

  assertStagingQaCredentials(config);

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
  { stepLabel, target = null, page = null } = {}
) {
  const config = parseStagingQaArgs(argv);
  if (page) {
    applyStagingAccountDefaults(config, page);
    applyStagingUrlDefaults(config, argv);
  }
  if (!shouldPromptInteractively(argv)) {
    assertStagingQaCredentials(config);
    return { config, target };
  }

  return promptRunConfig(config, { stepLabel, target });
}
