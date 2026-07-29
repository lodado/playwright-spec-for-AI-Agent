---
"playwright-spec-for-ai-agent": patch
---

Compile role-only Playwright locators (e.g. `getByRole("dialog")`) instead of throwing: role alone is a valid semantic identity, so `accessibleName` is now attached only when the locator carries an explicit name.
