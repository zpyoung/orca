import { z } from 'zod'
import { ExecutionHostIdSchema } from '../fork-heimdall/watcher-types'
import { ObjectiveWorkspacePathSchema } from './contract-types'
import { ImplementerReportSchema, ObjectivePlanTaskSchema } from './plan-schema'

const IdSchema = z.string().trim().min(1).max(1_024)
const TimestampSchema = z.number().int().nonnegative()

export const ObjectiveDispatchStateSchema = z.enum([
  'running',
  'waiting-to-apply',
  'applying',
  'resolving-conflict',
  'applied',
  'failed',
  'discarded'
])
export type ObjectiveDispatchState = z.infer<typeof ObjectiveDispatchStateSchema>

export const ObjectiveDispatchSetupStateSchema = z.enum([
  'pending',
  'ready',
  'cleanup-pending',
  'retained',
  'cleaned'
])
export type ObjectiveDispatchSetupState = z.infer<typeof ObjectiveDispatchSetupStateSchema>

/** Durable state for one isolated node/lane dispatch and its merge-train entry. */
export const ObjectiveDispatchRecordSchema = z
  .object({
    attemptFingerprint: IdSchema,
    watcherId: IdSchema,
    executionHostId: ExecutionHostIdSchema,
    revisionId: IdSchema,
    taskKey: IdSchema,
    planTaskDigest: IdSchema,
    dispatchId: IdSchema.nullable(),
    workspaceId: IdSchema,
    workspacePath: IdSchema,
    baseCommit: IdSchema,
    laneTaskKeys: z.array(IdSchema).min(1).max(128),
    sessionNodeCount: z.number().int().min(1).max(5),
    state: ObjectiveDispatchStateSchema,
    commitSha: IdSchema.nullable(),
    appliedCommitSha: IdSchema.nullable(),
    reportDigest: IdSchema.nullable(),
    conflictPaths: z.array(ObjectiveWorkspacePathSchema).max(256),
    conflictingTaskKeys: z.array(IdSchema).max(128),
    conflictingDispatchIds: z.array(IdSchema).max(128),
    createdAtMs: TimestampSchema,
    completedAtMs: TimestampSchema.nullable(),
    /** Durable terminal reuse metadata for lane continuation and conflict resumption. */
    terminalHandle: IdSchema.nullable(),
    /** Crash-safe worktree setup/cleanup progress. */
    setupState: ObjectiveDispatchSetupStateSchema,
    /** Durable accepted report context survives cleanup of an applied dispatch worktree. */
    reportPath: IdSchema.nullable(),
    report: ImplementerReportSchema.nullable(),
    /** Full task as dispatched, retained because a later plan amendment may replace it. */
    task: ObjectivePlanTaskSchema
  })
  .strict()
  .superRefine((record, context) => {
    if (!record.laneTaskKeys.includes(record.taskKey)) {
      context.addIssue({ code: 'custom', message: 'Dispatch lane must contain its task key' })
    }
    if (record.task.taskKey !== record.taskKey) {
      context.addIssue({
        code: 'custom',
        message: 'Dispatch task snapshot must match its task key'
      })
    }
    if (new TextEncoder().encode(JSON.stringify(record.task)).byteLength > 16 * 1_024) {
      context.addIssue({ code: 'custom', message: 'Dispatch task snapshot exceeds 16 KiB' })
    }
    if (record.report !== null && record.report.taskKey !== record.taskKey) {
      context.addIssue({ code: 'custom', message: 'Dispatch report must match its task key' })
    }
    if (
      record.state === 'resolving-conflict' &&
      (record.conflictingDispatchIds.length === 0 || record.conflictingTaskKeys.length === 0)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Conflict resolution requires exact dispatch and task provenance'
      })
    }
    if (
      (record.state === 'waiting-to-apply' ||
        record.state === 'applying' ||
        record.state === 'applied') &&
      (record.commitSha === null || record.report === null || record.reportDigest === null)
    ) {
      context.addIssue({
        code: 'custom',
        message: 'Queued dispatches require a validated report and node commit'
      })
    }
    if (record.state === 'applied' && record.appliedCommitSha === null) {
      context.addIssue({ code: 'custom', message: 'Applied dispatches require an applied commit' })
    }
  })
export type ObjectiveDispatchRecord = z.infer<typeof ObjectiveDispatchRecordSchema>

export const ObjectiveParallelProjectionSchema = z
  .object({
    effectiveMaxConcurrency: z.number().int().min(1).max(1_024),
    runningCount: z.number().int().nonnegative(),
    note: z.string().trim().min(1).max(2_048).optional(),
    dispatches: z.array(ObjectiveDispatchRecordSchema)
  })
  .strict()
export type ObjectiveParallelProjection = z.infer<typeof ObjectiveParallelProjectionSchema>
