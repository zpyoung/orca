import { describe, expect, it } from 'vitest'
import {
  HOSTED_REVIEW_SITTER_RATIONALE_MAX_LENGTH,
  HostedReviewSitterInterventionSchema
} from './owner-intervention'

describe('hosted review sitter intervention rationale bounds', () => {
  it.each([
    ['retry-rung', { kind: 'retry-rung', rung: 'update-branch' }],
    ['skip-capability', { kind: 'skip-capability', capability: 'fixChecks' }]
  ] as const)('accepts %s rationale at the code-unit cap and rejects +1', (_kind, base) => {
    const atLimit = '界'.repeat(HOSTED_REVIEW_SITTER_RATIONALE_MAX_LENGTH)

    expect(atLimit.length).toBe(HOSTED_REVIEW_SITTER_RATIONALE_MAX_LENGTH)
    expect(Buffer.byteLength(atLimit, 'utf8')).toBeGreaterThan(
      HOSTED_REVIEW_SITTER_RATIONALE_MAX_LENGTH
    )
    expect(
      HostedReviewSitterInterventionSchema.safeParse({ ...base, rationale: atLimit }).success
    ).toBe(true)
    expect(
      HostedReviewSitterInterventionSchema.safeParse({
        ...base,
        rationale: `${atLimit}界`
      }).success
    ).toBe(false)
  })
})
