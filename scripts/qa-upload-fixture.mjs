#!/usr/bin/env node
/**
 * Shell form of Hermes's `qa_upload_fixture` tool, for exec agents that only
 * have a terminal. The runner attaches the declared fixture bytes itself; the
 * agent names the check, page and fixture, never a file path.
 *
 *   node qa-upload-fixture.mjs <checkId> <full-url> <fixture> [selector]
 */
import { pathToFileURL } from "node:url";
import { requestBrowserTool } from "./qa-checkpoint.mjs";

export function requestUploadFixture({ checkId, url, fixture, selector, env = process.env }) {
  return requestBrowserTool({ action: "upload", checkId, url, fixture, ...(selector ? { selector } : {}) }, env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [checkId, url, fixture, selector] = process.argv.slice(2);
  if (!checkId || !url || !fixture) {
    console.error("usage: qa-upload-fixture.mjs <checkId> <full-url> <fixture> [selector]");
    process.exit(2);
  }
  try {
    console.log(JSON.stringify(await requestUploadFixture({ checkId, url, fixture, selector })));
  } catch (error) {
    console.error(JSON.stringify({ error: error.message }));
    process.exit(1);
  }
}
