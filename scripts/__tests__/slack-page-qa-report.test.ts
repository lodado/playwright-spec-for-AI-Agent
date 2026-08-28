import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProjectConfig,
  resetProjectConfigForTests,
} from "../hermes-qa-project-config.mjs";
import {
  activeAcks,
  buildPayload,
  buildQuarantinePayload,
  escapeMrkdwn,
  parseNotifyMode,
  resolveBaseUrl,
  selectAlertChecks,
  shouldNotify,
  statusLabel,
} from "../slack-page-qa-report.mjs";

const BASE_URL = "https://staging.acme.test";

function textOf(payload: any): string {
  return payload.blocks
    .map((block: any) =>
      block.text?.text ??
      (block.fields ?? block.elements ?? [])
        .map((field: any) => field.text)
        .join("\n")
    )
    .join("\n");
}

function judgment(overrides: Record<string, unknown> = {}) {
  return {
    status: "fail",
    summary: "Billing panel never rendered.",
    source: "hermes-agent",
    evidence: ["screenshot: billing.png"],
    recommendedAction: "Roll back the billing deploy.",
    checks: [
      { item: "renders plan card", result: "pass", detail: "visible" },
      { item: "renders invoices", result: "fail", detail: "empty table" },
      {
        item: "shows renewal date",
        result: "manual_review",
        detail: "date format ambiguous",
      },
    ],
    ...overrides,
  };
}

describe("verdict handling", () => {
  it("labels skip and unknown verdicts as themselves, never as a pass", () => {
    expect(statusLabel("skip")).toBe("SKIPPED");
    expect(statusLabel("errored")).toBe("UNKNOWN");
    expect(statusLabel(undefined)).toBe("UNKNOWN");
    expect(statusLabel("pass")).toBe("PASS");
  });

  it("notifies for every non-pass verdict under the default mode", () => {
    expect(shouldNotify("fail")).toBe(true);
    expect(shouldNotify("manual_review")).toBe(true);
    expect(shouldNotify("skip")).toBe(true);
    expect(shouldNotify("unknown")).toBe(true);
    expect(shouldNotify("pass")).toBe(false);
  });

  it("honours --notify=always and --notify=never", () => {
    expect(shouldNotify("pass", "always")).toBe(true);
    expect(shouldNotify("fail", "never")).toBe(false);
  });

  it("rejects an unknown --notify value", () => {
    expect(parseNotifyMode([])).toBe("failures");
    expect(parseNotifyMode(["--notify=always"])).toBe("always");
    expect(() => parseNotifyMode(["--notify=sometimes"])).toThrow(
      /Unknown --notify/
    );
  });
});

describe("buildPayload", () => {
  it("lists only failing checks, with their details", () => {
    const payload = buildPayload({
      page: "dashboard",
      targetPath: "/dashboard",
      judgment: judgment(),
      baseUrl: BASE_URL,
    });
    const text = textOf(payload);

    expect(text).toContain("• renders invoices — empty table");
    expect(text).toContain("• shows renewal date — date format ambiguous");
    expect(text).not.toContain("renders plan card");
    expect(text).toContain("*Failing checks (2):*");
  });

  it("truncates long details and caps the check list", () => {
    const checks = Array.from({ length: 13 }, (_, index) => ({
      item: `check ${index}`,
      result: "fail",
      detail: "x".repeat(400),
    }));
    const text = textOf(
      buildPayload({
        page: "dashboard",
        judgment: judgment({ checks }),
        baseUrl: BASE_URL,
      })
    );

    expect(text).toContain("+3 more");
    expect(text).not.toContain("x".repeat(200));
    expect(text).toContain("…");
  });

  it("carries the recommended action and the rerun command", () => {
    const text = textOf(
      buildPayload({
        page: "pricing",
        judgment: judgment(),
        baseUrl: BASE_URL,
      })
    );

    expect(text).toContain("*Recommended action:*");
    expect(text).toContain("Roll back the billing deploy.");
    expect(text).toContain(
      "npx playwright-spec-for-ai-agent judge --page=pricing"
    );
  });

  it("includes run identity when the judgment carries it", () => {
    const text = textOf(
      buildPayload({
        page: "dashboard",
        judgment: judgment({
          runId: "run-1234abcd",
          judgedAt: "2026-08-28T02:00:00.000Z",
          agentMeta: { adapter: "hermes", model: "opus" },
        }),
        baseUrl: BASE_URL,
      })
    );

    expect(text).toContain("run-1234abcd");
    expect(text).toContain("hermes (opus)");
    expect(text).toContain("2026-08-28T02:00:00.000Z");
  });

  it("omits run identity entirely for an older judgment artifact", () => {
    const payload = buildPayload({
      page: "dashboard",
      judgment: judgment(),
      baseUrl: BASE_URL,
    });
    const context = payload.blocks.at(-1) as any;

    expect(context.type).toBe("context");
    expect(context.elements).toHaveLength(1);
  });

  it("links the target through the resolved base URL", () => {
    const text = textOf(
      buildPayload({
        page: "dashboard",
        targetPath: "/dashboard",
        judgment: judgment(),
        baseUrl: BASE_URL,
      })
    );

    expect(text).toContain(`<${BASE_URL}/dashboard|${BASE_URL}/dashboard>`);
  });

  it("omits the link rather than pointing at a placeholder domain", () => {
    for (const baseUrl of ["", "https://your-staging-url.example.com"]) {
      const text = textOf(
        buildPayload({
          page: "dashboard",
          targetPath: "/dashboard",
          judgment: judgment(),
          baseUrl,
        })
      );

      expect(text).toContain("*Target:* /dashboard");
      expect(text).not.toContain("your-staging-url");
      expect(text).not.toContain("<http");
    }
  });

  it("posts a compact heartbeat for a pass", () => {
    const payload = buildPayload({
      page: "dashboard",
      targetPath: "/dashboard",
      judgment: judgment({ status: "pass", checks: [], summary: "All green." }),
      baseUrl: BASE_URL,
    });

    expect(payload.blocks).toHaveLength(1);
    expect(payload.text).toBe("[PASS] Nightly dashboard QA: pass");
  });

  it("labels an unrecognised verdict UNKNOWN instead of PASS", () => {
    const payload = buildPayload({
      page: "dashboard",
      judgment: judgment({ status: "errored" }),
      baseUrl: BASE_URL,
    });

    expect(payload.text).toBe("[UNKNOWN] Nightly dashboard QA: errored");
    expect(payload.blocks.length).toBeGreaterThan(1);
  });

  it("escapes Slack mrkdwn control characters in agent-derived text", () => {
    const text = textOf(
      buildPayload({
        page: "dashboard",
        judgment: judgment({
          summary: "<script>alert(1)</script> A & B",
          evidence: ["saw <b>bold</b> & broken copy"],
          checks: [
            {
              item: "<title> check",
              result: "fail",
              detail: "expected A & B, got <nothing>",
            },
          ],
        }),
        baseUrl: BASE_URL,
      })
    );

    expect(text).toContain("&lt;script&gt;alert(1)&lt;/script&gt; A &amp; B");
    expect(text).toContain("&lt;title&gt; check");
    expect(text).toContain("expected A &amp; B, got &lt;nothing&gt;");
    expect(text).toContain("saw &lt;b&gt;bold&lt;/b&gt; &amp; broken copy");
    expect(text).not.toMatch(/<script>/);
  });

  it("adds the review verdict line when a review artifact exists", () => {
    const text = textOf(
      buildPayload({
        page: "dashboard",
        judgment: judgment(),
        baseUrl: BASE_URL,
        review: {
          overallReview: "flagged",
          criteria: [
            { id: "sufficient-evidence", verdict: "concern", detail: "thin" },
            { id: "not-overly-pedantic", verdict: "pass", detail: "fine" },
          ],
        },
      })
    );

    expect(text).toContain("*Judge review:* flagged — flagged: sufficient-evidence");
    expect(text).not.toContain("not-overly-pedantic");
  });

  it("has no review line when the review stage never ran", () => {
    const text = textOf(
      buildPayload({ page: "dashboard", judgment: judgment(), baseUrl: BASE_URL })
    );
    expect(text).not.toContain("Judge review");
  });
});

describe("ack filtering", () => {
  it("keeps unexpired acks and drops expired or item-less ones", () => {
    const now = new Date("2026-08-28T00:00:00.000Z");
    const acks = activeAcks(
      {
        acks: [
          { item: "forever", reason: "known", by: "lee" },
          { item: "future", until: "2026-09-01T00:00:00.000Z" },
          { item: "expired", until: "2026-08-01T00:00:00.000Z" },
          { item: "garbage", until: "not-a-date" },
          { reason: "no item" },
        ],
      },
      now
    );

    expect(acks.map(ack => ack.item)).toEqual(["forever", "future"]);
  });

  it("suppresses acked checks from the body and counts them in the header", () => {
    const payload = buildPayload({
      page: "dashboard",
      judgment: judgment(),
      baseUrl: BASE_URL,
      acks: [{ item: "renders invoices" }],
    });
    const text = textOf(payload);

    expect(payload.text).toBe("[FAIL] Nightly dashboard QA: fail (1 acked)");
    expect(text).not.toContain("empty table");
    expect(text).toContain("• shows renewal date");
  });

  it("ignores acks that match no failing check", () => {
    const { visible, ackedCount } = selectAlertChecks(
      judgment().checks,
      new Set(["renders plan card"])
    );

    expect(ackedCount).toBe(0);
    expect(visible).toHaveLength(2);
  });
});

describe("buildQuarantinePayload", () => {
  it("reports an ERRORED run carrying the marker reason", () => {
    const payload = buildQuarantinePayload({
      page: "dashboard",
      targetPath: "/dashboard",
      baseUrl: BASE_URL,
      marker: {
        reason: "hermes exited 1 before writing a verdict",
        at: "2026-08-28T02:03:04.000Z",
      },
    });
    const text = textOf(payload);

    expect(payload.text).toBe(
      "[ERRORED] Nightly dashboard QA: judge run quarantined"
    );
    expect(text).toContain("hermes exited 1 before writing a verdict");
    expect(text).toContain("2026-08-28T02:03:04.000Z");
    expect(text).toContain("this is not a pass");
    expect(text).toContain(
      "npx playwright-spec-for-ai-agent judge --page=dashboard"
    );
  });
});

describe("resolveBaseUrl", () => {
  beforeEach(async () => {
    resetProjectConfigForTests();
    await loadProjectConfig(["--project-root=/tmp/slack-report-fixture"]);
  });

  afterEach(() => {
    delete process.env.STAGING_QA_BASE_URL;
    resetProjectConfigForTests();
  });

  it("prefers --base-url over the environment", () => {
    process.env.STAGING_QA_BASE_URL = "https://env.acme.test";
    expect(resolveBaseUrl(["--base-url=https://cli.acme.test"])).toBe(
      "https://cli.acme.test"
    );
  });

  it("falls back to the environment, then to nothing at all", () => {
    process.env.STAGING_QA_BASE_URL = "https://env.acme.test";
    expect(resolveBaseUrl([])).toBe("https://env.acme.test");
    delete process.env.STAGING_QA_BASE_URL;
    expect(resolveBaseUrl([])).toBe("");
  });
});

describe("escapeMrkdwn", () => {
  it("escapes ampersands before angle brackets", () => {
    expect(escapeMrkdwn("<a> & <b>")).toBe("&lt;a&gt; &amp; &lt;b&gt;");
    expect(escapeMrkdwn(undefined)).toBe("");
  });
});
