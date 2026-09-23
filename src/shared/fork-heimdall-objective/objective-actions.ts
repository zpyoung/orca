import { z } from 'zod'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../fork-heimdall/owner/intervention'
import { OWNER_INTERVENTION_CAPABILITY } from '../fork-heimdall/owner/owner-capability'
import {
  OBJECTIVE_AGENT_ID_MAX_LENGTH,
  OBJECTIVE_CHECK_COMMAND_MAX_LENGTH,
  OBJECTIVE_GATE_MAX_TIMEOUT_SECONDS,
  OBJECTIVE_GATE_MIN_TIMEOUT_SECONDS,
  OBJECTIVE_GATE_NAME_PATTERN,
  OBJECTIVE_TASK_SPEC_MAX_LENGTH,
  ObjectiveLandingBarSchema,
  ObjectiveWorkspacePathSchema,
  OBJECTIVE_PATH_MAX_LENGTH
} from './contract-types'
import { ObjectiveReviewRoleSchema } from './detail-types'
import { RevisionAmendmentPatchSchema } from './revision-amendment'

const IdSchema = z.string().trim().min(1).max(1_024)

/**
 * Marks a `skip-review` action's synthetic dispatchId, namespaced so it can never collide with a
 * real orchestration dispatch id. The one place that has to agree with this is
 * `objective-store-projection.ts`, which uses the same prefix to flag a verdict row as
 * owner-synthesized rather than infer it from anything content-dependent.
 */
export const OWNER_SKIP_REVIEW_DISPATCH_PREFIX = 'owner-skip-review:'

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

/** An owner-intervention action stamps this capability over the kind's own; the schema must accept both. */
function ownerOverridableCapability<T extends string>(capability: T) {
  return z.union([z.literal(capability), z.literal(OWNER_INTERVENTION_CAPABILITY)])
}

/** A repair-only field must be present exactly when `shape` is `'repair'` — never both, never neither. */
function repairIssue(ok: boolean, repair: boolean, path: string, ctx: z.RefinementCtx): void {
  if (ok) {
    return
  }
  const verb = repair ? 'is required' : 'is only allowed'
  ctx.addIssue({ code: 'custom', path: [path], message: `${path} ${verb} when shape is repair` })
}

export const DispatchPlannerActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('dispatch-planner'),
    capability: ownerOverridableCapability('plan'),
    revisionNumber: z.number().int().positive(),
    reason: z.enum(['initial', 'replan-after-block', 'replan-after-failure', 'owner-directed']),
    /** Free-text steer for the planner prompt; only ever set on an owner-directed dispatch. */
    guidance: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH).optional(),
    /** Landing-ladder stage an owner asked to skip, kept separate from the exact rationale text. */
    requestedSkipStage: IdSchema.optional(),
    /** Absent means a wholesale replan; 'repair' asks the planner to patch the approved revision. */
    shape: z.enum(['full', 'repair']).optional(),
    repairOrdinal: z.number().int().positive().optional(),
    /** The approved revision this repair targets; only set alongside `shape: 'repair'`. */
    repairRevisionId: IdSchema.optional(),
    /** Escalation: the next gate check treats an 'on' capability as 'gated' for this action. */
    approvalRequired: z.literal(true).optional()
  })
  .strict()
  .superRefine((action, ctx) => {
    const repair = action.shape === 'repair'
    repairIssue(repair === (action.repairOrdinal !== undefined), repair, 'repairOrdinal', ctx)
    repairIssue(repair === (action.repairRevisionId !== undefined), repair, 'repairRevisionId', ctx)
  })
export type DispatchPlannerAction = z.infer<typeof DispatchPlannerActionSchema>

export const IngestPlanActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('ingest-plan'),
    capability: z.literal('plan'),
    recovery: ReplaySafeSchema,
    dispatchId: IdSchema,
    revisionNumber: z.number().int().positive(),
    reportPath: z.string().trim().min(1).max(OBJECTIVE_PATH_MAX_LENGTH),
    /** Absent means a wholesale replan; 'repair' ingests a patch against `targetRevisionId`. */
    shape: z.enum(['full', 'repair']).optional(),
    targetRevisionId: IdSchema.optional()
  })
  .strict()
  .superRefine((action, ctx) => {
    const repair = action.shape === 'repair'
    repairIssue(repair === (action.targetRevisionId !== undefined), repair, 'targetRevisionId', ctx)
  })
export type IngestPlanAction = z.infer<typeof IngestPlanActionSchema>

export const ActivatePlanActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('activate-plan'),
    capability: z.literal('plan'),
    recovery: ReplaySafeSchema,
    revisionId: IdSchema,
    digest: IdSchema,
    /** Escalation: the next gate check treats an 'on' capability as 'gated' for this action. */
    approvalRequired: z.literal(true).optional()
  })
  .strict()
export type ActivatePlanAction = z.infer<typeof ActivatePlanActionSchema>

/** Applies a stored planner repair patch to its revision via the amend path. */
export const ApplyPlanPatchActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('apply-plan-patch'),
    capability: z.literal('plan'),
    recovery: ReplaySafeSchema,
    revisionId: IdSchema,
    patchId: IdSchema,
    digest: IdSchema,
    /** Escalation: the next gate check treats an 'on' capability as 'gated' for this action. */
    approvalRequired: z.literal(true).optional()
  })
  .strict()
export type ApplyPlanPatchAction = z.infer<typeof ApplyPlanPatchActionSchema>

export const DispatchNodeActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('dispatch-node'),
    capability: ownerOverridableCapability('implement'),
    revisionId: IdSchema,
    taskKey: IdSchema,
    depsOrchestrationIds: z.array(IdSchema).max(128),
    /** The original dispatch's evidenceKey; present on a bounded infra/environment or owner redispatch. */
    retryOf: IdSchema.optional(),
    /** Set only by an owner `retry-node`; overrides the plan task's spec for this dispatch only. */
    ownerAmendedSpec: z.string().trim().min(1).max(OBJECTIVE_TASK_SPEC_MAX_LENGTH).optional(),
    /** Set only by an owner `retry-node`; overrides normal agent routing for this dispatch only. */
    ownerAgent: z.string().trim().min(1).max(OBJECTIVE_AGENT_ID_MAX_LENGTH).optional()
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

/** Applies one validated isolated dispatch commit to the enrolled branch. */
export const ApplyNodeActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('apply-node'),
    capability: z.literal('implement'),
    recovery: ReplaySafeSchema,
    revisionId: IdSchema,
    taskKey: IdSchema,
    dispatchId: IdSchema
  })
  .strict()
export type ApplyNodeAction = z.infer<typeof ApplyNodeActionSchema>

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

export const RunGateActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('run-gate'),
    capability: z.literal('check'),
    gateName: z.string().regex(OBJECTIVE_GATE_NAME_PATTERN),
    command: z.string().trim().min(1).max(OBJECTIVE_CHECK_COMMAND_MAX_LENGTH),
    timeoutSeconds: z
      .number()
      .int()
      .min(OBJECTIVE_GATE_MIN_TIMEOUT_SECONDS)
      .max(OBJECTIVE_GATE_MAX_TIMEOUT_SECONDS)
  })
  .strict()
export type RunGateAction = z.infer<typeof RunGateActionSchema>

export const DispatchReviewerActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('dispatch-reviewer'),
    capability: z.literal('review'),
    revisionId: IdSchema,
    /** Present only for the bounded reviewer added by an acting judgment quality decision. */
    judgmentReviewOf: IdSchema.optional()
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

export const PlanReviewTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('revision'), revisionId: IdSchema }).strict(),
  z.object({ kind: z.literal('patch'), patchId: IdSchema }).strict()
])

export const DispatchPlanReviewActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('dispatch-plan-review'),
    capability: z.literal('review'),
    target: PlanReviewTargetSchema,
    round: z.union([z.literal(1), z.literal(2)])
  })
  .strict()

export const IngestPlanReviewActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('ingest-plan-review'),
    capability: z.literal('review'),
    recovery: ReplaySafeSchema,
    dispatchId: IdSchema,
    reportPath: z.string().trim().min(1).max(OBJECTIVE_PATH_MAX_LENGTH),
    target: PlanReviewTargetSchema
  })
  .strict()

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

/** An owner override that lands a node despite a rejected report; the attestation is the audit trail. */
export const AcceptReportActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('accept-report'),
    capability: ownerOverridableCapability('implement'),
    recovery: ReplaySafeSchema,
    revisionId: IdSchema,
    taskKey: IdSchema,
    dispatchId: IdSchema,
    attestation: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
  })
  .strict()
export type AcceptReportAction = z.infer<typeof AcceptReportActionSchema>

/** An owner correction to an approved revision, applied via `ObjectiveStoreMutations.amendRevision`. */
export const AmendPlanActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('amend-plan'),
    capability: ownerOverridableCapability('plan'),
    recovery: ReplaySafeSchema,
    revisionId: IdSchema,
    patch: RevisionAmendmentPatchSchema,
    /** The owner's own rationale for the intervention; `patch.attestation` is what the store persists. */
    attestation: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
  })
  .strict()
export type AmendPlanAction = z.infer<typeof AmendPlanActionSchema>

/** Records a synthetic 'approve' verdict, bypassing a reviewer/integrator dispatch entirely. */
export const SkipReviewActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('skip-review'),
    capability: ownerOverridableCapability('review'),
    recovery: ReplaySafeSchema,
    revisionId: IdSchema,
    role: ObjectiveReviewRoleSchema,
    dispatchId: IdSchema,
    reviewedContentIdentity: IdSchema,
    rationale: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
  })
  .strict()
export type SkipReviewAction = z.infer<typeof SkipReviewActionSchema>

/** Records a synthetic passing check result, bypassing `run-check` for one criterion. */
export const SkipCheckActionSchema = z
  .object({
    ...ActionBase,
    kind: z.literal('skip-check'),
    capability: ownerOverridableCapability('check'),
    recovery: ReplaySafeSchema,
    criterionId: IdSchema,
    rationale: z.string().trim().min(1).max(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
  })
  .strict()
export type SkipCheckAction = z.infer<typeof SkipCheckActionSchema>

export const ObjectiveActionSchema = z.discriminatedUnion('kind', [
  DispatchPlannerActionSchema,
  IngestPlanActionSchema,
  ActivatePlanActionSchema,
  DispatchNodeActionSchema,
  IngestReportActionSchema,
  ApplyNodeActionSchema,
  RunCheckActionSchema,
  RunGateActionSchema,
  DispatchReviewerActionSchema,
  DispatchIntegratorActionSchema,
  IngestVerdictActionSchema,
  RecordLandingActionSchema,
  CommitLocalBranchActionSchema,
  PushRefActionSchema,
  OpenHostedReviewActionSchema,
  AcceptReportActionSchema,
  AmendPlanActionSchema,
  SkipReviewActionSchema,
  SkipCheckActionSchema,
  ApplyPlanPatchActionSchema,
  DispatchPlanReviewActionSchema,
  IngestPlanReviewActionSchema
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
    .object({
      kind: z.literal('node-application'),
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
    .strict(),
  z.object({ kind: z.literal('plan-amendment'), revisionId: IdSchema, digest: IdSchema }).strict(),
  z
    .object({ kind: z.literal('gate-attempt'), gateName: IdSchema, contentIdentity: IdSchema })
    .strict(),
  z.object({ kind: z.literal('plan-patch'), patchId: IdSchema }).strict(),
  z.object({ kind: z.literal('plan-review'), dispatchId: IdSchema }).strict()
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
    case 'accept-report': {
      const { revisionId, taskKey, dispatchId } = action
      return { kind: 'implementer-report', revisionId, taskKey, dispatchId }
    }
    case 'apply-node': {
      const { revisionId, taskKey, dispatchId } = action
      return { kind: 'node-application', revisionId, taskKey, dispatchId }
    }
    case 'run-check':
    case 'skip-check': {
      const { criterionId, contentIdentity } = action
      return { kind: 'check-attempt', criterionId, contentIdentity }
    }
    case 'ingest-verdict':
    case 'skip-review':
      return { kind: 'review-verdict', dispatchId: action.dispatchId }
    case 'record-landing': {
      const { rung, contentIdentity } = action
      return { kind: 'landing-evidence', rung, contentIdentity }
    }
    case 'commit-local-branch': {
      const { revisionId, fromContentIdentity } = action
      return { kind: 'commit-local-branch', revisionId, fromContentIdentity }
    }
    case 'push-ref': {
      const { commitSha, remote, branch } = action
      return { kind: 'push-ref', commitSha, remote, branch }
    }
    case 'open-hosted-review': {
      const { provider, branch, headSha } = action
      return { kind: 'open-hosted-review', provider, branch, headSha }
    }
    case 'amend-plan':
      return { kind: 'plan-amendment', revisionId: action.revisionId, digest: action.patch.digest }
    case 'run-gate': {
      const { gateName, contentIdentity } = action
      return { kind: 'gate-attempt', gateName, contentIdentity }
    }
    case 'apply-plan-patch':
      return { kind: 'plan-patch', patchId: action.patchId }
    case 'ingest-plan-review':
      return { kind: 'plan-review', dispatchId: action.dispatchId }
    case 'dispatch-planner':
    case 'dispatch-node':
    case 'dispatch-reviewer':
    case 'dispatch-integrator':
    case 'dispatch-plan-review':
      return null
  }
}
