import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe("published package", () => {
  it("contains the qa-native CLI and its runtime files", () => {
    const packed = spawnSync(
      "npm",
      ["pack", "--dry-run", "--json", "--ignore-scripts"],
      { cwd: ROOT, encoding: "utf8" },
    );

    expect(packed.status, packed.stderr).toBe(0);
    const [{ files }] = JSON.parse(packed.stdout);
    const paths = files.map(({ path }: { path: string }) => path);

    expect(paths).toEqual(
      expect.arrayContaining([
        "README.md",
        "bin/qa-native.mjs",
        "packages/cli/qa-native.mjs",
        "scripts/dashboard-spec-parser.mjs",
        "scripts/playwright-ast-parser.mjs",
        "playwright-spec-for-ai-agent.config.example.mjs",
      ]),
    );
    expect(paths.some((path: string) => path.startsWith("node_modules/"))).toBe(
      false,
    );
  }, 15_000);
});
