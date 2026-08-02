# QA Native v3 overfitting audit

Production behavior must not depend on a consumer application's routes, product
names, account states, DOM strings, endpoint names, or fixture values. Such data
may appear in tests and run evidence, never in runtime defaults or prompt rules.

## Module audit

| Module | Responsibility | Result |
| --- | --- | --- |
| `static-authority` | annotated IDs, ranges, policy, fixtures | generic; no semantic inference |
| `abstract-playwright` | reviewed Given/When/Then and runtime-local projection | generic; exact authority ID coverage |
| `provider-hermes` | extraction, execution, judge, and review prompts | generic domain vocabulary only |
| `runtime` | budgets, leased capabilities, Playwright I/O, fixture containment | generic origins/actions/evidence only |
| `evidence` | contextual redaction, hashing, HMAC archive | content-agnostic |
| `judge` | sealed evidence to AI verdict | no page or product shortcuts |
| `review` | independent citation grounding | cannot replace verdict |
| `cli` | one pipeline composition and private paths | config supplies all consumer values |
| `report` | pure local Markdown rendering | no repository inspection or mutation |

Removed in v3 because they increased both coupling and overfitting risk:

- AST semantic and matcher inference;
- deterministic semantic verdict shortcuts;
- provider/compiler/mode matrices and strict executor;
- separate applicability AI;
- old artifact readers and compatibility policy aliases in artifacts;
- repository remediation, patch generation, and GitHub publication.

## Regression scan

Before release, scan production code only:

```bash
rg -n -i \
  "deep-ocr|koreadeep|agent-api-dev|/pricing|/dashboard|FREE/BASIC/INACTIVE|Credit.*template|user is on.*plan" \
  packages scripts bin -g '!**/__tests__/**'
```

Any matching branch, prompt example, default route, selector, or business value
is a release blocker.
