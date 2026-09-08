import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const bin = resolve("bin/playwright-spec-for-ai-agent.mjs");
function cli(args: string[]) {
  const env = { ...process.env, BROWSERBASE_API_KEY: "", BROWSERBASE_PROJECT_ID: "", QA_BROWSER_PROVIDER: "local" };
  const p = spawnSync(process.execPath, [bin, ...args], { env, encoding: "utf8", timeout: 10000 });
  return { code: p.status, text: p.stdout + p.stderr };
}
describe("Browserbase public CLI options", () => {
  it.each(["login", "judge", "nightly"])("%s help documents provider and profile", command => {
    const p = cli([command, "--help"]);
    expect(p.code).toBe(0); expect(p.text).toContain("--browser-provider"); expect(p.text).toContain("--browserbase-profile");
  });
  it("login help documents success verification", () => {
    expect(cli(["login", "--help"]).text).toContain("--success-url");
  });
  it.each([{ flags: ["--browser-provider=browserbase"] }, { flags: ["--browser-provider", "browserbase"] }])("routes $flags to remote login instead of opening local Chrome", ({ flags }) => {
    const p = cli(["login", ...flags, "--base-url=https://app.example.test", "--login-path=/login"]);
    expect(p.code).toBe(2); expect(p.text).toMatch(/success-url|success-selector/);
    expect(p.text).not.toContain("Opening https");
  });
  it("forwards success and timeout values in space-separated form", () => {
    const p = cli(["login", "--browser-provider", "browserbase", "--base-url=https://app.example.test", "--success-url", "/dashboard", "--browserbase-timeout", "120"]);
    expect(p.code).toBe(3); expect(p.text).toContain("BROWSERBASE_API_KEY");
    expect(p.text).not.toContain("requires --success-url");
  });
});
