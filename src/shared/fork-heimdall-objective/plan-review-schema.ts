import { z } from 'zod'
import { OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH } from './contract-types'
import {
  OBJECTIVE_PLAN_ASSUMPTIONS_MAX_ENTRIES,
  OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH,
  TaskKeySchema,
  type ObjectivePlanAssumption
} from './plan-schema'
import { validatePlanReviewBasis } from './plan-review-basis'

const PLAN_REVIEW_FINDINGS_MAX_ENTRIES = 128

/** Absent means `'reverified'` — the pre-spot-check behavior, kept for older reports. */
export const PLAN_REVIEW_ASSUMPTION_BASIS_VALUES = [
  'reverified',
  'planner-evidence',
  'carried'
] as const
export type PlanReviewAssumptionBasis = (typeof PLAN_REVIEW_ASSUMPTION_BASIS_VALUES)[number]

export const PlanReviewAssumptionAssessmentSchema = z
  .object({
    index: z.number().int().nonnegative(),
    status: z.enum(['verified', 'unverified']),
    evidence: z.string().trim().min(1).max(OBJECTIVE_PLAN_REVIEW_TEXT_MAX_LENGTH),
    basis: z.enum(PLAN_REVIEW_ASSUMPTION_BASIS_VALUES).optional()
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
  .superRefine((report, ctx) => {
    if (
      report.verdict === 'approve' &&
      report.findings.some((finding) => finding.severity === 'blocking')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Plan review approves despite a blocking finding',
        path: ['verdict']
      })
    }
  })
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
 * Parses a reviewer's plan verdict and enforces the invariants the schema cannot express on its
 * own: full, once-each assumption coverage; the spot-check rule on planner-handed evidence (when
 * the assumption list is supplied); and an `approve` verdict that never leaves an unverified
 * assumption other tasks depend on. `carryEligible` is empty until delta review can populate it.
 */
export function parseAndValidatePlanReviewReport(
  raw: unknown,
  assumptionCount: number,
  assumptions?: readonly ObjectivePlanAssumption[],
  carryEligible: ReadonlySet<number> = new Set()
): PlanReviewReport {
  const report = PlanReviewReportSchema.parse(raw)
  if (!assessesEveryAssumptionOnce(report.assumptions, assumptionCount)) {
    throw new Error('Plan review must assess every assumption exactly once')
  }
  if (assumptions !== undefined) {
    const basisProblem = validatePlanReviewBasis(assumptions, report.assumptions, carryEligible)
    if (basisProblem !== null) {
      throw new Error(basisProblem)
    }
  }
  if (report.verdict === 'approve' && assumptions !== undefined) {
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
