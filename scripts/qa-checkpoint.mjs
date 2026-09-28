#!/usr/bin/env node
/**
 * Shell form of Hermes's `qa_checkpoint` tool, for exec agents that only have
 * a terminal. The runner starts the tools server and passes its endpoint in
 * QA_BROWSER_TOOLS_URL / QA_BROWSER_TOOLS_TOKEN; the runner, not the agent,
 * captures the screenshot and ARIA snapshot.
 *
 *   node qa-checkpoint.mjs <checkId> <full-url>
 */
import { pathToFileURL } from "node:url";

export async function requestCheckpoint({ checkId, url, env = process.env }) {
  const endpoint = env.QA_BROWSER_TOOLS_URL?.trim();
  const token = env.QA_BROWSER_TOOLS_TOKEN ?? "";
  if (!endpoint || !token) {
    throw new Error("QA_BROWSER_TOOLS_URL and QA_BROWSER_TOOLS_TOKEN are not set; checkpoints exist only inside a judge run.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action: "capture", checkId, url }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Checkpoint request failed (HTTP ${response.status}).`);
  return body;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [checkId, url] = process.argv.slice(2);
  if (!checkId || !url) {
    console.error("usage: qa-checkpoint.mjs <checkId> <full-url>");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await requestCheckpoint({ checkId, url })));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exit(1);
  }
}
