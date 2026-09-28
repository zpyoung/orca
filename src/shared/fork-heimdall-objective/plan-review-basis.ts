import type { ObjectivePlanAssumption } from './plan-schema'
import type {
  PlanReviewAssumptionAssessment,
  PlanReviewAssumptionBasis
} from './plan-review-schema'

function assessedBasis(assessment: PlanReviewAssumptionAssessment): PlanReviewAssumptionBasis {
  return assessment.basis ?? 'reverified'
}

/** The spot-check floor: at least 2 of the evidenced assumptions, or a quarter of them, whichever is more. */
export function requiredPlanReviewSpotCheckCount(evidencedCount: number): number {
  return Math.min(evidencedCount, Math.max(2, Math.ceil(evidencedCount / 4)))
}

function describeIndices(indices: readonly number[]): string {
  return [...indices].sort((a, b) => a - b).join(', ')
}

/**
 * Enforces the spot-check rule at plan-review ingestion: a minimum re-verified sample of the
 * planner's evidenced assumptions, and a `basis` label consistent with whether the planner recorded
 * evidence and, for `carried`, with the delta review's eligible-index set — empty until delta review
 * lands, so every `carried` label is rejected here for now. Returns `null` when the report is
 * consistent, or a sentence naming the offending indices.
 */
export function validatePlanReviewBasis(
  assumptions: readonly ObjectivePlanAssumption[],
  assessments: readonly PlanReviewAssumptionAssessment[],
  carryEligible: ReadonlySet<number> = new Set()
): string | null {
  const evidencedIndices = assumptions.flatMap((assumption, index) =>
    assumption.evidence === undefined ? [] : [index]
  )
  const evidencedSet = new Set(evidencedIndices)
  const byIndex = new Map(assessments.map((assessment) => [assessment.index, assessment]))

  const reverifiedEvidencedCount = evidencedIndices.filter((index) => {
    const assessment = byIndex.get(index)
    return assessment !== undefined && assessedBasis(assessment) === 'reverified'
  }).length

  const unsupportedBasis: number[] = []
  const ineligibleCarried: number[] = []
  for (const [index, assessment] of byIndex) {
    const basis = assessedBasis(assessment)
    if (basis === 'reverified') {
      continue
    }
    if (basis === 'carried') {
      if (!carryEligible.has(index)) {
        ineligibleCarried.push(index)
      }
      continue
    }
    if (!evidencedSet.has(index)) {
      unsupportedBasis.push(index)
    }
  }

  const required = requiredPlanReviewSpotCheckCount(evidencedIndices.length)
  const problems: string[] = []
  if (reverifiedEvidencedCount < required) {
    problems.push(
      `Spot-check more of the planner's evidence: re-verify (basis:'reverified') at least ${required} of the ${evidencedIndices.length} evidenced assumptions; only ${reverifiedEvidencedCount} were.`
    )
  }
  if (unsupportedBasis.length > 0) {
    problems.push(
      `Assumptions at index ${describeIndices(unsupportedBasis)} have no planner evidence, so basis must be omitted or 'reverified'.`
    )
  }
  if (ineligibleCarried.length > 0) {
    problems.push(
      `Assumptions at index ${describeIndices(ineligibleCarried)} cannot use basis:'carried' in this review.`
    )
  }
  return problems.length > 0 ? problems.join(' ') : null
}
