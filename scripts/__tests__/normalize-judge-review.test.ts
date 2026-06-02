import { describe, expect, it } from 'vitest'

import { formatJudgmentForReview, normalizeJudgeReview, reviewWarrantsExitCode } from '../normalize-judge-review.mjs'
import { buildJudgeReviewHermesQuery } from '../run-hermes-judge-review.mjs'

const judgment = {
  status: 'fail',
  summary: 'One check failed on label text.',
  checks: [
    {
      item: 'shows invoice template',
      result: 'fail',
      detail: 'Template title was "Invoice" not "세금계산서".',
    },
  ],
  evidence: ['Plan: Basic'],
  source: 'hermes-agent',
}

describe('formatJudgmentForReview', () => {
  it('formats judgment as markdown without JSON blob', () => {
    const text = formatJudgmentForReview(judgment)
    expect(text).toContain('shows invoice template')
    expect(text).toContain('**Result:** fail')
    expect(text).not.toContain('"checks"')
  })
})

describe('normalizeJudgeReview', () => {
  it('normalizes two criteria with defaults for missing entries', () => {
    const review = normalizeJudgeReview(
      {
        overallReview: 'flagged',
        summary: 'Pedantic fail detected.',
        criteria: [
          {
            id: 'not-overly-pedantic',
            verdict: 'fail',
            detail: 'Exact label required.',
            affectedChecks: ['shows invoice template'],
          },
        ],
      },
      judgment,
    )

    expect(review.criteria).toHaveLength(2)
    expect(review.criteria[0].id).toBe('sufficient-evidence')
    expect(review.criteria[1].verdict).toBe('fail')
    expect(review.overallReview).toBe('flagged')
  })
})

describe('reviewWarrantsExitCode', () => {
  it('returns true when flagged or concern', () => {
    expect(
      reviewWarrantsExitCode({
        overallReview: 'flagged',
        criteria: [{ verdict: 'pass' }],
      }),
    ).toBe(true)
    expect(
      reviewWarrantsExitCode({
        overallReview: 'approved',
        criteria: [{ verdict: 'concern' }],
      }),
    ).toBe(true)
    expect(
      reviewWarrantsExitCode({
        overallReview: 'approved',
        criteria: [{ verdict: 'pass' }, { verdict: 'pass' }],
      }),
    ).toBe(false)
  })
})

describe('buildJudgeReviewHermesQuery', () => {
  it('includes both criteria and GWT plan without JSON payload', () => {
    const query = buildJudgeReviewHermesQuery({
      page: 'dashboard',
      targetPath: '/dashboard',
      testPlanDocument: '**Given:** logged in',
      judgmentDocument: formatJudgmentForReview(judgment),
    })

    expect(query).toContain('sufficient-evidence')
    expect(query).toContain('not-overly-pedantic')
    expect(query).toContain('세금계산서')
    expect(query).toContain('**Given:** logged in')
    expect(query).not.toContain('"specDefinition"')
  })
})
