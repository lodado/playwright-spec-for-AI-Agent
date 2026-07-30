---
"playwright-spec-for-ai-agent": patch
---

CLI internal errors no longer collapse to an opaque "command failed". stderr now names the failure
category — a CliError's message, or an internal error's stable `.code` or class name — so a failure
is never silently swallowed. The raw message and stack, which may embed sensitive data such as
evidence bytes, stay behind `QA_NATIVE_DEBUG`.
