import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// O14 (public surface and major bump) and O19 (zero runtime dependencies) against package.json,
// the CHANGELOG release entry and the `npm pack --dry-run` listing.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
  version: string;
  exports: Record<string, string>;
  bin: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

describe("package.json exports as the cleaned public surface [O14]", () => {
  it("to be exactly the keys ./adapter, ./config and ./package.json", () => {
    // `bin` is the command entry, not an exports subpath: P9 names "bin, ./adapter, ./config and ./package.json".
    expect(Object.keys(manifest.exports).sort()).toStrictEqual(["./adapter", "./config", "./package.json"]);
    expect(Object.keys(manifest.bin)).toStrictEqual(["playwright-spec-for-ai-agent"]);
  });

  it("to be zero wildcard export keys", () => {
    expect(Object.keys(manifest.exports).filter((key) => key.includes("*"))).toStrictEqual([]);
  });

  it("to be version 8.0.0", () => {
    expect(manifest.version).toBe("8.0.0");
  });

  it("to be both removed specifiers ./scripts/* and ./* listed under BREAKING CHANGES of the 8.0.0 release entry", () => {
    const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
    const entry = changelog.split(/^## \[/m).find((section) => section.startsWith("8.0.0]")) ?? "";
    const breaking = entry.split(/^### /m).find((section) => /BREAKING CHANGES/.test(section.split("\n")[0])) ?? "";
    expect(breaking, "8.0.0 entry with a BREAKING CHANGES section").not.toBe("");
    expect(breaking).toContain("`./scripts/*`");
    expect(breaking).toContain("`./*`");
  });
});

describe("npm pack listing as the published files [O14]", () => {
  let listed: string[] = [];

  beforeAll(() => {
    const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    expect(run.status, run.stderr).toBe(0);
    const [report] = JSON.parse(run.stdout) as Array<{ files: Array<{ path: string }> }>;
    listed = report.files.map((file) => file.path);
  }, 120_000);

  it("to be every exports target, the bin target and package.json inside the tarball", () => {
    const targets = [...Object.values(manifest.exports), ...Object.values(manifest.bin)].map((path) =>
      path.replace(/^\.\//, ""),
    );
    expect(targets.filter((target) => !listed.includes(target))).toStrictEqual([]);
    expect(listed).toContain("package.json");
  });

  it("to be zero test files in the tarball", () => {
    expect(listed.filter((path) => path.startsWith("scripts/__tests__/"))).toStrictEqual([]);
  });
});

describe("package.json dependencies as zero runtime dependencies [O19]", () => {
  it("to be zero dependencies", () => {
    expect(Object.keys(manifest.dependencies ?? {})).toStrictEqual([]);
  });

  it("to be fast-check, typescript and type-fest in devDependencies", () => {
    for (const name of ["fast-check", "typescript", "type-fest"]) {
      expect(manifest.devDependencies, name).toHaveProperty(name);
    }
  });
});
