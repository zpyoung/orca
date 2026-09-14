import { z } from 'zod'
import type { AutomationSchedulerOwner } from '../automations-types'
import { parseExecutionHostId, type ExecutionHostId } from '../execution-host'
import { BudgetExhaustionSchema, BudgetPolicySchema, BudgetStateSchema } from './budget'

const IdSchema = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0)
const TimestampSchema = z.number().int().nonnegative()

export const WatcherKindIdSchema = z.enum(['hosted-review', 'objective'])
export type WatcherKindId = z.infer<typeof WatcherKindIdSchema>

export const CapabilityModeSchema = z.enum(['off', 'gated', 'on'])
export type CapabilityMode = z.infer<typeof CapabilityModeSchema>

export const AutomationSchedulerOwnerSchema: z.ZodType<AutomationSchedulerOwner> = z.enum([
  'local_host_service',
  'ssh_bridge',
  'remote_host_service'
])

export const ExecutionHostIdSchema = z.custom<ExecutionHostId>(
  (value) => typeof value === 'string' && parseExecutionHostId(value)?.id === value
)

export type WorkspaceKey = `${ExecutionHostId}::${string}`
export const WorkspaceKeySchema = z.custom<WorkspaceKey>((value) => {
  if (typeof value !== 'string') {
    return false
  }
  const separator = value.indexOf('::')
  const hostId = value.slice(0, separator)
  return (
    separator > 0 && separator + 2 < value.length && parseExecutionHostId(hostId)?.id === hostId
  )
})

export const CoordinatorIdentitySchema = z
  .object({
    handle: IdSchema,
    paneKey: IdSchema
  })
  .strict()
export type CoordinatorIdentity = z.infer<typeof CoordinatorIdentitySchema>

export const WatcherEnrollmentSchema = z
  .object({
    watcherId: IdSchema,
    kind: WatcherKindIdSchema,
    workspaceKey: WorkspaceKeySchema,
    executionHostId: ExecutionHostIdSchema,
    repoId: IdSchema,
    worktreeId: IdSchema.nullable(),
    workspacePath: IdSchema,
    schedulerOwner: AutomationSchedulerOwnerSchema,
    enabled: z.boolean(),
    capabilities: z.record(z.string().min(1), CapabilityModeSchema),
    budget: BudgetPolicySchema,
    kindPayload: z.unknown(),
    coordinatorIdentity: CoordinatorIdentitySchema,
    orchestrationRunId: IdSchema.nullable(),
    createdAtMs: TimestampSchema,
    terminalAtMs: TimestampSchema.nullable()
  })
  .strict()
  .refine(
    (value) => value.workspaceKey.startsWith(`${value.executionHostId}::`),
    'workspaceKey must be scoped to executionHostId'
  )
export type WatcherEnrollment = z.infer<typeof WatcherEnrollmentSchema>

export const WatcherParkReasonSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('budget'),
      exhaustion: BudgetExhaustionSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('stop-predicate'),
      predicateId: IdSchema,
      reason: IdSchema
    })
    .strict(),
  z
    .object({
      kind: z.literal('worker-question'),
      messageId: IdSchema
    })
    .strict(),
  z.object({ kind: z.literal('coordinator-seat-lost') }).strict()
])
export type WatcherParkReason = z.infer<typeof WatcherParkReasonSchema>

export const WatcherStatusStateSchema = z.enum([
  'watching',
  'held',
  'acting',
  'escalated',
  'parked',
  'terminal',
  'disabled',
  'unreachable'
])
export type WatcherStatusState = z.infer<typeof WatcherStatusStateSchema>

export const WatcherStatusSchema = z
  .object({
    watcherId: IdSchema,
    enabled: z.boolean(),
    state: WatcherStatusStateSchema,
    phase: IdSchema,
    reason: z.string().nullable(),
    parkReason: WatcherParkReasonSchema.nullable(),
    budget: BudgetStateSchema,
    startedAtMs: TimestampSchema,
    lastSuccessfulTickAtMs: TimestampSchema.nullable(),
    nextPulseAtMs: TimestampSchema.nullable()
  })
  .strict()
export type WatcherStatus = z.infer<typeof WatcherStatusSchema>

export const WatcherListEntrySchema = z
  .object({
    name: IdSchema,
    enrollment: WatcherEnrollmentSchema,
    status: WatcherStatusSchema
  })
  .strict()
export type WatcherListEntry = z.infer<typeof WatcherListEntrySchema>

/** Renderer input selects a workspace candidate; authority fields are re-derived by the owner. */
export const EnrollInputSchema = z
  .object({
    kind: WatcherKindIdSchema,
    repoId: IdSchema,
    worktreeId: IdSchema.nullable(),
    capabilities: z.record(z.string().min(1), CapabilityModeSchema),
    budget: BudgetPolicySchema,
    kindPayload: z.unknown()
  })
  .strict()
export type EnrollInput = z.infer<typeof EnrollInputSchema>

/** Owner-derived enrollment data. Only this shape may become persisted authority. */
export const AuthorizedEnrollmentSchema = z
  .object({
    kind: WatcherKindIdSchema,
    workspaceKey: WorkspaceKeySchema,
    executionHostId: ExecutionHostIdSchema,
    repoId: IdSchema,
    worktreeId: IdSchema.nullable(),
    workspacePath: IdSchema,
    schedulerOwner: AutomationSchedulerOwnerSchema,
    capabilities: z.record(z.string().min(1), CapabilityModeSchema),
    budget: BudgetPolicySchema,
    kindPayload: z.unknown()
  })
  .strict()
  .refine(
    (value) => value.workspaceKey.startsWith(`${value.executionHostId}::`),
    'workspaceKey must be scoped to executionHostId'
  )
export type AuthorizedEnrollment = z.infer<typeof AuthorizedEnrollmentSchema>

export const EnrollResultSchema = z.union([
  z.object({ status: z.literal('enrolled'), entry: WatcherListEntrySchema }).strict(),
  z.object({ status: z.literal('re-armed'), entry: WatcherListEntrySchema }).strict(),
  z
    .object({
      status: z.literal('refused'),
      reason: z.literal('duplicate-workspace'),
      existingWatcherId: IdSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('refused'),
      reason: z.literal('owner-not-executable'),
      schedulerOwner: AutomationSchedulerOwnerSchema
    })
    .strict(),
  z
    .object({
      status: z.literal('refused'),
      reason: z.enum(['unknown-kind', 'invalid-payload']),
      detail: IdSchema
    })
    .strict()
])
export type EnrollResult = z.infer<typeof EnrollResultSchema>

export const WatcherTerminalSummarySchema = z
  .object({
    watcherId: IdSchema,
    kind: WatcherKindIdSchema,
    terminalState: IdSchema,
    reason: IdSchema,
    totals: z.record(z.string(), z.unknown()),
    atMs: TimestampSchema
  })
  .strict()
export type WatcherTerminalSummary = z.infer<typeof WatcherTerminalSummarySchema>
