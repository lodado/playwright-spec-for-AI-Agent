#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import {
  artifactPaths,
  ensureProjectConfig,
  parsePageArg,
  parseTargetPathArg,
} from "./page-qa-paths.mjs";

const WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const RUN_URL = process.env.GITHUB_SERVER_URL
  ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
  : "";
const DEFAULT_BASE_URL =
  process.env.STAGING_QA_BASE_URL ?? "https://your-staging-url.example.com";

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

function shouldNotify(runResult, judgment) {
  return (
    runResult?.status === "fail" ||
    judgment?.status === "fail" ||
    judgment?.status === "manual_review"
  );
}

async function postToSlack(payload) {
  if (!WEBHOOK_URL) {
    throw new Error("Missing SLACK_WEBHOOK_URL.");
  }
  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(
      `Slack webhook failed: ${response.status} ${await response.text()}`
    );
  }
}

function buildPayload(page, targetPath, runResult, judgment) {
  const status = judgment?.status ?? runResult?.status ?? "unknown";
  const statusLabel =
    status === "fail" ? "FAIL" : status === "manual_review" ? "MANUAL REVIEW" : "PASS";
  const target = runResult
    ? `${runResult.targetOrigin}${runResult.dashboardPath ?? runResult.targetPath ?? targetPath}`
    : `${DEFAULT_BASE_URL}${targetPath}`;
  const evidence = judgment?.evidence?.slice(0, 5) ?? [];

  return {
    username: "Page QA Bot",
    text: `[${statusLabel}] Nightly ${page} QA: ${status}`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*[${statusLabel}] Nightly ${page} QA: ${status}*\n*Target:* <${target}|${target}>`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Run:*\n${RUN_URL ? `<${RUN_URL}|GitHub Actions>` : "local"}`,
          },
          {
            type: "mrkdwn",
            text: `*Judgment source:*\n${judgment?.source ?? "unknown"}`,
          },
        ],
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Summary:*\n${judgment?.summary ?? runResult?.status ?? status}`,
        },
      },
      ...(evidence.length
        ? [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*Evidence:*\n${evidence.map(item => `- ${item}`).join("\n")}`,
              },
            },
          ]
        : []),
    ],
  };
}

async function main() {
  const argv = process.argv.slice(2);
  await ensureProjectConfig(argv);
  const page = parsePageArg(argv);
  const targetPath = parseTargetPathArg(argv, page);
  const paths = artifactPaths(page);

  const runResult = readJson(paths.runResult, null);
  const judgment = readJson(paths.hermesJudgmentJson, null);

  if (!runResult && !judgment) {
    throw new Error(
      `Missing ${paths.slug}-run-result.json and ${paths.slug}-hermes-judgment.json.`
    );
  }

  if (!shouldNotify(runResult, judgment)) {
    console.log(`${page} QA passed; no Slack notification sent.`);
    return;
  }

  await postToSlack(buildPayload(page, targetPath, runResult, judgment));
  console.log(`${page} QA Slack notification sent.`);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
