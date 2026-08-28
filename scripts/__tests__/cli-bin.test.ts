import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../../bin/playwright-spec-for-ai-agent.mjs", import.meta.url));
const PKG = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8")
);

const dirs: string[] = [];

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "qa-cli-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** An `undefined` override unsets the variable for the child. */
function runBin(
  args: string[],
  options: { cwd?: string; env?: Record<string, string | undefined> } = {}
) {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: options.cwd ?? tempDir(),
    env,
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("version", () => {
  it("prints the package version and exits 0", () => {
    for (const flag of ["--version", "-V"]) {
      const result = runBin([flag]);
      expect(result.stdout.trim()).toBe(PKG.version);
      expect(result.status).toBe(0);
    }
  });
});

describe("help", () => {
  it("lists every registered command and exits 0", () => {
    const result = runBin(["--help"]);
    expect(result.status).toBe(0);
    for (const command of ["spec", "judge", "nightly", "doctor", "show", "report", "ack", "demo"]) {
      expect(result.stdout).toContain(command);
    }
  });

  it("scopes `<command> --help` and `help <command>` to that command", () => {
    for (const args of [["spec", "--help"], ["help", "spec"]]) {
      const result = runBin(args);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("npx playwright-spec-for-ai-agent spec [options]");
      expect(result.stdout).toContain("--spec-dir=<template>");
      // The whole-CLI dump would have carried unrelated commands along.
      expect(result.stdout).not.toContain("nightly");
    }
  });
});

describe("unknown command", () => {
  it("suggests the nearest command and exits 2, not 1", () => {
    const result = runBin(["judg"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Unknown command: judg");
    expect(result.stderr).toContain('Did you mean "judge"?');
  });

  it("stays quiet about suggestions when nothing is close", () => {
    const result = runBin(["zzzzzzzz"]);
    expect(result.status).toBe(2);
    expect(result.stderr).not.toContain("Did you mean");
  });
});

describe("space-separated flags", () => {
  it("forwards `--page dashboard` to the stage script as --page=dashboard", () => {
    const result = runBin(["spec", "--page", "dashboard"]);
    expect(result.stderr).not.toContain("Missing --page=");
    // Reaching the spec directory lookup proves the page argument arrived.
    expect(result.stderr).toContain(join("src", "page", "dashboard"));
  });
});

/** `spec` refuses a project with no spec directory, so give it a real one. */
function specProject() {
  const cwd = tempDir();
  mkdirSync(join(cwd, "src", "page", "dashboard", "__tests__"), {
    recursive: true,
  });
  return cwd;
}

describe(".env loading", () => {
  it("applies file values but never overrides an already-set variable", () => {
    const cwd = specProject();
    writeFileSync(
      join(cwd, ".env"),
      `QA_OUTPUT_DIR=${join(cwd, "from-file")}\nQA_CLI_TEST_ONLY=from-file\n`
    );

    const overridden = runBin(["spec", "--page=dashboard"], {
      cwd,
      env: { QA_OUTPUT_DIR: join(cwd, "from-shell") },
    });
    expect(overridden.stderr).toContain("1 applied, 1 already set in the environment (kept)");
    expect(existsSync(join(cwd, "from-shell"))).toBe(true);
    expect(existsSync(join(cwd, "from-file"))).toBe(false);

    const unset = runBin(["spec", "--page=dashboard"], { cwd, env: { QA_OUTPUT_DIR: undefined } });
    expect(unset.stderr).toContain("2 applied, 0 already set in the environment (kept)");
    expect(existsSync(join(cwd, "from-file"))).toBe(true);
  });

  it("reads an alternate file with --env-file= and skips everything under QA_NO_ENV_FILE=1", () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "staging.env"), `QA_OUTPUT_DIR=${join(cwd, "from-file")}\n`);

    const explicit = runBin(["--env-file=staging.env", "--version"], { cwd });
    expect(explicit.stderr).toContain("staging.env");
    expect(explicit.stdout.trim()).toBe(PKG.version);

    writeFileSync(join(cwd, ".env"), "QA_CLI_TEST_ONLY=from-file\n");
    const disabled = runBin(["--version"], { cwd, env: { QA_NO_ENV_FILE: "1" } });
    expect(disabled.stderr).not.toContain("[env]");
  });

  it("reads .env.local first — that is where Next/Vite projects keep secrets", () => {
    const cwd = specProject();
    writeFileSync(join(cwd, ".env"), "QA_CLI_TEST_ONLY=from-env\nONLY_IN_ENV=yes\n");
    writeFileSync(join(cwd, ".env.local"), "QA_CLI_TEST_ONLY=from-local\n");

    const result = runBin(["--version"], { cwd });
    // .env.local is applied first, so .env cannot overwrite the shared key,
    // while a key only .env defines is still picked up.
    expect(result.stderr).toContain(".env.local: 1 applied");
    expect(result.stderr).toContain(".env: 1 applied, 1 already set");
  });
});
