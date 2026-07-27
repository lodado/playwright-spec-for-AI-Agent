import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "playwright-spec-pack-"));
const consumer = join(temporary, "consumer");

function run(command, args, cwd = workspace) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr}`);
  }
  return result.stdout;
}

try {
  run("pnpm", [
    "--filter",
    "playwright-spec-for-ai-agent",
    "pack",
    "--pack-destination",
    temporary,
  ]);
  const archive = readdirSync(temporary).find(name => name.endsWith(".tgz"));
  if (!archive) throw new Error("compatibility package archive was not created");

  mkdirSync(consumer);
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({ name: "package-smoke", private: true }),
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, archive)],
    consumer,
  );

  const installed = join(consumer, "node_modules", "playwright-spec-for-ai-agent");
  for (const bin of ["playwright-spec-for-ai-agent.mjs", "qa-native.mjs"]) {
    const output = run(process.execPath, [join(installed, "bin", bin), "--help"], consumer);
    if (!output.includes("Usage:")) throw new Error(`${bin} did not print help`);
  }

  const remediation = await import(pathToFileURL(join(installed, "packages", "cli", "qa-native-remediate.mjs")));
  if (typeof remediation.remediateQaNative !== "function" || typeof remediation.verifyPatchQaNative !== "function") {
    throw new Error("qa-native remediation entry point is missing");
  }

  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (manifest.name !== "playwright-spec-for-ai-agent") {
    throw new Error("installed package name changed");
  }

  const specDir = join(consumer, "tests", "e2e", "pricing");
  mkdirSync(specDir, { recursive: true });
  writeFileSync(join(consumer, "playwright-spec-for-ai-agent.config.mjs"), `export default {
  paths: { specDir: "tests/e2e/{page}", outputDir: ".qa/{page}" },
  staging: { baseUrl: "https://staging.example.com", authRequired: false },
  pages: { pricing: { targetPath: "/pricing", authRequired: false } },
};\n`);
  writeFileSync(join(specDir, "pricing.spec.ts"), `// @qa-page: pricing
// @qa-scenario: A visitor can understand the pricing options
import { expect, test } from "@playwright/test";
// @qa-live-policy: readonly
test("shows pricing options", async ({ page }) => {
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
});\n`);
  run(process.execPath, [join(installed, "bin", "playwright-spec-for-ai-agent.mjs"), "spec", "--page=pricing"], consumer);
  if (!readFileSync(join(consumer, ".qa", "pricing", "pricing-qa-spec.json"), "utf8").includes("pricing options")) {
    throw new Error("README quick-start scenario was not extracted");
  }
  if (!readFileSync(join(installed, "docs", "qa-native.md"), "utf8").includes("QA Native")) {
    throw new Error("QA Native guide is missing from the package");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
