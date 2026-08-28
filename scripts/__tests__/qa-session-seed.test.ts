import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EnvironmentError, UsageError } from "../errors.mjs";
import {
  assertSeedableCookies,
  buildAsideSeedScript,
  buildLocalStorageEntries,
  cookiesForOrigin,
  readStorageState,
} from "../qa-session-seed.mjs";

const dirs: string[] = [];

function stateFile(body: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "qa-seed-"));
  dirs.push(dir);
  const path = join(dir, "demo.json");
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const STATE = {
  cookies: [
    { name: "authjs.session-token", value: "tok", domain: "localhost", path: "/" },
    { name: "other", value: "x", domain: "elsewhere.test", path: "/" },
  ],
  origins: [
    {
      origin: "http://localhost:3000",
      localStorage: [{ name: "device-id", value: "demo" }],
    },
  ],
};

describe("storage state reading", () => {
  it("reads cookies and origins", () => {
    const state = readStorageState(stateFile(STATE));
    expect(state.cookies).toHaveLength(2);
    expect(state.origins).toHaveLength(1);
  });

  it("names the file when it is missing, malformed, or empty", () => {
    expect(() => readStorageState("/nope/demo.json")).toThrow(UsageError);
    expect(() => readStorageState(stateFile("{ not json"))).toThrow(
      /not valid JSON/,
    );
    expect(() => readStorageState(stateFile({ cookies: [], origins: [] }))).toThrow(
      /no cookies and no origins/,
    );
  });
});

describe("origin scoping", () => {
  it("keeps only cookies whose domain covers the target host", () => {
    const kept = cookiesForOrigin(STATE.cookies, "http://localhost:3000");
    expect(kept.map(cookie => cookie.name)).toEqual(["authjs.session-token"]);
  });

  it("matches a parent domain but not an unrelated host", () => {
    const cookies = [{ name: "s", value: "1", domain: ".example.org", path: "/" }];
    expect(cookiesForOrigin(cookies, "https://app.example.org")).toHaveLength(1);
    expect(cookiesForOrigin(cookies, "https://example.net")).toHaveLength(0);
  });

  it("picks localStorage for the exact origin only", () => {
    expect(buildLocalStorageEntries(STATE.origins, "http://localhost:3000")).toEqual([
      { name: "device-id", value: "demo" },
    ]);
    expect(buildLocalStorageEntries(STATE.origins, "http://other:3000")).toEqual([]);
  });
});

describe("seedability", () => {
  it("refuses httpOnly cookies for the document.cookie path", () => {
    expect(() =>
      assertSeedableCookies([{ name: "sid", httpOnly: true }], { via: "aside repl" }),
    ).toThrow(EnvironmentError);
    // The whole point is to fail loudly instead of judging as an anonymous
    // visitor, and to name the path that would work.
    try {
      assertSeedableCookies([{ name: "sid", httpOnly: true }], {
        via: "aside repl",
      });
      throw new Error("expected assertSeedableCookies to throw");
    } catch (error) {
      expect((error as { hint?: string }).hint).toMatch(/cdp-attach/);
    }
  });

  it("accepts non-httpOnly cookies", () => {
    expect(() =>
      assertSeedableCookies([{ name: "sid" }], { via: "aside repl" }),
    ).not.toThrow();
  });
});

describe("aside seed script", () => {
  it("is a single line the repl can evaluate, carrying cookies and storage", () => {
    const script = buildAsideSeedScript({
      origin: "http://localhost:3000",
      cookies: [{ name: "authjs.session-token", value: "tok", path: "/" }],
      localStorage: [{ name: "device-id", value: "demo" }],
    });

    expect(script.trimEnd().split("\n")).toHaveLength(1);
    expect(script).toContain("http://localhost:3000");
    expect(script).toContain("authjs.session-token");
    expect(script).toContain("device-id");
    expect(script).toContain("p.reload()");
    expect(script.endsWith("\n")).toBe(true);
  });
});

describe("attach recipe", () => {
  it("names a dedicated profile, never the operator's everyday one", async () => {
    const { attachRecipe } = await import("../run-qa-login.mjs");
    const recipe = attachRecipe("https://staging.acmecorp.com/login");

    expect(recipe).toContain("--remote-debugging-port=9222");
    expect(recipe).toContain("--user-data-dir=/tmp/qa-chrome");
    expect(recipe).toContain("--cdp-url=http://127.0.0.1:9222");
    // The warning is the point: attaching to the main profile would hand the
    // agent every session the operator has.
    expect(recipe).toMatch(/Do not point this at your main/);
  });
});

describe("attach url resolution", () => {
  it("prefers the flag, falls back to the environment, else empty", async () => {
    const { resolveAttachUrl } = await import("../run-hermes-page-judge.mjs");
    expect(resolveAttachUrl(["--cdp-url=http://127.0.0.1:9222"])).toBe(
      "http://127.0.0.1:9222",
    );
    expect(resolveAttachUrl([])).toBe("");
    process.env.QA_BROWSER_CDP_URL = "http://127.0.0.1:9333";
    try {
      expect(resolveAttachUrl([])).toBe("http://127.0.0.1:9333");
      expect(resolveAttachUrl(["--cdp-url=http://127.0.0.1:9222"])).toBe(
        "http://127.0.0.1:9222",
      );
    } finally {
      delete process.env.QA_BROWSER_CDP_URL;
    }
  });
});
