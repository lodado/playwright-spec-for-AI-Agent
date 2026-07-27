import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKSPACE_ROOT = join(PACKAGE_ROOT, "..", "..");

describe("workspace release configuration", () => {
  it("uses Changesets to publish public packages and skip private packages", () => {
    const config = JSON.parse(
      readFileSync(join(WORKSPACE_ROOT, ".changeset", "config.json"), "utf8"),
    );
    const rootPackage = JSON.parse(
      readFileSync(join(WORKSPACE_ROOT, "package.json"), "utf8"),
    );
    const personaut = JSON.parse(
      readFileSync(
        join(WORKSPACE_ROOT, "apps", "personaut", "package.json"),
        "utf8",
      ),
    );
    const releaseWorkflow = readFileSync(
      join(WORKSPACE_ROOT, ".github", "workflows", "release.yml"),
      "utf8",
    );

    expect(config).toMatchObject({
      access: "public",
      baseBranch: "main",
      privatePackages: { version: false, tag: false },
    });
    expect(rootPackage.scripts).toMatchObject({
      release: "pnpm build && changeset publish",
      "version-packages": "changeset version",
    });
    expect(personaut.private).toBeUndefined();
    expect(personaut.name).toBe("@lodado/personaut");
    expect(personaut.publishConfig.access).toBe("public");
    expect(personaut.exports["."]).toBe("./dist/index.mjs");
    expect(Object.values(personaut.dependencies)).not.toContain("workspace:*");
    expect(releaseWorkflow).toContain("playwright install --with-deps chromium");
    expect(releaseWorkflow).toContain("changesets/action@v1");
    expect(releaseWorkflow).not.toContain("release-please");
  });
});
