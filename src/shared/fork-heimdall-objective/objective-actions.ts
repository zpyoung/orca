import { z } from 'zod'
import {
  ObjectiveLandingBarSchema,
  ObjectiveWorkspacePathSchema,
  OBJECTIVE_PATH_MAX_LENGTH
} from './contract-types'
import { ObjectiveReviewRoleSchema, ObjectiveVerdictSchema } from './detail-types'

const IdSchema = z.string().trim().min(1).max(1_024)
const ActionBase = {
  capability: IdSchema,
  visibility: z.literal('local'),
  contentIdentity: IdSchema,
  evidenceKey: IdSchema
} as const
const ReplaySafeSchema = z.literal('replay-safe')

export const DispatchPlannerActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('dispatch-planner'),
    capability: z.literal('plan'),
    revisionNumber: z.number().int().positive(),
    reason: z.enum(['initial', 'replan-after-block', 'replan-after-failure'])
  })
  .strict()
export type DispatchPlannerAction = z.infer<typeof DispatchPlannerActionSchema>

export const IngestPlanActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('ingest-plan'),
    capability: z.literal('plan'),
    recovery: ReplaySafeSchema,
    dispatchId: IdSchema,
    revisionNumber: z.number().int().positive(),
    reportPath: z.string().trim().min(1).max(OBJECTIVE_PATH_MAX_LENGTH)
  })
  .strict()
export type IngestPlanAction = z.infer<typeof IngestPlanActionSchema>

export const ActivatePlanActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('activate-plan'),
    capability: z.literal('plan'),
    recovery: ReplaySafeSchema,
    revisionId: IdSchema,
    digest: IdSchema
  })
  .strict()
export type ActivatePlanAction = z.infer<typeof ActivatePlanActionSchema>

export const DispatchNodeActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('dispatch-node'),
    capability: z.literal('implement'),
    revisionId: IdSchema,
    taskKey: IdSchema,
    depsOrchestrationIds: z.array(IdSchema).max(128)
  })
  .strict()
export type DispatchNodeAction = z.infer<typeof DispatchNodeActionSchema>

export const IngestReportActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('ingest-report'),
    capability: z.literal('implement'),
    recovery: ReplaySafeSchema,
    revisionId: IdSchema,
    dispatchId: IdSchema,
    taskKey: IdSchema,
    orchestrationTaskId: IdSchema.nullable(),
    reportPath: z.string().trim().min(1).max(OBJECTIVE_PATH_MAX_LENGTH),
    filesModified: z.array(ObjectiveWorkspacePathSchema).max(256),
    dispatchedContentIdentity: IdSchema
  })
  .strict()
export type IngestReportAction = z.infer<typeof IngestReportActionSchema>

export const RunCheckActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('run-check'),
    capability: z.literal('check'),
    criterionId: IdSchema,
    command: z.string().trim().min(1).max(8_192)
  })
  .strict()
export type RunCheckAction = z.infer<typeof RunCheckActionSchema>

export const DispatchReviewerActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('dispatch-reviewer'),
    capability: z.literal('review'),
    revisionId: IdSchema
  })
  .strict()
export type DispatchReviewerAction = z.infer<typeof DispatchReviewerActionSchema>

export const DispatchIntegratorActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('dispatch-integrator'),
    capability: z.literal('review'),
    revisionId: IdSchema
  })
  .strict()
export type DispatchIntegratorAction = z.infer<typeof DispatchIntegratorActionSchema>

export const IngestVerdictActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('ingest-verdict'),
    capability: z.literal('review'),
    recovery: ReplaySafeSchema,
    revisionId: IdSchema,
    role: ObjectiveReviewRoleSchema,
    dispatchId: IdSchema,
    reportPath: z.string().trim().min(1).max(OBJECTIVE_PATH_MAX_LENGTH),
    reviewedContentIdentity: IdSchema
  })
  .strict()
export type IngestVerdictAction = z.infer<typeof IngestVerdictActionSchema>

export const RecordLandingActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('record-landing'),
    capability: z.literal('land'),
    recovery: ReplaySafeSchema,
    rung: z.literal('files-on-disk'),
    revisionId: IdSchema
  })
  .strict()
export type RecordLandingAction = z.infer<typeof RecordLandingActionSchema>

export const ObjectiveActionSchema = z.discriminatedUnion('kind', [
  DispatchPlannerActionSchema,
  IngestPlanActionSchema,
  ActivatePlanActionSchema,
  DispatchNodeActionSchema,
  IngestReportActionSchema,
  RunCheckActionSchema,
  DispatchReviewerActionSchema,
  DispatchIntegratorActionSchema,
  IngestVerdictActionSchema,
  RecordLandingActionSchema
])
export type ObjectiveAction = z.infer<typeof ObjectiveActionSchema>

export const ObjectiveActionNaturalKeySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan-revision'), dispatchId: IdSchema }).strict(),
  z.object({ kind: z.literal('plan-activation'), revisionId: IdSchema, digest: IdSchema }).strict(),
  z
    .object({
      kind: z.literal('implementer-report'),
      revisionId: IdSchema,
      taskKey: IdSchema,
      dispatchId: IdSchema
    })
    .strict(),
  z
    .object({ kind: z.literal('check-attempt'), criterionId: IdSchema, contentIdentity: IdSchema })
    .strict(),
  z.object({ kind: z.literal('review-verdict'), dispatchId: IdSchema }).strict(),
  z
    .object({
      kind: z.literal('landing-evidence'),
      rung: ObjectiveLandingBarSchema,
      contentIdentity: IdSchema
    })
    .strict()
])
export type ObjectiveActionNaturalKey = z.infer<typeof ObjectiveActionNaturalKeySchema>

export function objectiveActionNaturalKey(
  action: ObjectiveAction
): ObjectiveActionNaturalKey | null {
  switch (action.kind) {
    case 'ingest-plan':
      return { kind: 'plan-revision', dispatchId: action.dispatchId }
    case 'activate-plan':
      return { kind: 'plan-activation', revisionId: action.revisionId, digest: action.digest }
    case 'ingest-report':
      return {
        kind: 'implementer-report',
        revisionId: action.revisionId,
        taskKey: action.taskKey,
        dispatchId: action.dispatchId
      }
    case 'run-check':
      return {
        kind: 'check-attempt',
        criterionId: action.criterionId,
        contentIdentity: action.contentIdentity
      }
    case 'ingest-verdict':
      return { kind: 'review-verdict', dispatchId: action.dispatchId }
    case 'record-landing':
      return {
        kind: 'landing-evidence',
        rung: action.rung,
        contentIdentity: action.contentIdentity
      }
    case 'dispatch-planner':
    case 'dispatch-node':
    case 'dispatch-reviewer':
    case 'dispatch-integrator':
      return null
  }
}

const NaturalKeyResultBase = {
  naturalKey: ObjectiveActionNaturalKeySchema,
  digest: IdSchema
} as const

export const ObjectiveActionResultSchema = z.discriminatedUnion('kind', [
  z
    .object({ ...NaturalKeyResultBase, kind: z.literal('plan-ingested'), revisionId: IdSchema })
    .strict(),
  z.object({ ...NaturalKeyResultBase, kind: z.literal('plan-activated') }).strict(),
  z.object({ ...NaturalKeyResultBase, kind: z.literal('report-ingested') }).strict(),
  z
    .object({
      ...NaturalKeyResultBase,
      kind: z.literal('check-recorded'),
      exitCode: z.number().int().nullable(),
      timedOut: z.boolean()
    })
    .strict(),
  z
    .object({
      ...NaturalKeyResultBase,
      kind: z.literal('verdict-ingested'),
      verdict: ObjectiveVerdictSchema
    })
    .strict(),
  z.object({ ...NaturalKeyResultBase, kind: z.literal('landing-recorded') }).strict()
])
export type ObjectiveActionResult = z.infer<typeof ObjectiveActionResultSchema>
