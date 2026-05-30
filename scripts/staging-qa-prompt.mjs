import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  assertStagingQaCredentials,
  parseStagingQaArgs,
  redactEmail,
} from "./staging-qa-config.mjs";

const NON_INTERACTIVE_FLAGS = new Set(["--non-interactive", "--yes", "-y"]);

const SCENARIO_CHOICES = ["ACTIVE", "INACTIVE", "CANCEL_PENDING"];

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

function formatScenarioSignals(signals) {
  return [
    `  subtitle: ${signals.subtitle || "(empty)"}`,
    `  subscription-cancel-link: ${signals.subscriptionCancelLink ? "visible" : "hidden"}`,
    `  subscription-resume-link: ${signals.subscriptionResumeLink ? "visible" : "hidden"}`,
    `  subscription-disabled-link: ${signals.subscriptionDisabledLink ? "visible" : "hidden"}`,
  ].join("\n");
}

async function promptScenarioChoice(message) {
  const answer = await promptLine(
    `${message} (${SCENARIO_CHOICES.join("/")}, skip=manual_review)`
  );
  const normalized = answer.toUpperCase();
  if (!normalized || normalized === "SKIP" || normalized === "MANUAL_REVIEW") {
    return null;
  }
  if (SCENARIO_CHOICES.includes(normalized)) return normalized;
  throw new Error(
    `Invalid scenario "${answer}". Use ${SCENARIO_CHOICES.join(", ")}, or skip.`
  );
}

/**
 * @param {ReturnType<typeof parseStagingQaArgs>} config
 * @param {{ stepLabel?: string, targetPath?: string | null }} [options]
 */
export async function promptRunConfig(
  config,
  { stepLabel = "Playwright run", targetPath = null } = {}
) {
  output.write(`\n--- Dashboard QA: ${stepLabel} ---\n\n`);

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

  if (!config.expectedSubscriptionStatus) {
    const override = await promptLine(
      "Expected subscription status (ACTIVE/INACTIVE/CANCEL_PENDING, empty=auto infer)"
    );
    if (override) {
      config.expectedSubscriptionStatus = override.toUpperCase();
    }
  }

  assertStagingQaCredentials(config);

  const targetUrl = new URL(
    targetPath ?? config.dashboardPath,
    config.baseUrl
  ).toString();
  const proceed = await promptConfirm(`Proceed with ${targetUrl}?`, true);
  if (!proceed) {
    output.write("Aborted.\n");
    process.exit(0);
  }

  return config;
}

export async function promptScenarioConfirmation(inspection) {
  const { scenarioId, inferredFrom, signals } = inspection;

  output.write("\n--- Dashboard scenario ---\n\n");
  output.write(`${formatScenarioSignals(signals)}\n\n`);

  if (inferredFrom === "override" && scenarioId) {
    output.write(`Using override: ${scenarioId}\n`);
    return scenarioId;
  }

  if (!scenarioId) {
    output.write("Could not infer ACTIVE / INACTIVE / CANCEL_PENDING.\n");
    return promptScenarioChoice("Choose scenario for spec assertions");
  }

  output.write(`Inferred: ${scenarioId} (from ${inferredFrom})\n`);
  const proceed = await promptConfirm(
    `Run spec assertions for ${scenarioId}?`,
    true
  );
  if (proceed) return scenarioId;

  return promptScenarioChoice("Choose a different scenario");
}

/**
 * @param {string[]} [argv]
 * @param {{ stepLabel?: string, targetPath?: string | null }} [options]
 */
export async function resolveStagingQaConfig(
  argv = process.argv.slice(2),
  { stepLabel, targetPath = null } = {}
) {
  const config = parseStagingQaArgs(argv);
  if (!shouldPromptInteractively(argv)) {
    assertStagingQaCredentials(config);
    return config;
  }

  return promptRunConfig(config, { stepLabel, targetPath });
}
