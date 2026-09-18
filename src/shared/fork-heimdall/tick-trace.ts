import { z } from 'zod'
import { BudgetStateSchema } from './budget'
import { GateVerdictSchema } from './gate'
import { KernelActionSchema } from './ledger-types'
import { PacingDecisionSchema } from './pacing'

export const TICK_TRACE_RING_CAPACITY = 50
export const TICK_TRACE_FULL_DETAIL_COUNT = 20

export const TickExitPathSchema = z.enum([
  'not-current',
  'suspended',
  'budget-exhausted',
  'lifecycle-terminal',
  'acted',
  'gate-held',
  'gate-escalated',
  'watching',
  'error',
  'lease-refused',
  'lease-unverifiable'
])
export type TickExitPath = z.infer<typeof TickExitPathSchema>

export const ConsideredPhaseSchema = z
  .object({
    phase: z.string().min(1),
    reason: z.string().min(1),
    detail: z.string().optional()
  })
  .strict()
export type ConsideredPhase = z.infer<typeof ConsideredPhaseSchema>

const TraceDecisionSchema = z.union([
  z.object({ action: KernelActionSchema }).strict(),
  z
    .object({
      action: z.null(),
      reason: z.string().min(1),
      detail: z.string().optional(),
      considered: z.array(ConsideredPhaseSchema)
    })
    .strict()
])

export const TraceSnapshotSummarySchema = z.record(z.string(), z.unknown())
export type TraceSnapshotSummary = z.infer<typeof TraceSnapshotSummarySchema>

export const TickRunnerStateSchema = z
  .object({
    consecutiveErrors: z.number().int().nonnegative(),
    lastFullResyncAtMs: z.number().int().nonnegative().nullable(),
    reconcileAgain: z.boolean()
  })
  .strict()
export type TickRunnerState = z.infer<typeof TickRunnerStateSchema>

export const WatcherTickTraceSchema = z
  .object({
    seq: z.number().int().positive(),
    startedAtMs: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative().nullable(),
    exitPath: TickExitPathSchema.nullable(),
    pinned: z.boolean(),
    fullResyncDue: z.boolean(),
    snapshotReadCount: z.number().int().nonnegative(),
    snapshot: TraceSnapshotSummarySchema.nullable(),
    contentIdentity: z.string().min(1).nullable(),
    leaseEpoch: z.number().int().nonnegative().nullable(),
    decision: TraceDecisionSchema.nullable(),
    declined: z.array(ConsideredPhaseSchema),
    gate: GateVerdictSchema.nullable(),
    budget: BudgetStateSchema,
    pacing: PacingDecisionSchema.nullable(),
    error: z.object({ message: z.string(), stack: z.string().optional() }).strict().nullable(),
    runner: TickRunnerStateSchema
  })
  .strict()
export type WatcherTickTrace = z.infer<typeof WatcherTickTraceSchema>

export function createTickTrace(
  seq: number,
  startedAtMs: number,
  runner: TickRunnerState
): WatcherTickTrace {
  return {
    seq,
    startedAtMs,
    durationMs: null,
    exitPath: null,
    pinned: false,
    fullResyncDue: false,
    snapshotReadCount: 0,
    snapshot: null,
    contentIdentity: null,
    leaseEpoch: null,
    decision: null,
    declined: [],
    gate: null,
    budget: { activeMs: 0, turns: 0, exhausted: null },
    pacing: null,
    error: null,
    runner
  }
}

/** Adds a visible in-flight trace and reclaims only unpinned old rows. */
export function pushTickTrace(
  ring: WatcherTickTrace[],
  trace: WatcherTickTrace,
  capacity: number = TICK_TRACE_RING_CAPACITY
): void {
  ring.push(trace)
  while (ring.length > capacity) {
    const reclaimIndex = ring.findIndex((entry) => !entry.pinned)
    if (reclaimIndex === -1) {
      return
    }
    ring.splice(reclaimIndex, 1)
  }
}

export function countChecksByState(
  checks: readonly { required: boolean; state: string }[]
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const check of checks) {
    const key = check.required ? `required:${check.state}` : `optional:${check.state}`
    counts[key] = (counts[key] ?? 0) + 1
  }
  return counts
}
