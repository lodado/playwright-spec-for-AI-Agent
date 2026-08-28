import { describe, expect, it } from "vitest";
import { UsageError } from "../errors.mjs";
import {
  assertRealBaseUrl,
  assertStagingQaCredentials,
  buildHermesStagingLogin,
  buildJudgeTargetUrl,
  DEFAULT_BASE_URL,
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
        { pageUrl: "https://staging.acmecorp.com/ko/home", targetPath: null },
        "https://ignored.example.com",
      ),
    ).toBe("https://staging.acmecorp.com/ko/home");
  });

  it("joins targetPath with baseUrl", () => {
    expect(
      buildJudgeTargetUrl(
        { targetPath: "/pricing", pageUrl: null },
        "https://staging.acmecorp.com",
      ),
    ).toBe("https://staging.acmecorp.com/pricing");
  });
});

describe("parseTargetInput", () => {
  it("accepts full URLs", () => {
    expect(
      parseTargetInput("https://staging.acmecorp.com/ko", "https://x.com"),
    ).toEqual({
      pageUrl: "https://staging.acmecorp.com/ko",
      targetPath: "/ko",
    });
  });

  it("accepts relative paths", () => {
    expect(parseTargetInput("/billing", "https://staging.acmecorp.com")).toEqual(
      {
        pageUrl: "https://staging.acmecorp.com/billing",
        targetPath: "/billing",
      },
    );
  });
});

describe("displayPathForJudgeTarget", () => {
  it("returns pathname for pageUrl", () => {
    expect(
      displayPathForJudgeTarget({
        pageUrl: "https://staging.acmecorp.com/ko?tab=1",
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
      resolveFinalJudgeTarget(target, "https://staging.acmecorp.com", {
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
      baseUrl: "https://staging.acmecorp.com",
      loginPath: "/login",
      dashboardPath: "/dashboard",
    });

    expect(payload).toMatchObject({
      authRequired: false,
      email: "",
      password: "",
      loginUrl: "https://staging.acmecorp.com/login",
    });
  });
});

describe("assertRealBaseUrl", () => {
  it("rejects the packaged placeholder origin", () => {
    expect(() => assertRealBaseUrl({ baseUrl: DEFAULT_BASE_URL })).toThrow(
      UsageError,
    );
  });

  it("rejects an empty base URL", () => {
    expect(() => assertRealBaseUrl({ baseUrl: "" })).toThrow(UsageError);
  });

  it("accepts a real staging origin", () => {
    expect(() =>
      assertRealBaseUrl({ baseUrl: "https://staging.acmecorp.com" }),
    ).not.toThrow();
  });
});

describe("expected account state", () => {
  it("accepts --expected-account-state and the legacy status flag", () => {
    expect(
      parseStagingQaArgs(["--expected-account-state=trial"]),
    ).toMatchObject({
      expectedAccountState: "trial",
      expectedSubscriptionStatus: "trial",
    });

    expect(
      parseStagingQaArgs(["--expected-subscription-status=ACTIVE"]),
    ).toMatchObject({
      expectedAccountState: "ACTIVE",
      expectedSubscriptionStatus: "ACTIVE",
    });
  });

  it("reports the account state under the de-branded name", () => {
    const payload = buildHermesStagingLogin({
      authRequired: false,
      baseUrl: "https://staging.acmecorp.com",
      loginPath: "/login",
      dashboardPath: "/dashboard",
      expectedSubscriptionStatus: "TRIAL_EXPIRED",
    });

    expect(payload.expectedAccountState).toBe("TRIAL_EXPIRED");
    expect(payload).not.toHaveProperty("expectedSubscriptionStatus");
  });
});
