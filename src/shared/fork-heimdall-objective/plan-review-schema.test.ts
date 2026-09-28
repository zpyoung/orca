import { describe, expect, it } from 'vitest'
import {
  PlanReviewAssumptionAssessmentSchema,
  PlanReviewReportSchema,
  parseAndValidatePlanReviewReport
} from './plan-review-schema'
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

describe('PlanReviewReportSchema', () => {
  it('rejects an approve verdict alongside a blocking finding', () => {
    const result = PlanReviewReportSchema.safeParse({
      verdict: 'approve',
      assumptions: [],
      findings: [{ taskKey: null, severity: 'blocking', body: 'block' }],
      summary: 'x'
    })
    expect(result.success).toBe(false)
  })
})

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

  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [8, 2],
    [9, 3]
  ])(
    'enforces the spot-check floor of %i reverified for |E| = %i evidenced assumptions',
    (evidencedCount, required) => {
      const assumptions: ObjectivePlanAssumption[] = Array.from(
        { length: evidencedCount },
        (_, index) => ({
          claim: `claim-${index}`,
          dependentTaskKeys: [],
          evidence: { command: `check-${index}`, observed: 'confirmed' }
        })
      )
      const assessmentsWith = (reverifiedCount: number) =>
        report({
          assumptions: Array.from({ length: evidencedCount }, (_, index) => ({
            index,
            status: 'verified',
            evidence: 'spot-checked',
            basis: index < reverifiedCount ? 'reverified' : 'planner-evidence'
          }))
        })
      expect(
        parseAndValidatePlanReviewReport(assessmentsWith(required), evidencedCount, assumptions)
      ).toMatchObject({ verdict: 'approve' })
      if (required > 0) {
        expect(() =>
          parseAndValidatePlanReviewReport(
            assessmentsWith(required - 1),
            evidencedCount,
            assumptions
          )
        ).toThrow(/Spot-check/)
      }
    }
  )

  it('rejects basis:planner-evidence on an assumption the planner recorded no evidence for', () => {
    const assumptions: ObjectivePlanAssumption[] = [
      { claim: 'no evidence recorded', dependentTaskKeys: [] }
    ]
    const withUnsupportedBasis = report({
      assumptions: [
        { index: 0, status: 'verified', evidence: 'trusted', basis: 'planner-evidence' }
      ]
    })
    expect(() => parseAndValidatePlanReviewReport(withUnsupportedBasis, 1, assumptions)).toThrow(
      /no planner evidence/
    )
  })

  it("rejects basis:'carried' in this task, since carryEligible defaults to empty", () => {
    const assumptions: ObjectivePlanAssumption[] = [
      { claim: 'evidenced claim', dependentTaskKeys: [], evidence: { command: 'x', observed: 'y' } }
    ]
    const withCarried = report({
      assumptions: [{ index: 0, status: 'verified', evidence: 'carried forward', basis: 'carried' }]
    })
    expect(() => parseAndValidatePlanReviewReport(withCarried, 1, assumptions)).toThrow(
      /basis:'carried'/
    )
  })
})

describe('PlanReviewAssumptionAssessmentSchema basis', () => {
  it('is optional and absent by default', () => {
    const parsed = PlanReviewAssumptionAssessmentSchema.parse({
      index: 0,
      status: 'verified',
      evidence: 'ok'
    })
    expect(parsed.basis).toBeUndefined()
  })

  it('accepts each declared basis value', () => {
    for (const basis of ['reverified', 'planner-evidence', 'carried'] as const) {
      expect(
        PlanReviewAssumptionAssessmentSchema.safeParse({
          index: 0,
          status: 'verified',
          evidence: 'ok',
          basis
        }).success
      ).toBe(true)
    }
  })

  it('rejects an unknown basis value', () => {
    expect(
      PlanReviewAssumptionAssessmentSchema.safeParse({
        index: 0,
        status: 'verified',
        evidence: 'ok',
        basis: 'guessed'
      }).success
    ).toBe(false)
  })
})
