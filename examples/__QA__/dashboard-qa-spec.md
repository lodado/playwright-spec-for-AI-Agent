# Dashboard QA Spec

Generated at: 2026-05-30T17:05:11.854Z

Parsed from `src/page/dashboard/__tests__/` Playwright specs.
Playwright `node scripts/run-staging-page-ai-qa.mjs` replays **read-only** expectations for the inferred scenario.
Hermes browse judge replays tests with `liveRunPolicy: executable-interaction` — safe actions that need live verification, not DOM-only checks.
Subscription/billing mutations, auth mocks, and `@qa-live-skip` stay blocked.
`judgment-mock-api` tests skip on Playwright but Hermes judges live equivalents.

## Dashboard — ACTIVE subscription

- Scenario ID: `ACTIVE`
- Source: `dashboard-active.spec.ts`

### to be: username and plan name appear in the title

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `visible`: {"type":"visible","locator":{"kind":"text","value":"dev-user is on the Basic plan"}}

### to be: subtitle shows 'Check your remaining credits'

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `containText`: {"type":"containText","locator":{"kind":"testId","value":"dashboard-subtitle"},"expected":{"kind":"literal","value":"Check your remaining credits"}}

### to be: remaining credits '42,835' are displayed

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `containText`: {"type":"containText","locator":{"kind":"testId","value":"credit-remaining"},"expected":{"kind":"regex","pattern":"[\\d,]+"},"liveNote":"mock numeric fixture; live uses digit wildcard matching"}

### to be: 'Subscription info' section is visible

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `visible`: {"type":"visible","locator":{"kind":"text","value":"Subscription info"}}

### to be: 'Cancel subscription' link is enabled (clickable)

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `visible`: {"type":"visible","locator":{"kind":"testId","value":"subscription-cancel-link"}}
  - `notVisible`: {"type":"notVisible","locator":{"kind":"testId","value":"subscription-disabled-link"}}

### to be: subscription history dialog opens

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: dialog closes via Confirm button

- Staging mode: `interaction`
- Live run policy: `judgment-interaction-no-confirm`
- QA annotation: `@qa-live-policy: safe-interaction-no-confirm`
- Live run: UI action where completing verification would be dangerous on live — Hermes replays safe open steps, verifies up to the dangerous point, dismisses with Esc only (never clicks confirm)

### to be: dialog closes via Close (X) button

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: dialog closes via Escape key

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: cancel subscription dialog opens

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: dialog closes via Cancel button

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: dialog closes via Close (X) button

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: Confirm button is disabled when no cancel reason is selected

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: Confirm button is enabled when one cancel reason is selected

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: redirects to /login

- Staging mode: `auth`
- Live run policy: `blocked-auth-mock`
- QA annotation: `@qa-live-policy: auth-mock`
- Live run: skipped (requires mocked unauthenticated flow)

## Dashboard — CANCEL_PENDING (cancel scheduled)

- Scenario ID: `CANCEL_PENDING`
- Source: `dashboard-cancel-pending.spec.ts`

### to be: subtitle shows 'Subscription cancellation is scheduled'

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `containText`: {"type":"containText","locator":{"kind":"testId","value":"dashboard-subtitle"},"expected":{"kind":"literal","value":"Subscription cancellation is scheduled"}}

### to be: 'Resume subscription' link is enabled (clickable)

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `visible`: {"type":"visible","locator":{"kind":"testId","value":"subscription-resume-link"}}
  - `notVisible`: {"type":"notVisible","locator":{"kind":"testId","value":"subscription-cancel-link"}}
  - `notVisible`: {"type":"notVisible","locator":{"kind":"testId","value":"subscription-disabled-link"}}

### to be: remaining credit amount is displayed

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `containText`: {"type":"containText","locator":{"kind":"testId","value":"credit-remaining"},"expected":{"kind":"regex","pattern":"[\\d,]+"},"liveNote":"mock numeric fixture; live uses digit wildcard matching"}

### to be: resume subscription dialog opens

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: dialog closes via Cancel button

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: dialog closes via Close (X) button

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: subscription history dialog opens

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: dialog closes via Confirm button

- Staging mode: `interaction`
- Live run policy: `judgment-interaction-no-confirm`
- QA annotation: `@qa-live-policy: safe-interaction-no-confirm`
- Live run: UI action where completing verification would be dangerous on live — Hermes replays safe open steps, verifies up to the dangerous point, dismisses with Esc only (never clicks confirm)

### to be: subtitle shows 'Subscription resume completed'

- Staging mode: `interaction`
- Live run policy: `blocked-subscription-mutation`
- QA annotation: `@qa-live-policy: subscription-mutation`
- Live run: skipped on Playwright; Hermes must not mutate subscription/billing

## Dashboard credit display — BVA (summary.remaining_credits)

- Scenario ID: `CREDIT_BVA`
- Source: `dashboard-credit-bva.spec.ts`
- Always run: **yes** (runs on every Hermes browse, regardless of plan/status)

### to be: when remaining_credits is 0, shows 0 remaining credits

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `containText`: {"type":"containText","locator":{"kind":"testId","value":"credit-remaining"},"expected":{"kind":"regex","pattern":"Credit [\\d,]+"},"liveNote":"mock numeric fixture; live uses digit wildcard matching"}

### to be: when remaining_credits is positive, shows that value

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `containText`: {"type":"containText","locator":{"kind":"testId","value":"credit-remaining"},"expected":{"kind":"regex","pattern":"^Credit [\\d,]+$"},"liveNote":"mock dynamic credit; live uses numeric wildcard matching"}

## Dashboard — INACTIVE/FREE plan (lower boundary)

- Scenario ID: `INACTIVE`
- Source: `dashboard-inactive.spec.ts`

### to be: username and 'Free plan' text appear in the title

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `visible`: {"type":"visible","locator":{"kind":"text","value":"dev-user is on the Free plan"}}

### to be: subtitle shows 'Check your remaining credits'

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `containText`: {"type":"containText","locator":{"kind":"testId","value":"dashboard-subtitle"},"expected":{"kind":"literal","value":"Check your remaining credits"}}

### to be: credit balance shows 0

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `containText`: {"type":"containText","locator":{"kind":"testId","value":"credit-remaining"},"expected":{"kind":"regex","pattern":"Credit [\\d,]+"},"liveNote":"mock numeric fixture; live uses digit wildcard matching"}

### to be: 'Cancel subscription' link is disabled (cursor-not-allowed)

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `visible`: {"type":"visible","locator":{"kind":"testId","value":"subscription-disabled-link"}}
  - `notVisible`: {"type":"notVisible","locator":{"kind":"testId","value":"subscription-cancel-link"}}
  - `notVisible`: {"type":"notVisible","locator":{"kind":"testId","value":"subscription-resume-link"}}

### to be: 'Subscription info' section is visible

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `visible`: {"type":"visible","locator":{"kind":"text","value":"Subscription info"}}

### to be: no clickable cancel/resume links; only disabled link is shown

- Staging mode: `read-only`
- Live run policy: `judgment-mock-api`
- QA annotation: `@qa-live-policy: mock-judgment`
- Live run: Playwright skips (page.route mocks); Hermes judges whether live DOM satisfies test intent without mocking
- Reference expectations (Hermes adapts on live):
  - `visible`: {"type":"visible","locator":{"kind":"testId","value":"subscription-disabled-link"}}
  - `notVisible`: {"type":"notVisible","locator":{"kind":"testId","value":"subscription-cancel-link"}}
  - `notVisible`: {"type":"notVisible","locator":{"kind":"testId","value":"subscription-resume-link"}}

### to be: subscription history dialog opens

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)

### to be: dialog closes via Confirm button

- Staging mode: `interaction`
- Live run policy: `judgment-interaction-no-confirm`
- QA annotation: `@qa-live-policy: safe-interaction-no-confirm`
- Live run: UI action where completing verification would be dangerous on live — Hermes replays safe open steps, verifies up to the dangerous point, dismisses with Esc only (never clicks confirm)

### to be: dialog closes via Escape key

- Staging mode: `interaction`
- Live run policy: `executable-interaction`
- QA annotation: `@qa-live-policy: safe-interaction`
- Live run: Safe UI action requiring live test replay and assertion verification (no subscription/billing mutation; dismiss destructive confirms with Esc only)
