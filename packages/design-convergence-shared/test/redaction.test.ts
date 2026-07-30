import { describe, expect, it } from "vitest";
import { REDACTED, isSecretName, redact, redactEnvMap } from "../src/index.js";

describe("isSecretName", () => {
  it("flags secret-bearing names", () => {
    for (const name of [
      "FIGMA_ACCESS_TOKEN",
      "authorization",
      "Cookie",
      "db_password",
      "OPENAI_API_KEY",
      "GH_TOKEN",
      "SESSION_SECRET",
    ]) {
      expect(isSecretName(name)).toBe(true);
    }
  });

  it("does not flag ordinary names (including 'author')", () => {
    for (const name of ["viewport", "caseId", "fileKey", "width", "author"]) {
      expect(isSecretName(name)).toBe(false);
    }
  });
});

describe("redact", () => {
  it("replaces values of secret-named keys, deeply", () => {
    const out = redact({
      FIGMA_ACCESS_TOKEN: "figd_abc",
      nested: { authorization: "Bearer xyz", caseId: "pricing" },
      list: [{ cookie: "sid=1" }],
    }) as {
      FIGMA_ACCESS_TOKEN: string;
      nested: { authorization: string; caseId: string };
      list: Array<{ cookie: string }>;
    };
    expect(out.FIGMA_ACCESS_TOKEN).toBe(REDACTED);
    expect(out.nested.authorization).toBe(REDACTED);
    expect(out.nested.caseId).toBe("pricing");
    expect(out.list[0]!.cookie).toBe(REDACTED);
  });

  it("scrubs known secret values that leak into non-secret fields", () => {
    const out = redact(
      { message: "failed with token figd_supersecret in url" },
      ["figd_supersecret"],
    ) as { message: string };
    expect(out.message).not.toContain("figd_supersecret");
    expect(out.message).toContain(REDACTED);
  });

  it("leaves non-secret data untouched", () => {
    expect(redact({ a: 1, b: "hello", c: null })).toEqual({
      a: 1,
      b: "hello",
      c: null,
    });
  });
});

describe("redactEnvMap", () => {
  it("redacts secret env values but keeps names and non-secret values", () => {
    const out = redactEnvMap({
      FIGMA_ACCESS_TOKEN: "x",
      PATH: "/usr/bin",
      GITHUB_TOKEN: "y",
    });
    expect(out.FIGMA_ACCESS_TOKEN).toBe(REDACTED);
    expect(out.GITHUB_TOKEN).toBe(REDACTED);
    expect(out.PATH).toBe("/usr/bin");
  });
});
