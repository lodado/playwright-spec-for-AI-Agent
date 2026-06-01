const CRITERION_IDS = ["sufficient-evidence", "not-overly-pedantic"];

const CRITERION_QUESTIONS = {
  "sufficient-evidence":
    "Were the live QA checks conducted in a generally reasonable way, with enough observational evidence in each check detail to trust the results?",
  "not-overly-pedantic":
    "Did the judge avoid overly narrow pass/fail calls (e.g. requiring an exact template name like '세금계산서' when the intent was only that a template is visible)?",
};

const ALLOWED_VERDICTS = new Set(["pass", "concern", "fail"]);
const ALLOWED_OVERALL = new Set(["approved", "flagged"]);

export function formatJudgmentForReview(judgment) {
  const lines = [
    `# Judge results`,
    "",
    `- **Overall status:** ${judgment.status ?? "unknown"}`,
    `- **Summary:** ${judgment.summary ?? "(none)"}`,
    "",
  ];

  if (judgment.evidence?.length) {
    lines.push("## Evidence (judge)", "");
    for (const item of judgment.evidence) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  if (judgment.checks?.length) {
    lines.push("## Per-test checks", "");
    for (const check of judgment.checks) {
      lines.push(
        `### ${check.item}`,
        "",
        `- **Result:** ${check.result}`,
        `- **Detail:** ${check.detail || "(no detail)"}`,
        ""
      );
    }
  }

  if (judgment.recommendedAction) {
    lines.push("## Recommended action", "", judgment.recommendedAction, "");
  }

  return lines.join("\n");
}

export function normalizeJudgeReview(raw, judgment) {
  const criteria = CRITERION_IDS.map(id => {
    const incoming = (raw.criteria ?? []).find(
      entry => entry?.id === id || entry?.criterionId === id
    );
    const verdict = ALLOWED_VERDICTS.has(incoming?.verdict)
      ? incoming.verdict
      : "concern";

    return {
      id,
      question: CRITERION_QUESTIONS[id],
      verdict,
      detail: String(incoming?.detail ?? "No detail provided by reviewer."),
      affectedChecks: Array.isArray(incoming?.affectedChecks)
        ? incoming.affectedChecks.map(String)
        : [],
      ...(id === "not-overly-pedantic" && Array.isArray(incoming?.pedanticExamples)
        ? {
            pedanticExamples: incoming.pedanticExamples.map(String),
          }
        : {}),
    };
  });

  const hasFail = criteria.some(c => c.verdict === "fail");
  const hasConcern = criteria.some(c => c.verdict === "concern");

  const overallReview = ALLOWED_OVERALL.has(raw.overallReview)
    ? raw.overallReview
    : hasFail || hasConcern
      ? "flagged"
      : "approved";

  const recommendations = Array.isArray(raw.recommendations)
    ? raw.recommendations.map(entry => ({
        item: String(entry?.item ?? ""),
        currentResult: String(entry?.currentResult ?? ""),
        suggestedResult: String(entry?.suggestedResult ?? ""),
        reason: String(entry?.reason ?? ""),
      }))
    : [];

  return {
    overallReview,
    summary: String(raw.summary ?? "Judge review completed."),
    criteria,
    recommendations,
    reviewedJudgment: {
      status: judgment.status,
      summary: judgment.summary,
      checks: judgment.checks ?? [],
    },
    source: raw.source ?? "hermes-agent",
    reviewedAt: new Date().toISOString(),
  };
}

export function reviewWarrantsExitCode(review) {
  if (review.overallReview === "flagged") return true;
  return review.criteria.some(
    c => c.verdict === "fail" || c.verdict === "concern"
  );
}
