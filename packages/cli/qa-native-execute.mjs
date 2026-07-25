import { closeSync, constants, fstatSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { TextDecoder } from "node:util";
import { compilePlaywrightSpec } from "../adapter-playwright/index.mjs";
import { createExecutionPlan } from "../core/index.mjs";
import { writeEvidenceArchive } from "../evidence/index.mjs";
import { executeWithPlaywright, playwrightExecutionCapabilities } from "../provider-playwright/index.mjs";
import { createExclusiveQaDirectory, writePrivateJsonExclusive } from "./qa-native.mjs";

const MAX_SPEC_BYTES = 4 * 1024 * 1024;

export async function executeQaNative({ specPath, baseUrl, runDirectory, integrityKey, cwd }, overrides = {}) {
  const compile = overrides.compile ?? compilePlaywrightSpec;
  const plan = overrides.plan ?? createExecutionPlan;
  const execute = overrides.execute ?? executeWithPlaywright;
  const writeArchive = overrides.writeArchive ?? writeEvidenceArchive;
  const projectRoot = realpathSync(cwd);
  let created = false;
  try {
    createExclusiveQaDirectory(relative(cwd, runDirectory), { cwd });
    created = true;
    const source = readBoundedSpec(specPath);
    const compileResult = compile({ source, sourcePath: relative(projectRoot, specPath) });
    if (!compileResult.ok) throw new Error("QA spec compilation failed");
    const qaIr = compileResult.qaIr;
    const executionPlan = plan({ qaIr, providerCapabilities: playwrightExecutionCapabilities() });
    const execution = await execute({ qaIr, plan: executionPlan, baseUrl, runId: basename(runDirectory) });
    if (execution.outcome?.type !== "COMPLETED" || execution.bundles.length === 0 || execution.manifest === undefined) throw new Error("QA execution failed");
    writePrivateJsonExclusive(relative(cwd, join(runDirectory, "qa-ir.json")), qaIr, { cwd });
    writePrivateJsonExclusive(relative(cwd, join(runDirectory, "execution-plan.json")), executionPlan, { cwd });
    writeArchive({
      directory: join(runDirectory, "evidence"),
      bundles: execution.bundles,
      manifest: execution.manifest,
      readBlob: execution.readBlob,
      integrityKey,
    });
    writePrivateJsonExclusive(relative(cwd, join(runDirectory, "run.json")), execution.outcome, { cwd });
    return 0;
  } catch (error) {
    if (created) rmSync(runDirectory, { recursive: true, force: true });
    throw error;
  }
}

function readBoundedSpec(path) {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_SPEC_BYTES) throw new Error("QA spec input is invalid");
    const buffer = Buffer.alloc(MAX_SPEC_BYTES + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.byteLength - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_SPEC_BYTES) throw new Error("QA spec input is invalid");
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
  } finally {
    closeSync(descriptor);
  }
}
