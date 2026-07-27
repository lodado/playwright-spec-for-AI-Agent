import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "personaut-pack-"));
const consumer = join(temporary, "consumer");

function run(command, args, cwd = workspace) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed\n${result.stderr}`);
  return result.stdout;
}

try {
  run("pnpm", ["--filter", "@lodado/personaut", "pack", "--pack-destination", temporary]);
  const archive = readdirSync(temporary).find(name => name.endsWith(".tgz"));
  if (!archive) throw new Error("Personaut package archive was not created");

  mkdirSync(consumer);
  writeFileSync(join(consumer, "package.json"), JSON.stringify({ name: "personaut-smoke", private: true }));
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temporary, archive)], consumer);

  const installed = join(consumer, "node_modules", "@lodado", "personaut");
  const bin = join(installed, "bin", "personaut.mjs");
  if (!run(process.execPath, [bin, "--help"], consumer).includes("personaut init")) {
    throw new Error("Personaut help does not document init");
  }

  const study = join(consumer, "study.yaml");
  run(process.execPath, [bin, "init", study], consumer);
  if (!run(process.execPath, [bin, "validate", study], consumer).includes("Valid study-spec/0.1")) {
    throw new Error("Personaut starter study did not validate");
  }

  const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
  if (manifest.name !== "@lodado/personaut" || Object.values(manifest.dependencies).some(value => value.startsWith("workspace:"))) {
    throw new Error("Personaut publish manifest contains workspace runtime dependencies");
  }
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
