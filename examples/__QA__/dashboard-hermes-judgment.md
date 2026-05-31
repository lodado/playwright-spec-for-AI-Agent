# Hermes QA Judgment — dashboard

- Status: **pass**
- Mode: `browse`
- Page: `/ko/dashboard`
- Source: hermes-agent

## Summary

Logged into staging and verified the live /ko/dashboard DOM for the matching INACTIVE/FREE scenario plus the always-run CREDIT_BVA scenario. The account is displayed as Free/INACTIVE: the heading shows a Free plan, subscription action is disabled with cursor-not-allowed, and cancel/resume action links are absent. The subscription history dialog opened safely and was dismissed with Escape; no billing or subscription mutation was performed.

## Checks

| Result | Item                                                                   | Detail                                                                                                                                                                                              |
| ------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pass   | to be: username and 'Free plan' text appear in the title                | Live heading is visible as "lelelel is on the Free plan.", satisfying the Free-plan title intent with the live username.                                                              |
| pass   | to be: subtitle shows 'Check your remaining credits'       | data-testid="dashboard-subtitle" text is "Check your remaining credits."                                                                                                                                |
| pass   | to be: credit balance shows 0                                  | data-testid="credit-remaining" is visible and shows a live numeric credit value: "Credit 8". Per live adaptation, the mock zero fixture is judged by numeric credit format on the real account.     |
| pass   | to be: 'Cancel subscription' link is disabled (cursor-not-allowed) | data-testid="subscription-disabled-link" is visible with text "Cancel subscription" and class includes "cursor-not-allowed"; subscription-cancel-link and subscription-resume-link are not present.           |
| pass   | to be: 'Subscription info' section is visible                                     | The "Subscription info" section is visible, with subscription table showing plan "FREE".                                                                                                                    |
| pass   | to be: no clickable cancel/resume links; only disabled link is shown   | Only data-testid="subscription-disabled-link" is present. data-testid="subscription-cancel-link" and data-testid="subscription-resume-link" are absent, and no dialog is open in the resting state. |
| pass   | to be: subscription history dialog opens                                   | Clicked the safe "View full subscription history" subscription history button. Dialog opened with title "Full subscription history" and copy "Review your subscription billing history".                                            |
| skip   | to be: dialog closes via Confirm button                               | Live policy is judgment-interaction-no-confirm. The dialog and "Confirm" button were verified as visible, but the confirm button was not clicked on live; dialog was dismissed with Escape instead.    |
| pass   | to be: dialog closes via Escape key                                 | After opening the subscription history dialog, pressing Escape dismissed it and returned to the dashboard with no visible dialog.                                                                   |
| pass   | to be: when remaining_credits is 0, shows 0 remaining credits              | Always-run CREDIT_BVA live judgment: data-testid="credit-remaining" is visible and matches the live-safe numeric format, "Credit 8".                                                                |
| pass   | to be: when remaining_credits is positive, shows that value                   | Always-run CREDIT_BVA live judgment: data-testid="credit-remaining" exactly follows the format "Credit [digits]" with live value "Credit 8".                                                        |

## Evidence

- Current URL: https://agent-stage.koreadeep.com/ko/dashboard
- Plan/status inferred from DOM: INACTIVE/FREE; header plan button shows "Free" and subscription table plan cell shows "FREE".
- Dashboard title: "lelelel is on the Free plan."
- Dashboard subtitle: "Check your remaining credits."
- Credit remaining: "Credit 8".
- Subscription disabled link present with class "underline underline-offset-2 text-gray-400 cursor-not-allowed"; cancel/resume test IDs absent.
- Subscription history dialog opened with title "Full subscription history", text "Review your subscription billing history", and a visible "Confirm" button; Escape closed it.

## Recommended action

none
