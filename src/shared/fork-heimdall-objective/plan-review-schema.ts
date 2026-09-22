import { z } from 'zod'
import { OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH } from './contract-types'
import {
  OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES,
  OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH,
  TaskKeySchema,
  type ObjectivePlanAssumption
} from './plan-schema'

const PLAN_REVIEW_FINDINGS_MAX_ENTRIES = 128

export const PlanReviewAssumptionAssessmentSchema = z
  .object({
    index: z.number().int().nonnegative(),
    status: z.enum(['verified', 'unverified']),
    evidence: z.string().trim().min(1).max(OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH)
  })
  .strict()
export type PlanReviewAssumptionAssessment = z.infer<typeof PlanReviewAssumptionAssessmentSchema>

export const PlanReviewFindingSchema = z
  .object({
    taskKey: TaskKeySchema.nullable(),
    severity: z.enum(['blocking', 'advisory']),
    body: z.string().trim().min(1).max(OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH)
  })
  .strict()
export type PlanReviewFinding = z.infer<typeof PlanReviewFindingSchema>

export const PlanReviewReportSchema = z
  .object({
    verdict: z.enum(['approve', 'revise', 'escalate']),
    assumptions: z
      .array(PlanReviewAssumptionAssessmentSchema)
      .max(OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES),
    findings: z.array(PlanReviewFindingSchema).max(PLAN_REVIEW_FINDINGS_MAX_ENTRIES),
    summary: z.string().trim().min(1).max(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH)
  })
  .strict()
export type PlanReviewReport = z.infer<typeof PlanReviewReportSchema>

function assessesEveryAssumptionOnce(
  assessments: readonly PlanReviewAssumptionAssessment[],
  assumptionCount: number
): boolean {
  const indices = assessments.map((assessment) => assessment.index).sort((a, b) => a - b)
  return (
    indices.length === assumptionCount && indices.every((value, position) => value === position)
  )
}

/**
 * Parses a reviewer's plan verdict and enforces the invariants a schema alone cannot express: full,
 * once-each assumption coverage, and an `approve` verdict that is never contradicted by a blocking
 * finding or (when the assumption list is supplied) an unverified assumption other tasks depend on.
 */
export function parseAndValidatePlanReviewReport(
  raw: unknown,
  assumptionCount: number,
  assumptions?: readonly ObjectivePlanAssumption[]
): PlanReviewReport {
  const report = PlanReviewReportSchema.parse(raw)
  if (!assessesEveryAssumptionOnce(report.assumptions, assumptionCount)) {
    throw new Error('Plan review must assess every assumption exactly once')
  }
  if (report.verdict !== 'approve') {
    return report
  }
  if (report.findings.some((finding) => finding.severity === 'blocking')) {
    throw new Error('Plan review approves despite a blocking finding')
  }
  if (assumptions !== undefined) {
    const approvesUnverifiedLoadBearingAssumption = report.assumptions.some((assessment) => {
      if (assessment.status !== 'unverified') {
        return false
      }
      const assumption = assumptions[assessment.index]
      return assumption !== undefined && assumption.dependentTaskKeys.length > 0
    })
    if (approvesUnverifiedLoadBearingAssumption) {
      throw new Error('Plan review approves an unverified load-bearing assumption')
    }
  }
  return report
}
