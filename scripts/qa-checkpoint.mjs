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

/** POST one action to the runner's QA browser tools server. */
export async function requestBrowserTool(payload, env = process.env) {
  const endpoint = env.QA_BROWSER_TOOLS_URL?.trim();
  const token = env.QA_BROWSER_TOOLS_TOKEN ?? "";
  if (!endpoint || !token) {
    throw new Error("QA_BROWSER_TOOLS_URL and QA_BROWSER_TOOLS_TOKEN are not set; browser tools exist only inside a judge run.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Browser tool request failed (HTTP ${response.status}).`);
  return body;
}

export function requestCheckpoint({ checkId, url, env = process.env }) {
  return requestBrowserTool({ action: "capture", checkId, url }, env);
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
