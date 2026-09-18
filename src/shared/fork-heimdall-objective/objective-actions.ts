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
const ExpectedStateSchema = z
  .object({
    target: IdSchema,
    before: IdSchema
  })
  .strict()

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
    depsOrchestrationIds: z.array(IdSchema).max(128),
    /** The original dispatch's evidenceKey; present only on a bounded infra/environment redispatch. */
    retryOf: IdSchema.optional()
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

export const CommitLocalBranchActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('commit-local-branch'),
    capability: z.literal('land'),
    recovery: ReplaySafeSchema,
    rung: z.literal('committed-local-branch'),
    revisionId: IdSchema,
    branch: IdSchema,
    headSha: IdSchema,
    worktreeContentDigest: IdSchema,
    fromContentIdentity: IdSchema,
    attemptTrailer: IdSchema
  })
  .strict()
export type CommitLocalBranchAction = z.infer<typeof CommitLocalBranchActionSchema>

export const PushRefActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('push-ref'),
    capability: z.literal('land'),
    visibility: z.literal('external'),
    rung: z.literal('pushed-ref'),
    revisionId: IdSchema,
    branch: IdSchema,
    remote: IdSchema,
    commitSha: IdSchema,
    expectedState: ExpectedStateSchema
  })
  .strict()
export type PushRefAction = z.infer<typeof PushRefActionSchema>

export const OpenHostedReviewActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('open-hosted-review'),
    capability: z.literal('land'),
    visibility: z.literal('external'),
    rung: z.literal('hosted-review'),
    revisionId: IdSchema,
    branch: IdSchema,
    base: IdSchema,
    headSha: IdSchema,
    provider: z.enum(['github', 'gitlab']),
    expectedState: ExpectedStateSchema
  })
  .strict()
export type OpenHostedReviewAction = z.infer<typeof OpenHostedReviewActionSchema>

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
  RecordLandingActionSchema,
  CommitLocalBranchActionSchema,
  PushRefActionSchema,
  OpenHostedReviewActionSchema
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
    .strict(),
  z
    .object({
      kind: z.literal('commit-local-branch'),
      revisionId: IdSchema,
      fromContentIdentity: IdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('push-ref'),
      commitSha: IdSchema,
      remote: IdSchema,
      branch: IdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('open-hosted-review'),
      provider: z.enum(['github', 'gitlab']),
      branch: IdSchema,
      headSha: IdSchema
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
    case 'commit-local-branch':
      return {
        kind: 'commit-local-branch',
        revisionId: action.revisionId,
        fromContentIdentity: action.fromContentIdentity
      }
    case 'push-ref':
      return {
        kind: 'push-ref',
        commitSha: action.commitSha,
        remote: action.remote,
        branch: action.branch
      }
    case 'open-hosted-review':
      return {
        kind: 'open-hosted-review',
        provider: action.provider,
        branch: action.branch,
        headSha: action.headSha
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
  z.object({ ...NaturalKeyResultBase, kind: z.literal('landing-recorded') }).strict(),
  z
    .object({
      naturalKey: ObjectiveActionNaturalKeySchema,
      kind: z.literal('commit-recorded'),
      commitSha: IdSchema,
      contentIdentity: IdSchema,
      outsideTerritoryPaths: z.array(ObjectiveWorkspacePathSchema).max(256)
    })
    .strict(),
  z
    .object({
      naturalKey: ObjectiveActionNaturalKeySchema,
      kind: z.literal('push-recorded'),
      remoteSha: IdSchema
    })
    .strict(),
  z
    .object({
      naturalKey: ObjectiveActionNaturalKeySchema,
      kind: z.literal('review-recorded'),
      reviewNumber: z.number().int().positive().safe(),
      reviewUrl: z.string().trim().url()
    })
    .strict()
])
export type ObjectiveActionResult = z.infer<typeof ObjectiveActionResultSchema>
