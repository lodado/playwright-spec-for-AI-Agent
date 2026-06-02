# Dashboard QA spec

Generated at: 2026-06-01T13:46:20.424Z

Given / When / Then format from Playwright specs. `judge` sends the same structure to Hermes (not raw JSON).

## How to use this plan

**Given:** preconditions (account, page, fixtures).
**When:** what you do on live (or “do not run” for blocked tests).
**Then:** what must be true — or record skip / manual_review / fail in your JSON verdict.

1. Pick **one** scenario that matches the live account.
2. Run every test in that scenario (each G/W/T block).
3. Also run scenarios marked **always-run**.
4. On **Then**: semantic expectations match **intent**, not exact CI mock numbers.

_Live abstraction: rules (rules 1.0.0)._

---

## Scenarios & tests

