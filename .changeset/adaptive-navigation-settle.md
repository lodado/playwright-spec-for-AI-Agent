---
"playwright-spec-for-ai-agent": patch
---

Adaptive gateway now settles the page after every navigation (document fully loaded plus a 300ms DOM-mutation quiet window, capped at 5s and bounded by the remaining run budget) before sealing snapshot evidence, so testids attached only after client hydration reach the judge instead of the pre-hydration SSR markup.
