import { z } from 'zod'
import { BudgetPolicySchema } from '../fork-heimdall/budget'
import { JudgmentSnapshotSchema } from '../fork-heimdall/judgment/types'
import {
  ObjectiveCapabilitiesSchema,
  ObjectiveEnrollmentPayloadSchema,
  ObjectiveLandingBarSchema,
  ObjectiveRoleSchema,
  ObjectiveWorkspacePathSchema,
  ObjectiveWorkspaceKindSchema
} from './contract-types'

const IdSchema = z.string().trim().min(1).max(1_024)
const TimestampSchema = z.number().int().nonnegative()

export const ObjectiveRevisionStatusSchema = z.enum(['draft', 'approved', 'rejected', 'superseded'])
export type ObjectiveRevisionStatus = z.infer<typeof ObjectiveRevisionStatusSchema>

export const ObjectiveNodeStateSchema = z.enum([
  'pending',
  'blocked-by-deps',
  'awaiting-approval',
  'dispatched',
  'succeeded',
  'failed',
  'replanned'
])
export type ObjectiveNodeState = z.infer<typeof ObjectiveNodeStateSchema>

export const ObjectiveReviewRoleSchema = z.enum(['reviewer', 'integrator'])
export type ObjectiveReviewRole = z.infer<typeof ObjectiveReviewRoleSchema>

export const ObjectiveVerdictSchema = z.enum(['approve', 'block'])
export type ObjectiveVerdict = z.infer<typeof ObjectiveVerdictSchema>

export const ObjectiveCheckProjectionSchema = z
  .object({
    contentIdentity: IdSchema,
    exitCode: z.number().int().nullable(),
    timedOut: z.boolean(),
    atMs: TimestampSchema
  })
  .strict()
export type ObjectiveCheckProjection = z.infer<typeof ObjectiveCheckProjectionSchema>

export const ObjectiveCriterionProjectionSchema = z
  .object({
    id: IdSchema,
    ordinal: z.number().int().nonnegative(),
    body: z.string().trim().min(1).max(8_192),
    shellCheckable: z.boolean(),
    checkCommand: z.string().trim().min(1).max(8_192).nullable(),
    lastCheck: ObjectiveCheckProjectionSchema.nullable(),
    lastReview: z.enum(['pass', 'block']).nullable()
  })
  .strict()
  .refine(
    (criterion) => criterion.shellCheckable === (criterion.checkCommand !== null),
    'shellCheckable must agree with checkCommand'
  )
export type ObjectiveCriterionProjection = z.infer<typeof ObjectiveCriterionProjectionSchema>

export const ObjectiveRevisionProjectionSchema = z
  .object({
    id: IdSchema,
    number: z.number().int().positive(),
    status: ObjectiveRevisionStatusSchema,
    digest: IdSchema,
    createdByDispatchId: IdSchema.nullable(),
    createdAtMs: TimestampSchema,
    approvedAtMs: TimestampSchema.nullable()
  })
  .strict()
export type ObjectiveRevisionProjection = z.infer<typeof ObjectiveRevisionProjectionSchema>

export const ObjectiveNodeProjectionSchema = z
  .object({
    revisionId: IdSchema,
    taskKey: IdSchema,
    deps: z.array(IdSchema).max(128),
    orchestrationTaskId: IdSchema.nullable(),
    dispatchId: IdSchema.nullable(),
    state: ObjectiveNodeStateSchema,
    criteria: z.array(ObjectiveCriterionProjectionSchema).max(64)
  })
  .strict()
export type ObjectiveNodeProjection = z.infer<typeof ObjectiveNodeProjectionSchema>

export const ObjectiveVerdictProjectionSchema = z
  .object({
    dispatchId: IdSchema,
    revisionId: IdSchema,
    role: ObjectiveReviewRoleSchema,
    verdict: ObjectiveVerdictSchema,
    contentIdentity: IdSchema,
    reportDigest: IdSchema,
    atMs: TimestampSchema
  })
  .strict()
export type ObjectiveVerdictProjection = z.infer<typeof ObjectiveVerdictProjectionSchema>

export const ObjectiveLandingProjectionSchema = z
  .object({
    rung: ObjectiveLandingBarSchema,
    revisionId: IdSchema,
    contentIdentity: IdSchema,
    fromContentIdentity: IdSchema.optional(),
    branch: IdSchema.optional(),
    commitSha: IdSchema.optional(),
    remote: IdSchema.optional(),
    remoteSha: z.string().max(1_024).optional(),
    provider: z.enum(['github', 'gitlab']).optional(),
    reviewNumber: z.number().int().positive().safe().optional(),
    reviewUrl: z.string().trim().url().optional(),
    headSha: IdSchema.optional(),
    base: IdSchema.optional(),
    atMs: TimestampSchema
  })
  .strict()
export type ObjectiveLandingProjection = z.infer<typeof ObjectiveLandingProjectionSchema>

export const ObjectiveProjectionSchema = z
  .object({
    revisions: z.array(ObjectiveRevisionProjectionSchema),
    nodes: z.array(ObjectiveNodeProjectionSchema),
    verdicts: z.array(ObjectiveVerdictProjectionSchema),
    landing: z.array(ObjectiveLandingProjectionSchema)
  })
  .strict()
export type ObjectiveProjection = z.infer<typeof ObjectiveProjectionSchema>

export const ObjectivePendingReportSchema = z
  .object({
    dispatchId: IdSchema,
    actionKind: z.enum([
      'dispatch-planner',
      'dispatch-node',
      'dispatch-reviewer',
      'dispatch-integrator'
    ]),
    outcome: z.enum(['succeeded', 'failed']),
    reportPath: IdSchema.nullable(),
    filesModified: z.array(ObjectiveWorkspacePathSchema).max(256),
    orchestrationTaskId: IdSchema.nullable(),
    taskKey: IdSchema.nullable(),
    dispatchedContentIdentity: IdSchema,
    atMs: TimestampSchema,
    subject: z.string().max(2_048).optional(),
    body: z.string().max(8_192).optional()
  })
  .strict()
export type ObjectivePendingReport = z.infer<typeof ObjectivePendingReportSchema>
export const ObjectiveBudgetBucketSchema = z.enum(['plenty', 'tight', 'nearly-spent', 'spent'])
export type ObjectiveBudgetBucket = z.infer<typeof ObjectiveBudgetBucketSchema>

export const ObjectiveLandingContextSchema = z
  .object({
    branch: IdSchema.nullable(),
    headSha: IdSchema.nullable(),
    worktreeContentDigest: IdSchema.nullable(),
    pushTarget: z
      .object({
        remote: IdSchema,
        branch: IdSchema,
        remoteSha: IdSchema
      })
      .strict()
      .nullable(),
    hostedReview: z
      .object({
        provider: z.enum(['github', 'gitlab']),
        repoKey: IdSchema,
        base: IdSchema.nullable()
      })
      .strict()
      .nullable()
  })
  .strict()
export type ObjectiveLandingContext = z.infer<typeof ObjectiveLandingContextSchema>
export const JudgmentReportEvidenceSchema = z
  .object({
    dispatchId: IdSchema,
    role: ObjectiveRoleSchema,
    digest: IdSchema,
    payload: z.record(z.string(), z.unknown())
  })
  .strict()
export type JudgmentReportEvidence = z.infer<typeof JudgmentReportEvidenceSchema>

export const ObjectiveWorldSchema = z
  .object({
    contract: ObjectiveEnrollmentPayloadSchema,
    workspaceKind: ObjectiveWorkspaceKindSchema,
    plan: ObjectiveProjectionSchema,
    reports: z.array(ObjectivePendingReportSchema),
    budget: BudgetPolicySchema,
    capabilities: ObjectiveCapabilitiesSchema.optional(),
    landingContext: ObjectiveLandingContextSchema,
    judgmentReports: z.array(JudgmentReportEvidenceSchema).optional(),
    judgment: JudgmentSnapshotSchema.optional()
  })
  .strict()
export type ObjectiveWorld = z.infer<typeof ObjectiveWorldSchema>

export const ObjectiveDetailRevisionSchema = ObjectiveRevisionProjectionSchema.omit({
  createdByDispatchId: true
})
  .extend({ nodeCount: z.number().int().nonnegative() })
  .strict()
export type ObjectiveDetailRevision = z.infer<typeof ObjectiveDetailRevisionSchema>

export const ObjectiveDetailCriterionSchema = z
  .object({
    id: IdSchema,
    body: z.string().trim().min(1).max(2_048),
    shellCheckable: z.boolean(),
    lastCheck: ObjectiveCheckProjectionSchema.nullable(),
    lastReview: z.enum(['pass', 'block']).nullable()
  })
  .strict()
export type ObjectiveDetailCriterion = z.infer<typeof ObjectiveDetailCriterionSchema>

export const ObjectiveDetailNodeSchema = z
  .object({
    taskKey: IdSchema,
    title: z.string().trim().min(1).max(512),
    revisionId: IdSchema,
    orchestrationTaskId: IdSchema.nullable(),
    dispatchId: IdSchema.nullable(),
    state: ObjectiveNodeStateSchema,
    criteria: z.array(ObjectiveDetailCriterionSchema).max(64)
  })
  .strict()
export type ObjectiveDetailNode = z.infer<typeof ObjectiveDetailNodeSchema>

export const ObjectiveDetailSchema = z
  .object({
    contract: ObjectiveEnrollmentPayloadSchema,
    revisions: z.array(ObjectiveDetailRevisionSchema),
    nodes: z.array(ObjectiveDetailNodeSchema),
    verdicts: z.array(
      ObjectiveVerdictProjectionSchema.pick({
        dispatchId: true,
        role: true,
        verdict: true,
        contentIdentity: true,
        atMs: true
      }).strict()
    ),
    landing: z.array(
      ObjectiveLandingProjectionSchema.pick({
        rung: true,
        contentIdentity: true,
        atMs: true
      }).strict()
    ),
    asOfMs: TimestampSchema
  })
  .strict()
export type ObjectiveDetail = z.infer<typeof ObjectiveDetailSchema>
