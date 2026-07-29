#!/usr/bin/env node
// Secret-free smoke test for the Hermes runner: verifies the installed
// hermes-agent CLI speaks the --query/--max_turns contract and that the
// configured inference credential is accepted. Emits no secrets — runHermes
// already redacts its errors, and this script adds no output of its own on
// failure. Run manually on an operator machine; never in CI.
import { probeHermesRunnerProtocol, runHermes } from "./hermes-runner.mjs";

probeHermesRunnerProtocol();

const result = runHermes(
  'Return exactly this JSON and nothing else: {"status":"ok"}',
  1,
  { mode: "text-only", requiredKeys: ["status"], timeoutMs: 120_000 },
);

if (result.status !== "ok") {
  throw new Error("Hermes smoke response did not validate");
}

console.log("PASS: hermes-agent protocol + inference credential OK");
