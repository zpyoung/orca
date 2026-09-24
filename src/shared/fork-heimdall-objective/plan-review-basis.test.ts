import { describe, expect, it } from 'vitest'
import {
  countPlanReviewBasis,
  requiredPlanReviewSpotCheckCount,
  validatePlanReviewBasis
} from './plan-review-basis'
import type { ObjectivePlanAssumption } from './plan-schema'
import type { PlanReviewAssumptionAssessment } from './plan-review-schema'

function evidencedAssumption(claim: string): ObjectivePlanAssumption {
  return {
    claim,
    dependentTaskKeys: [],
    evidence: { command: 'pnpm test', observed: 'passed' }
  }
}

function plainAssumption(claim: string): ObjectivePlanAssumption {
  return { claim, dependentTaskKeys: [] }
}

function assessment(
  index: number,
  overrides: Partial<PlanReviewAssumptionAssessment> = {}
): PlanReviewAssumptionAssessment {
  return { index, status: 'verified', evidence: 'checked', ...overrides }
}

function evidencedAssumptions(count: number): ObjectivePlanAssumption[] {
  return Array.from({ length: count }, (_, index) => evidencedAssumption(`claim-${index}`))
}

function assessmentsWithReverifiedCount(
  total: number,
  reverifiedCount: number
): PlanReviewAssumptionAssessment[] {
  return Array.from({ length: total }, (_, index) =>
    assessment(index, { basis: index < reverifiedCount ? 'reverified' : 'planner-evidence' })
  )
}

describe('requiredPlanReviewSpotCheckCount', () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [8, 2],
    [9, 3]
  ])('requires %i of %i evidenced assumptions', (evidencedCount, expected) => {
    expect(requiredPlanReviewSpotCheckCount(evidencedCount)).toBe(expected)
  })
})

describe('validatePlanReviewBasis spot-check threshold', () => {
  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [8, 2],
    [9, 3]
  ])(
    'accepts exactly the required count and rejects one fewer, for |E| = %i',
    (evidencedCount, required) => {
      const assumptions = evidencedAssumptions(evidencedCount)
      expect(
        validatePlanReviewBasis(
          assumptions,
          assessmentsWithReverifiedCount(evidencedCount, required)
        )
      ).toBeNull()
      if (required > 0) {
        const shortfall = validatePlanReviewBasis(
          assumptions,
          assessmentsWithReverifiedCount(evidencedCount, required - 1)
        )
        expect(shortfall).toMatch(/Spot-check/)
      }
    }
  )
})

describe('validatePlanReviewBasis basis consistency', () => {
  it('rejects a planner-evidence basis when the assumption has no recorded evidence', () => {
    const assumptions = [plainAssumption('no evidence was recorded')]
    const assessments = [assessment(0, { basis: 'planner-evidence' })]
    expect(validatePlanReviewBasis(assumptions, assessments)).toMatch(/no planner evidence/)
  })

  it('accepts a reverified basis on an assumption with no recorded evidence', () => {
    const assumptions = [plainAssumption('no evidence was recorded')]
    const assessments = [assessment(0, { basis: 'reverified' })]
    expect(validatePlanReviewBasis(assumptions, assessments)).toBeNull()
  })

  it('accepts an absent basis, treating it as reverified', () => {
    const assumptions = [plainAssumption('no evidence was recorded')]
    const assessments = [assessment(0)]
    expect(validatePlanReviewBasis(assumptions, assessments)).toBeNull()
  })

  it('rejects a carried basis outside the (default empty) carry-eligible set', () => {
    const assumptions = [evidencedAssumption('carried over')]
    const assessments = [assessment(0, { basis: 'carried' })]
    expect(validatePlanReviewBasis(assumptions, assessments)).toMatch(/basis:'carried'/)
  })

  it('accepts a carried basis on an eligible index once the spot-check floor is met by others', () => {
    const assumptions = evidencedAssumptions(8)
    const assessments = [
      assessment(0, { basis: 'carried' }),
      assessment(1, { basis: 'reverified' }),
      assessment(2, { basis: 'reverified' }),
      ...Array.from({ length: 5 }, (_, offset) =>
        assessment(offset + 3, { basis: 'planner-evidence' })
      )
    ]
    expect(validatePlanReviewBasis(assumptions, assessments, new Set([0]))).toBeNull()
  })

  it('rejects a carried basis with no recorded evidence even when the index is carry-eligible', () => {
    const assumptions = [plainAssumption('carried but never had evidence')]
    const assessments = [assessment(0, { basis: 'carried' })]
    expect(validatePlanReviewBasis(assumptions, assessments, new Set([0]))).toMatch(
      /no planner evidence/
    )
  })
})

describe('countPlanReviewBasis', () => {
  it('tallies each basis, treating an absent basis as reverified', () => {
    const assessments = [
      assessment(0),
      assessment(1, { basis: 'planner-evidence' }),
      assessment(2, { basis: 'carried' }),
      assessment(3, { basis: 'reverified' })
    ]
    expect(countPlanReviewBasis(assessments)).toEqual({
      reverified: 2,
      plannerEvidence: 1,
      carried: 1
    })
  })
})
