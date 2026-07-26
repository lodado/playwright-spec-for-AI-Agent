import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const WORKSPACE_ROOT = join(PACKAGE_ROOT, "..", "..");
const PACKAGE_PATH = "apps/playwright-spec-for-ai-agent";

describe("workspace release configuration", () => {
  it("releases the compatibility package instead of the private root", () => {
    const config = JSON.parse(
      readFileSync(join(WORKSPACE_ROOT, "release-please-config.json"), "utf8"),
    );
    const manifest = JSON.parse(
      readFileSync(join(WORKSPACE_ROOT, ".release-please-manifest.json"), "utf8"),
    );

    expect(Object.keys(config.packages)).toEqual([PACKAGE_PATH]);
    expect(config.packages[PACKAGE_PATH]["release-type"]).toBe("node");
    expect(manifest).toEqual({ [PACKAGE_PATH]: "0.9.0" });
  });
});
