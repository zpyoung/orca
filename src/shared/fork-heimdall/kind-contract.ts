import type { z } from 'zod'
import type { ActionOutcome, EffectCertainty } from './effect-certainty'
import type { GateVerdict } from './gate'
import type {
  AttemptEntry,
  KernelAction as LedgerKernelAction,
  WatcherLedger
} from './ledger-types'
import type { PacingTier } from './pacing'
import type { LiveSnapshot, Snapshot } from './snapshot'
import type { StopDisposition, StopPredicate, StopVerdict } from './stop-policy'
import type { ConsideredPhase, TraceSnapshotSummary } from './tick-trace'
import type {
  AuthorizedEnrollment,
  EnrollInput,
  WatcherEnrollment,
  WatcherKindId as EnrollmentKindId
} from './watcher-types'

export type WatcherKindId = EnrollmentKindId
export type KernelAction = LedgerKernelAction
export { KernelActionSchema } from './ledger-types'
export { WatcherKindIdSchema } from './watcher-types'

export type { ConsideredPhase, TraceSnapshotSummary }

export type DecisionOutcome<TAction extends KernelAction> =
  | { action: TAction }
  | { action: null; reason: string; detail?: string; considered: ConsideredPhase[] }

export type LeaseRenewal = {
  dispose(): void
}

export type LeaseGuard = {
  readonly epoch: number
  assertHeld(): Promise<void>
  renewLoop(): LeaseRenewal
}

export type DispatchWorkerRequest = {
  spec: string
  agent?: string
  taskKey?: string
  deps?: readonly string[]
}

export type DispatchWorkerInput = DispatchWorkerRequest & {
  enrollment: WatcherEnrollment
  attemptFingerprint: string
}

export type DispatchResult =
  | { status: 'dispatched'; dispatchId: string }
  | {
      status: 'refused'
      reason: 'fenced' | 'capability-invalid' | 'placement-unavailable'
      detail: string
    }
  | { status: 'indeterminate'; requestId: string }

export type ExecuteContext<TWorld> = {
  snapshot: Snapshot<TWorld>
  lease: LeaseGuard
  ledger: WatcherLedger
  dispatchWorker(request: DispatchWorkerRequest): Promise<DispatchResult>
}

export type PreflightContext = {
  enrollment: WatcherEnrollment
}

export type KindIdentity<TEnrollmentPayload = unknown> = {
  id: WatcherKindId
  displayName: string
  describeEnrollment(enrollment: WatcherEnrollment): string
  enrollmentPayloadSchema: z.ZodType<TEnrollmentPayload>
  /** Re-resolves every persisted authority field from the renderer's candidate selection. */
  authorizeEnrollment(input: EnrollInput): Promise<AuthorizedEnrollment>
}

export type SnapshotSource<TWorld> = {
  read(enrollment: WatcherEnrollment, options: { fresh: boolean }): Promise<Snapshot<TWorld>>
  describeSnapshot(snapshot: Snapshot<TWorld>): TraceSnapshotSummary
}

export type Decision<TWorld, TAction extends KernelAction> = {
  decide(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): DecisionOutcome<TAction>
  preflight?(
    action: TAction,
    snapshot: Snapshot<TWorld>,
    ledger: WatcherLedger,
    context: PreflightContext
  ): Promise<GateVerdict>
}

export type ActionExecutor<TWorld, TAction extends KernelAction> = {
  execute(action: TAction, context: ExecuteContext<TWorld>): Promise<ActionOutcome>
  resolveOutcome(
    attempt: AttemptEntry,
    fresh: LiveSnapshot<TWorld>,
    ledger: WatcherLedger
  ): EffectCertainty | Promise<EffectCertainty>
}

export type PacingPolicy<TWorld> = {
  pace(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): PacingTier
}

/** Phase 3 marker: its presence tells the kernel planning is supported. */
export type PlannerAdapter<TWorld> = {
  readonly world?: TWorld
}

export type WatcherKind<
  TWorld,
  TAction extends KernelAction,
  TEnrollmentPayload = unknown
> = KindIdentity<TEnrollmentPayload> &
  SnapshotSource<TWorld> &
  Decision<TWorld, TAction> &
  ActionExecutor<TWorld, TAction> & {
    stopPredicates?: readonly StopPredicate<TWorld>[]
    pacing?: PacingPolicy<TWorld>
    planner?: PlannerAdapter<TWorld>
  }

export type { StopDisposition, StopPredicate, StopVerdict }
