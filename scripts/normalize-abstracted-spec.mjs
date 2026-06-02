/**
 * Attach Hermes abstract-ai livePlan to the rule-abstracted spec (no validation).
 */

export function normalizeAbstractAiResult(inputSpec, raw) {
  const livePlan =
    typeof raw?.livePlan === "string" ? raw.livePlan.trim() : "";
  const model = process.env.HERMES_INFERENCE_MODEL?.trim() || null;

  return {
    ok: true,
    livePlan: livePlan || null,
    spec: {
      ...inputSpec,
      abstraction: {
        ...(inputSpec.abstraction ?? {}),
        rulesVersion: inputSpec.abstraction?.rulesVersion,
        aiAppliedAt: new Date().toISOString(),
        stage: livePlan ? "rules+ai-gwt" : "rules",
        aiModel: model,
      },
    },
    audit: {
      generatedAt: new Date().toISOString(),
      livePlanChars: livePlan.length,
    },
  };
}
