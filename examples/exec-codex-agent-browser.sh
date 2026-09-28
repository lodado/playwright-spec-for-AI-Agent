#!/usr/bin/env bash
# Exec-adapter wrapper: Codex drives the runner's browser through the agent-browser CLI.
#
#   export QA_AI_ADAPTER=exec
#   export QA_AGENT_AUTH=cdp-attach
#   export QA_AGENT_CMD="$PWD/examples/exec-codex-agent-browser.sh"
#
# The judge prompt arrives on stdin; the final JSON answer goes to stdout.
# Requires authenticated `codex` and `agent-browser` on PATH. QA_CODEX_MODEL is optional.
set -euo pipefail
: "${BROWSER_CDP_URL:?BROWSER_CDP_URL is set by the judge runner; run this through QA_AGENT_CMD}"

session="qa-$$"
out="$(mktemp)"
trap 'rm -f "$out"' EXIT

preamble="BROWSER ACCESS: the staging browser is already open and signed in. Drive it ONLY with the agent-browser CLI from the shell, always passing --session $session.
First run: agent-browser --session $session connect \"$BROWSER_CDP_URL\", then agent-browser --session $session tab list, and select the staging tab.
Commands: snapshot -i (refs @eN), click @eN, fill @eN \"text\", press Tab|Enter, get text @eN. Take a new snapshot after every page change.
Never launch another browser and never leave the allowed origin. Your final message must be ONLY the JSON object the task asks for.
---
"

# --ignore-user-config keeps personal MCP servers, hooks and instructions out of the run.
# The shell policy override lets the agent's shell see QA_BROWSER_TOOLS_TOKEN, which
# Codex otherwise strips from any variable whose name contains TOKEN; qa_checkpoint needs it.
{ printf '%s' "$preamble"; cat; } | codex exec \
  --skip-git-repo-check --ignore-user-config --ephemeral \
  ${QA_CODEX_MODEL:+-m "$QA_CODEX_MODEL"} \
  -c shell_environment_policy.ignore_default_excludes=true \
  --dangerously-bypass-approvals-and-sandbox \
  -o "$out" - >&2

cat "$out"
