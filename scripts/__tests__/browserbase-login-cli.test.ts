import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetProjectConfigForTests } from "../hermes-qa-project-config.mjs";
import { EnvironmentError, UsageError } from "../errors.mjs";

const provider = vi.hoisted(() => ({
  resolveBrowserProvider: vi.fn(),
  browserbaseOptions: vi.fn(),
  runBrowserbaseLogin: vi.fn(),
}));
const localLogin = vi.hoisted(() => vi.fn());
vi.mock("../browser-provider.mjs", () => provider);
vi.mock("../qa-browser-session.mjs", async importOriginal => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runOperatorLogin: localLogin,
}));
import { run } from "../run-qa-login.mjs";

const baseArgs = ["--base-url=https://staging.example.test", "--login-path=/sign-in"];
let output: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  resetProjectConfigForTests();
  output = vi.spyOn(console, "log").mockImplementation(() => {});
  provider.resolveBrowserProvider.mockReturnValue("browserbase");
  provider.browserbaseOptions.mockReturnValue({
    profile: "team-qa", timeoutSeconds: 120,
    successUrl: "/dashboard", successSelector: "[data-authenticated]",
  });
  provider.runBrowserbaseLogin.mockResolvedValue({ contextId: "ctx-test", authenticated: true });
  localLogin.mockResolvedValue({ authenticated: true, cookieCount: 2 });
});
afterEach(() => {
  vi.restoreAllMocks();
  resetProjectConfigForTests();
});

function logged() {
  return output.mock.calls.map(args => args.join(" ")).join("\n");
}

describe("Browserbase login CLI", () => {
  it("routes parsed options and the project root to cloud login without launching locally", async () => {
    const argv = [...baseArgs, "--root=/tmp/browserbase-cli-project", "--browser-provider=browserbase",
      "--browserbase-profile=team-qa", "--browserbase-timeout=120", "--success-url=/dashboard",
      "--success-selector=[data-authenticated]"];
    expect(await run(argv)).toBe(0);
    expect(provider.resolveBrowserProvider).toHaveBeenCalledWith(argv);
    expect(provider.browserbaseOptions).toHaveBeenCalledWith(argv);
    expect(provider.runBrowserbaseLogin).toHaveBeenCalledWith({
      root: "/tmp/browserbase-cli-project", loginUrl: "https://staging.example.test/sign-in",
      profile: "team-qa", timeoutSeconds: 120, successUrl: "/dashboard",
      successSelector: "[data-authenticated]",
    });
    expect(localLogin).not.toHaveBeenCalled();
    expect(logged()).toMatch(/Context saved/i);
    expect(logged()).not.toContain("cookies");
  });

  it.each([["--attach"], ["--attach=true"], ["--attach", "true"],
    ["--channel=chrome"], ["--channel", "chrome"]])("rejects local-only flags %j", async (...flags) => {
    await expect(run([...baseArgs, ...flags])).rejects.toBeInstanceOf(UsageError);
    expect(provider.runBrowserbaseLogin).not.toHaveBeenCalled();
    expect(localLogin).not.toHaveBeenCalled();
  });

  it("propagates explicit-success validation without reporting a saved Context", async () => {
    provider.runBrowserbaseLogin.mockRejectedValue(new UsageError("Provide --success-url or --success-selector"));
    await expect(run(baseArgs)).rejects.toBeInstanceOf(UsageError);
    expect(logged()).not.toMatch(/Context saved/i);
    expect(localLogin).not.toHaveBeenCalled();
  });

  it("does not print credentials or other helper result properties", async () => {
    provider.runBrowserbaseLogin.mockResolvedValue({ contextId: "ctx-test", authenticated: true,
      apiKey: "secret-api-key", cookies: [{ value: "secret-cookie" }] });
    await run(baseArgs);
    expect(logged()).not.toMatch(/secret-api-key|secret-cookie/);
  });

  it("shows cloud login help without resolving config or starting a browser", async () => {
    expect(await run(["--help"])).toBe(0);
    expect(logged()).toMatch(/--browser-provider/);
    expect(logged()).toMatch(/--browserbase-profile/);
    expect(logged()).toMatch(/--browserbase-timeout/);
    expect(logged()).toMatch(/600/);
    expect(logged()).toMatch(/--success-url/);
    expect(logged()).toMatch(/--success-selector/);
    expect(logged()).toMatch(/Live View/i);
    expect(provider.resolveBrowserProvider).not.toHaveBeenCalled();
    expect(localLogin).not.toHaveBeenCalled();
  });
});

describe("unchanged local login", () => {
  beforeEach(() => provider.resolveBrowserProvider.mockReturnValue("local"));

  it("keeps headed channel login and the saved cookie message", async () => {
    expect(await run([...baseArgs, "--channel=chrome"])).toBe(0);
    expect(localLogin).toHaveBeenCalledWith({ loginUrl: "https://staging.example.test/sign-in", channel: "chrome" });
    expect(logged()).toContain("Session saved (2 cookies)");
    expect(provider.runBrowserbaseLogin).not.toHaveBeenCalled();
    expect(provider.browserbaseOptions).not.toHaveBeenCalled();
  });

  it("retains default Chromium login", async () => {
    await run(baseArgs);
    expect(localLogin).toHaveBeenCalledWith({ loginUrl: "https://staging.example.test/sign-in", channel: null });
  });

  it("still prints the local attach recipe without launching", async () => {
    expect(await run([...baseArgs, "--attach"])).toBe(0);
    expect(logged()).toContain("--remote-debugging-port=9222");
    expect(localLogin).not.toHaveBeenCalled();
    expect(provider.runBrowserbaseLogin).not.toHaveBeenCalled();
  });

  it("still rejects closing without an authenticated session", async () => {
    localLogin.mockResolvedValue({ authenticated: false, cookieCount: 0 });
    await expect(run(baseArgs)).rejects.toBeInstanceOf(EnvironmentError);
    expect(logged()).not.toContain("Session saved");
  });
});
