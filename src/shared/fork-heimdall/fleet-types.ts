import { z } from 'zod'
import { BudgetPolicySchema } from './budget'
import { ApprovalScopeSchema, WatcherLedgerSchema } from './ledger-types'
import { WatcherTickTraceSchema } from './tick-trace'
import {
  AutomationSchedulerOwnerSchema,
  ExecutionHostIdSchema,
  WatcherListEntrySchema,
  WorkspaceKeySchema
} from './watcher-types'

export const HEIMDALL_FLEET_CHANGED_CHANNEL = 'heimdall:fleetChanged'
const IdSchema = z.string().trim().min(1)
const TimestampSchema = z.number().int().nonnegative()

export const WatcherTargetSchema = z
  .object({
    watcherId: IdSchema,
    connectionId: IdSchema.nullable(),
    pairingRevision: z.number().finite().nullable()
  })
  .strict()
  .refine(
    (target) => (target.connectionId === null) === (target.pairingRevision === null),
    'Remote targets require the observed pairing revision; local targets have no pairing revision'
  )
export type WatcherTarget = z.infer<typeof WatcherTargetSchema>

export const WatcherOwnerFenceSchema = z
  .object({
    executionHostId: ExecutionHostIdSchema,
    schedulerOwner: AutomationSchedulerOwnerSchema,
    workspaceKey: WorkspaceKeySchema,
    revision: z.number().int().nonnegative()
  })
  .strict()
export type WatcherOwnerFence = z.infer<typeof WatcherOwnerFenceSchema>

export const WatcherFleetActivitySchema = z
  .object({
    kind: z.enum(['agent-in-flight', 'check-running', 'action-running', 'waiting']),
    count: z.number().int().nonnegative(),
    detail: z.string().trim().min(1).nullable(),
    startedAtMs: TimestampSchema.nullable()
  })
  .strict()
export type WatcherFleetActivity = z.infer<typeof WatcherFleetActivitySchema>

export const WatcherFleetWorkspaceSchema = z
  .object({
    label: IdSchema,
    kind: z.enum(['git', 'folder']),
    branch: IdSchema.nullable()
  })
  .strict()
export type WatcherFleetWorkspace = z.infer<typeof WatcherFleetWorkspaceSchema>

export const WatcherFleetEntrySchema = z
  .object({
    target: WatcherTargetSchema,
    entry: WatcherListEntrySchema,
    ownerFence: WatcherOwnerFenceSchema,
    observedAtMs: TimestampSchema,
    contact: z.enum(['live', 'unverifiable']),
    readOnlyReason: z.string().nullable(),
    capabilityNotes: z.array(z.string()),
    paused: z.boolean(),
    workflowPhase: IdSchema.nullable().optional(),
    activity: WatcherFleetActivitySchema.optional(),
    workspace: WatcherFleetWorkspaceSchema.optional()
  })
  .strict()
export type WatcherFleetEntry = z.infer<typeof WatcherFleetEntrySchema>

export const HeimdallFleetSnapshotSchema = z
  .object({
    entries: z.array(WatcherFleetEntrySchema),
    generatedAtMs: TimestampSchema
  })
  .strict()
export type HeimdallFleetSnapshot = z.infer<typeof HeimdallFleetSnapshotSchema>

export const WatcherWorkerNavigationSchema = z
  .object({
    worktreeId: IdSchema,
    executionHostId: ExecutionHostIdSchema,
    paneKey: IdSchema
  })
  .strict()
export type WatcherWorkerNavigation = z.infer<typeof WatcherWorkerNavigationSchema>

export const WatcherWorkerSchema = z
  .object({
    dispatchId: IdSchema,
    task: z.string(),
    dispatchedAtMs: TimestampSchema,
    lastContactAtMs: TimestampSchema.nullable(),
    liveness: z.enum(['live', 'unverifiable', 'exited']),
    reason: z.string().nullable(),
    question: z.object({ messageId: IdSchema, body: z.string() }).strict().nullable(),
    navigation: WatcherWorkerNavigationSchema.nullable().optional()
  })
  .strict()
export type WatcherWorker = z.infer<typeof WatcherWorkerSchema>

export const WatcherDetailSchema = z
  .object({
    watcher: WatcherFleetEntrySchema,
    ledger: WatcherLedgerSchema,
    traces: z.array(WatcherTickTraceSchema),
    workers: z.array(WatcherWorkerSchema)
  })
  .strict()
export type WatcherDetail = z.infer<typeof WatcherDetailSchema>

export const WatcherCommandSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('pause') }).strict(),
  z.object({ kind: z.literal('resume') }).strict(),
  z.object({ kind: z.literal('disarm') }).strict(),
  z.object({ kind: z.literal('approve'), scope: ApprovalScopeSchema }).strict(),
  z.object({ kind: z.literal('adjust-budget'), budget: BudgetPolicySchema }).strict(),
  z.object({ kind: z.literal('answer-question'), messageId: IdSchema, body: IdSchema }).strict(),
  z.object({ kind: z.literal('stop-worker'), dispatchId: IdSchema }).strict()
])
export type WatcherCommand = z.infer<typeof WatcherCommandSchema>

export const WatcherCommandRequestSchema = z
  .object({
    target: WatcherTargetSchema,
    expectedOwner: WatcherOwnerFenceSchema,
    command: WatcherCommandSchema
  })
  .strict()
export type WatcherCommandRequest = z.infer<typeof WatcherCommandRequestSchema>

export const WatcherCommandResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied'), appliedAtMs: TimestampSchema }).strict(),
  z
    .object({
      status: z.literal('refused'),
      reason: z.enum([
        'owner-unreachable',
        'unsupported-capability',
        'owner-conflict',
        'stale-revision',
        'watcher-not-found',
        'invalid-state',
        'question-already-answered',
        'worker-unverifiable',
        'coordinator-seat-lost',
        'invalid-command'
      ]),
      detail: z.string()
    })
    .strict(),
  z.object({ status: z.literal('indeterminate'), detail: z.string() }).strict()
])
export type WatcherCommandResult = z.infer<typeof WatcherCommandResultSchema>
