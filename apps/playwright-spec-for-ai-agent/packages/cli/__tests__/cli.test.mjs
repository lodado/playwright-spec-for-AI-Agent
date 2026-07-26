import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LEGACY_COMMANDS, runLegacyCommand } from "../index.mjs";

const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));

describe("legacy CLI compatibility bridge", () => {
  it("preserves every legacy command and script mapping", () => {
    expect(LEGACY_COMMANDS).toEqual({
      spec: "extract-page-e2e-spec.mjs",
      "abstract-ai": "run-hermes-spec-abstractor.mjs",
      judge: "run-hermes-page-judge.mjs",
      review: "run-hermes-judge-review.mjs",
      slack: "slack-page-qa-report.mjs",
      nightly: "run-page-qa-nightly.mjs",
    });
  });

  it("forwards arguments and the child exit code unchanged", () => {
    const spawn = vi.fn(() => ({ status: 7 }));
    expect(runLegacyCommand("judge", ["--page=dashboard"], { spawn, cwd: "/project", env: { SENTINEL: "1" } })).toBe(7);
    expect(spawn).toHaveBeenCalledWith(process.execPath, [
      join(ROOT, "scripts", "run-hermes-page-judge.mjs"),
      "--page=dashboard",
    ], {
      stdio: "inherit",
      env: { SENTINEL: "1" },
      cwd: "/project",
    });
  });

  it("keeps help and unknown-command exit behavior", () => {
    const help = spawnSync(process.execPath, [join(ROOT, "bin", "playwright-spec-for-ai-agent.mjs"), "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    for (const command of Object.keys(LEGACY_COMMANDS)) expect(help.stdout).toContain(command);

    const unknown = spawnSync(process.execPath, [join(ROOT, "bin", "playwright-spec-for-ai-agent.mjs"), "not-a-command"], { encoding: "utf8" });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("Unknown command: not-a-command");
  });
});
