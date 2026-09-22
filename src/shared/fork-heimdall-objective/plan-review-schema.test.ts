import { describe, expect, it } from 'vitest'
import { parseAndValidatePlanReviewReport } from './plan-review-schema'
import type { ObjectivePlanAssumption } from './plan-schema'

function report(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    verdict: 'approve',
    assumptions: [{ index: 0, status: 'verified', evidence: 'Checked the config.' }],
    findings: [],
    summary: 'Looks good.',
    ...overrides
  }
}

describe('parseAndValidatePlanReviewReport', () => {
  it('rejects a malformed report with the schema failure', () => {
    expect(() => parseAndValidatePlanReviewReport({}, 1)).toThrow()
  })

  it('accepts a review that assesses every assumption exactly once', () => {
    expect(parseAndValidatePlanReviewReport(report(), 1)).toMatchObject({ verdict: 'approve' })
  })

  it('rejects a review missing an assumption index', () => {
    expect(() => parseAndValidatePlanReviewReport(report({ assumptions: [] }), 1)).toThrow(
      'Plan review must assess every assumption exactly once'
    )
  })

  it('rejects a review that assesses the same assumption index twice', () => {
    const duplicated = report({
      assumptions: [
        { index: 0, status: 'verified', evidence: 'First pass.' },
        { index: 0, status: 'verified', evidence: 'Second pass.' }
      ]
    })
    expect(() => parseAndValidatePlanReviewReport(duplicated, 1)).toThrow(
      'Plan review must assess every assumption exactly once'
    )
  })

  it('rejects an approval alongside a blocking finding', () => {
    const blocked = report({
      findings: [{ taskKey: null, severity: 'blocking', body: 'Missing rollback plan.' }]
    })
    expect(() => parseAndValidatePlanReviewReport(blocked, 1)).toThrow(
      'Plan review approves despite a blocking finding'
    )
  })

  it('allows a non-approve verdict to carry a blocking finding', () => {
    const revise = report({
      verdict: 'revise',
      findings: [{ taskKey: null, severity: 'blocking', body: 'Missing rollback plan.' }]
    })
    expect(parseAndValidatePlanReviewReport(revise, 1)).toMatchObject({ verdict: 'revise' })
  })

  it('rejects an approval over an unverified load-bearing assumption when the assumption list is given', () => {
    const assumptions: ObjectivePlanAssumption[] = [
      { claim: 'the schema is unchanged', dependentTaskKeys: ['migrate'] }
    ]
    const unverified = report({
      assumptions: [{ index: 0, status: 'unverified', evidence: 'Not checked yet.' }]
    })
    expect(() => parseAndValidatePlanReviewReport(unverified, 1, assumptions)).toThrow(
      'Plan review approves an unverified load-bearing assumption'
    )
  })

  it('allows an approval over an unverified assumption with no dependents', () => {
    const assumptions: ObjectivePlanAssumption[] = [
      { claim: 'informational only', dependentTaskKeys: [] }
    ]
    const unverified = report({
      assumptions: [{ index: 0, status: 'unverified', evidence: 'Not checked yet.' }]
    })
    expect(parseAndValidatePlanReviewReport(unverified, 1, assumptions)).toMatchObject({
      verdict: 'approve'
    })
  })
})
