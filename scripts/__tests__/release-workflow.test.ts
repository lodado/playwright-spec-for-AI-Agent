import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
const config = JSON.parse(readFileSync(new URL("../../release-please-config.json", import.meta.url), "utf8"));
const expression = workflow.match(/  release-please:\n    if: (.+)/)?.[1];
const startsWith = (value: string, prefix: string) => value.toLowerCase().startsWith(prefix.toLowerCase());
const shouldMaintainReleasePr = (ref: string, message?: string) =>
  Function("github", "startsWith", `return (${expression});`)(
    { ref, event: message === undefined ? {} : { head_commit: { message } } }, startsWith,
  );

describe("quiet release policy", () => {
  it("does not publish GitHub Release announcements", () => {
    expect(config.packages["."]["skip-github-release"]).toBe(true);
  });
  it("skips release PR updates for an explicit manual release commit", () => {
    expect(shouldMaintainReleasePr("refs/heads/main", "chore(release): 7.3.0")).toBe(false);
  });
  it("preserves normal release PR maintenance for feature pushes", () => {
    expect(shouldMaintainReleasePr("refs/heads/main", "feat: add a browser provider")).toBe(true);
  });
  it("does not require a head commit on tag-triggered publication", () => {
    expect(shouldMaintainReleasePr("refs/tags/v7.3.0")).toBe(false);
  });
  it("allows npm publication after release PR maintenance is skipped", () => {
    expect(workflow).toContain("if: always() && !cancelled() && needs.release-please.result != 'failure'");
    expect(workflow).toContain("npm publish --provenance --access public");
  });
});
