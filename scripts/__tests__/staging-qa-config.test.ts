import { describe, expect, it } from "vitest";
import {
  assertStagingQaCredentials,
  buildHermesStagingLogin,
  buildJudgeTargetUrl,
  displayPathForJudgeTarget,
  isAuthRequired,
  parseStagingQaArgs,
  parseTargetInput,
  resolveFinalJudgeTarget,
} from "../staging-qa-config.mjs";

describe("buildJudgeTargetUrl", () => {
  it("uses pageUrl when set", () => {
    expect(
      buildJudgeTargetUrl(
        { pageUrl: "https://staging.example.com/ko/home", targetPath: null },
        "https://ignored.example.com",
      ),
    ).toBe("https://staging.example.com/ko/home");
  });

  it("joins targetPath with baseUrl", () => {
    expect(
      buildJudgeTargetUrl(
        { targetPath: "/pricing", pageUrl: null },
        "https://staging.example.com",
      ),
    ).toBe("https://staging.example.com/pricing");
  });
});

describe("parseTargetInput", () => {
  it("accepts full URLs", () => {
    expect(
      parseTargetInput("https://staging.example.com/ko", "https://x.com"),
    ).toEqual({
      pageUrl: "https://staging.example.com/ko",
      targetPath: "/ko",
    });
  });

  it("accepts relative paths", () => {
    expect(parseTargetInput("/billing", "https://staging.example.com")).toEqual(
      {
        pageUrl: "https://staging.example.com/billing",
        targetPath: "/billing",
      },
    );
  });
});

describe("displayPathForJudgeTarget", () => {
  it("returns pathname for pageUrl", () => {
    expect(
      displayPathForJudgeTarget({
        pageUrl: "https://staging.example.com/ko?tab=1",
        targetPath: null,
      }),
    ).toBe("/ko?tab=1");
  });

  it("returns targetPath when pageUrl is absent", () => {
    expect(
      displayPathForJudgeTarget({
        targetPath: "/pricing",
        pageUrl: null,
      }),
    ).toBe("/pricing");
  });
});

describe("resolveFinalJudgeTarget", () => {
  it("returns initial target when confirmed", () => {
    const target = { targetPath: "/a", pageUrl: null };
    expect(
      resolveFinalJudgeTarget(target, "https://staging.example.com", {
        confirmed: true,
      }),
    ).toBe(target);
  });
});

describe("authRequired", () => {
  it("parses --auth-required=false", () => {
    const config = parseStagingQaArgs(["--auth-required=false"]);

    expect(isAuthRequired(config)).toBe(false);
  });

  it("does not require credentials when authRequired is false", () => {
    expect(() =>
      assertStagingQaCredentials({
        authRequired: false,
        email: "",
        password: "",
      }),
    ).not.toThrow();
  });

  it("omits credentials from the staging login payload when auth is disabled", () => {
    const payload = buildHermesStagingLogin({
      authRequired: false,
      email: "qa@example.com",
      password: "secret",
      baseUrl: "https://staging.example.com",
      loginPath: "/login",
      dashboardPath: "/dashboard",
    });

    expect(payload).toMatchObject({
      authRequired: false,
      email: "",
      password: "",
      loginUrl: "https://staging.example.com/login",
    });
  });
});
