import { z } from 'zod'
import { OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH } from '../../fork-heimdall-objective/contract-types'

const IdSchema = z.string().trim().min(1).max(1_024)
const DetailBase = { detail: z.string().trim().min(1).max(4_096).optional() } as const

export const ReportRejectedDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('report-rejected'),
    dispatchId: IdSchema,
    taskKey: IdSchema,
    rejectionReason: z.string().trim().min(1).max(8_192),
    reportedFiles: z.array(IdSchema).max(256),
    observedFiles: z.array(IdSchema).max(256)
  })
  .strict()
export type ReportRejectedDeviation = z.infer<typeof ReportRejectedDeviationSchema>

export const NodeFailedDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('node-failed'),
    dispatchId: IdSchema,
    taskKey: IdSchema,
    failureClass: IdSchema.nullable(),
    summary: z.string().trim().min(1).max(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH).nullable(),
    conflictPaths: z.array(IdSchema).max(256).optional(),
    conflictingDispatchIds: z.array(IdSchema).max(128).optional()
  })
  .strict()
export type NodeFailedDeviation = z.infer<typeof NodeFailedDeviationSchema>

export const RetryExhaustedDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('retry-exhausted'),
    taskKey: IdSchema,
    retryCount: z.number().int().nonnegative(),
    lastFailureClass: IdSchema.nullable(),
    conflictPaths: z.array(IdSchema).max(256).optional(),
    conflictingDispatchIds: z.array(IdSchema).max(128).optional()
  })
  .strict()
export type RetryExhaustedDeviation = z.infer<typeof RetryExhaustedDeviationSchema>

export const WorkerQuestionDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('worker-question'),
    messageId: IdSchema,
    dispatchId: IdSchema.nullable(),
    question: z.string().trim().min(1).max(8_192)
  })
  .strict()
export type WorkerQuestionDeviation = z.infer<typeof WorkerQuestionDeviationSchema>

export const WorkerEscalationDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('worker-escalation'),
    escalationId: IdSchema,
    messageId: IdSchema,
    dispatchId: IdSchema.nullable(),
    reason: z.string().trim().min(1).max(8_192)
  })
  .strict()
export type WorkerEscalationDeviation = z.infer<typeof WorkerEscalationDeviationSchema>

export const WorkerUnverifiableDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('worker-unverifiable'),
    dispatchId: IdSchema.nullable(),
    reason: z.string().trim().min(1).max(8_192)
  })
  .strict()
export type WorkerUnverifiableDeviation = z.infer<typeof WorkerUnverifiableDeviationSchema>

export const WorkerExitedDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('worker-exited'),
    dispatchId: IdSchema.nullable(),
    exitTail: z.string().trim().min(1).max(8_192).nullable()
  })
  .strict()
export type WorkerExitedDeviation = z.infer<typeof WorkerExitedDeviationSchema>

export const CheckFailedDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('check-failed'),
    criterionId: IdSchema,
    command: z.string().trim().min(1).max(8_192).nullable(),
    exitCode: z.number().int().nullable(),
    // null means the kind's check model has no timeout concept to report, not "did not time out" —
    // a kind that only knows pass/fail (e.g. an external CI status check) must not fabricate false
    timedOut: z.boolean().nullable()
  })
  .strict()
export type CheckFailedDeviation = z.infer<typeof CheckFailedDeviationSchema>

export const ReviewBlockedDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('review-blocked'),
    role: z.enum(['reviewer', 'integrator']),
    dispatchId: IdSchema,
    summary: z.string().trim().min(1).max(OBJECTIVE_REPORT_SUMMARY_MAX_LENGTH).nullable()
  })
  .strict()
export type ReviewBlockedDeviation = z.infer<typeof ReviewBlockedDeviationSchema>

export const LandingFailedDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('landing-failed'),
    rung: IdSchema,
    /** Distinguishes two failures on the same rung at different heads; a kind that omits it accepts the coalesce. */
    contentIdentity: IdSchema.optional(),
    reason: z.string().trim().min(1).max(8_192).nullable()
  })
  .strict()
export type LandingFailedDeviation = z.infer<typeof LandingFailedDeviationSchema>

/**
 * No usable plan exists to activate, or the plan that existed failed to activate — a real decision
 * point (amend the draft, re-dispatch the planner with guidance, ask a human) that must not just
 * auto-replan once an owner is configured. `revisionId`/`revisionNumber` are optional because the
 * "no usable plan" case has no revision to name at all.
 */
export const PlanFailedDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('plan-failed'),
    reason: z.enum(['no-usable-plan', 'activation-not-landed']),
    revisionId: IdSchema.optional(),
    revisionNumber: z.number().int().positive().optional()
  })
  .strict()
export type PlanFailedDeviation = z.infer<typeof PlanFailedDeviationSchema>

export const GateHeldDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('gate-held'),
    actionKind: IdSchema,
    holdReason: z.string().trim().min(1).max(8_192)
  })
  .strict()
export type GateHeldDeviation = z.infer<typeof GateHeldDeviationSchema>

export const StallDeviationSchema = z
  .object({
    ...DetailBase,
    kind: z.literal('stall'),
    what: z.string().trim().min(1).max(1_024),
    dispatchId: IdSchema,
    taskKey: IdSchema.optional(),
    inFlightSinceMs: z.number().int().nonnegative(),
    thresholdMs: z.number().int().nonnegative()
  })
  .strict()
export type StallDeviation = z.infer<typeof StallDeviationSchema>

export const DeviationSchema = z.discriminatedUnion('kind', [
  ReportRejectedDeviationSchema,
  NodeFailedDeviationSchema,
  RetryExhaustedDeviationSchema,
  WorkerQuestionDeviationSchema,
  WorkerEscalationDeviationSchema,
  WorkerUnverifiableDeviationSchema,
  WorkerExitedDeviationSchema,
  CheckFailedDeviationSchema,
  ReviewBlockedDeviationSchema,
  LandingFailedDeviationSchema,
  PlanFailedDeviationSchema,
  GateHeldDeviationSchema,
  StallDeviationSchema
])
/** A non-happy-path kernel event the owning agent is woken to reason about. */
export type Deviation = z.infer<typeof DeviationSchema>

/**
 * Stable dedupe key so the same deviation observed on consecutive ticks is one owner wake, not
 * many. Follows the `kind:detail` encoding `parkEscalationId` uses for the same reason.
 */
export function deviationNaturalKey(deviation: Deviation): string {
  switch (deviation.kind) {
    case 'report-rejected':
      return `report-rejected:${encodeURIComponent(deviation.dispatchId)}`
    case 'node-failed':
      return `node-failed:${encodeURIComponent(deviation.dispatchId)}`
    case 'retry-exhausted':
      return `retry-exhausted:${encodeURIComponent(deviation.taskKey)}`
    case 'worker-question':
      return `worker-question:${encodeURIComponent(deviation.messageId)}`
    case 'worker-escalation':
      return `worker-escalation:${encodeURIComponent(deviation.escalationId)}`
    case 'worker-unverifiable':
      return `worker-unverifiable:${encodeURIComponent(deviation.dispatchId ?? 'none')}`
    case 'worker-exited':
      return `worker-exited:${encodeURIComponent(deviation.dispatchId ?? 'none')}`
    case 'check-failed':
      return `check-failed:${encodeURIComponent(deviation.criterionId)}`
    case 'review-blocked':
      return `review-blocked:${encodeURIComponent(deviation.dispatchId)}`
    case 'landing-failed':
      return `landing-failed:${encodeURIComponent(deviation.rung)}:${encodeURIComponent(deviation.contentIdentity ?? 'none')}`
    case 'plan-failed':
      return `plan-failed:${encodeURIComponent(deviation.revisionId ?? 'none')}`
    case 'gate-held':
      return `gate-held:${encodeURIComponent(deviation.actionKind)}`
    case 'stall':
      return `stall:${encodeURIComponent(deviation.dispatchId)}`
  }
}

export function ownerDeviationEscalationId(watcherId: string, deviation: Deviation): string {
  return `owner-deviation:${watcherId}:${deviationNaturalKey(deviation)}`
}
