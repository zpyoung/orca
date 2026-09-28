import type { z } from 'zod'
import type { ExecutionHostId } from '../execution-host'
import type { WatcherCommandResult } from './fleet-types'
import type { ActionOutcome, EffectCertaintyResolution } from './effect-certainty'
import type { GateVerdict } from './gate'
import type {
  AttemptEntry,
  KernelAction as LedgerKernelAction,
  WatcherLedger
} from './ledger-types'
import type { PacingTier } from './pacing'
import type { LiveSnapshot, Snapshot } from './snapshot'
import type { FiredStopPredicate, StopDisposition, StopPredicate, StopVerdict } from './stop-policy'
import type { ConsideredPhase, TraceSnapshotSummary } from './tick-trace'
import type { Deviation } from './owner/deviation'
import type { Intervention } from './owner/intervention'
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
  | { action: null; deviation: Deviation }

export type LeaseRenewal = {
  dispose(): void
}

export type LeaseGuard = {
  readonly epoch: number
  readonly holder: string
  assertHeld(): Promise<void>
  renewLoop(): LeaseRenewal
}

export type DispatchWorkerRequest = {
  spec: string
  agent?: string
  model?: string
  effort?: string
  taskKey?: string
  deps?: readonly string[]
  /** Authoritative workspace for this dispatch; omitted to use the enrolled workspace. */
  workspaceId?: string
  /** Existing worker terminal to continue in; omitted to create a fresh worker session. */
  reuseTerminal?: string
}

export type DispatchWorkerInput = DispatchWorkerRequest & {
  enrollment: WatcherEnrollment
  attemptFingerprint: string
}

export type DispatchResult =
  | { status: 'dispatched'; dispatchId: string; terminalHandle?: string }
  | {
      status: 'refused'
      reason: 'fenced' | 'capability-invalid' | 'placement-unavailable' | 'pre-dispatch-failure'
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

export type WorkerReportSubmission = Readonly<{
  dispatchId: string
  payload: Readonly<Record<string, unknown>>
}>

export type SubmissionPreflightResult =
  | { status: 'accepted' }
  | { status: 'rejected'; code: string; reason: string }

export type SubmissionAdapter<TWorld> = {
  preflightWorkerReport(
    submission: WorkerReportSubmission,
    context: {
      enrollment: WatcherEnrollment
      snapshot: Snapshot<TWorld> | null
      ledger: WatcherLedger
    }
  ): Promise<SubmissionPreflightResult>
}

export type KindIdentity<TEnrollmentPayload = unknown> = {
  id: WatcherKindId
  displayName: string
  describeEnrollment(enrollment: WatcherEnrollment): string
  enrollmentPayloadSchema: z.ZodType<TEnrollmentPayload>
  /**
   * Validates renderer candidate data before authorization; persistence uses
   * `enrollmentPayloadSchema`.
   */
  enrollmentInputSchema?: z.ZodType
  /** Re-resolves every persisted authority field from the renderer's candidate selection. */
  authorizeEnrollment(input: EnrollInput): Promise<AuthorizedEnrollment>
  /**
   * Validates kind-owned progress invariants after authoritative workspace lookup.
   * `existing` is null only for first enrollment.
   */
  validateEnrollment?(candidate: AuthorizedEnrollment, existing: WatcherEnrollment | null): void
  /** Permanently removes persistence owned by this watcher kind. */
  purge?(watcherId: string): void | Promise<void>
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
  /** Pure metadata persisted before execute can cross an external-effect boundary. */
  attemptExpectation?(
    action: TAction,
    snapshot: Snapshot<TWorld>
  ): { expectedBefore: string; expectedAfter: string } | undefined
  execute(action: TAction, context: ExecuteContext<TWorld>): Promise<ActionOutcome>
  resolveOutcome(
    attempt: AttemptEntry,
    fresh: LiveSnapshot<TWorld>,
    ledger: WatcherLedger,
    lease: LeaseGuard
  ): EffectCertaintyResolution | Promise<EffectCertaintyResolution>
}

export type PacingPolicy<TWorld> = {
  pace(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): PacingTier
}

/** Phase 3 marker: its presence tells the kernel planning is supported. */
export type KindConcurrencyPolicy<TWorld, TAction extends KernelAction> = {
  canRunAlongside(
    action: TAction,
    activeActions: readonly KernelAction[],
    snapshot: Snapshot<TWorld>,
    ledger: WatcherLedger
  ): boolean
  shouldDrainBudget(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): boolean
  preserveAttemptOnContentChange(
    attempt: AttemptEntry,
    snapshot: Snapshot<TWorld>,
    ledger: WatcherLedger
  ): boolean
  canRunWhenBudgetExhausted(
    action: TAction,
    snapshot: Snapshot<TWorld>,
    ledger: WatcherLedger
  ): boolean
  isIsolatedAttempt(attempt: AttemptEntry, ledger: WatcherLedger): boolean
  retainWorker(attempt: AttemptEntry, ledger: WatcherLedger): boolean
  reconcile?(
    snapshot: Snapshot<TWorld>,
    ledger: WatcherLedger,
    context: {
      enrollment: WatcherEnrollment
      lease: LeaseGuard
      stopWorker(dispatchId: string): Promise<WatcherCommandResult>
      workerReleaseConfirmed(dispatchId: string): boolean
    }
  ): Promise<void>
}

export type PlannerAdapter<TWorld> = {
  readonly world?: TWorld
}

export type HandoffDerivation =
  | { kind: 'enroll'; input: EnrollInput; reason: string }
  | { kind: 'none'; reason: string }

export type HandoffAdapter<_TWorld> = {
  derive(
    enrollment: WatcherEnrollment,
    fired: FiredStopPredicate,
    ledger: WatcherLedger
  ): HandoffDerivation | Promise<HandoffDerivation>
}

export type DebugPointer = {
  role: 'kernel-database' | 'kind-database' | 'workspace' | 'lease-holder'
  host: 'kernel' | ExecutionHostId
  path: string
  status: 'resolved' | 'unresolved'
  detail?: string
}

export type KindDebugAdapter = {
  pointers?(enrollment: WatcherEnrollment): readonly DebugPointer[]
}

/** Text a kind renders for its owning agent; the kernel treats it as opaque, pre-bounded content. */
export type OwnerStateBrief = {
  text: string
  truncated: boolean
}

/** Mandatory turn context a kind uses to keep the evidence that caused the owner wake. */
export type OwnerStateBriefContext = {
  deviation: Deviation
}

/** Why gate 1 (write territory), 2 (landing bar) or 4 (`sitterOverrides`) rejected an intervention. */
export type OwnerInterventionRejection = {
  gate: 'write-territory' | 'landing-bar' | 'sitter-overrides'
  reason: string
}

/**
 * The kind-owned half of owner support. Gates 3 (budget) and 5 (capability mode) are generic and
 * stay kernel-side; these members supply the kind-specific data gates 1, 2 and 4 need, plus the
 * text and action wrapping that only the kind can produce.
 */
export type OwnerAdapter<TWorld, TAction extends KernelAction> = {
  /**
   * Renders the plan/contract/node state a deviation-woken owner needs, bounded to `maxBytes`.
   * `context` identifies evidence that must survive the kind's safe-history omission policy.
   */
  describeState(
    snapshot: Snapshot<TWorld>,
    ledger: WatcherLedger,
    maxBytes: number,
    context?: OwnerStateBriefContext
  ): OwnerStateBrief
  /** The kind-specific intervention vocabulary, appended to the five kind-agnostic moves. */
  describeInterventions(): string
  /**
   * Validates the full vocabulary this kind's owner may answer with: the five kind-agnostic moves
   * plus whatever the kind adds, typically `KindAgnosticInterventionSchema` extended with the kind's
   * own discriminated union members.
   */
  interventionSchema: z.ZodType<Intervention>
  /** Null allows; a kind-specific intervention violating gate 1, 2 or 4 returns why. */
  rejectIntervention(
    intervention: Intervention,
    snapshot: Snapshot<TWorld>,
    ledger: WatcherLedger,
    enrollment: WatcherEnrollment
  ): OwnerInterventionRejection | null
  /**
   * Wraps a validated kind-specific intervention as the write-ahead action `execute` applies.
   * Takes the ledger because some interventions (e.g. one that dereferences an earlier attempt's
   * result) cannot be resolved from `snapshot.world` alone; optional only so an adapter that never
   * needs it can omit the parameter entirely.
   */
  actionForIntervention(
    intervention: Intervention,
    snapshot: Snapshot<TWorld>,
    ledger?: WatcherLedger
  ): TAction
}

export type WatcherKind<
  TWorld,
  TAction extends KernelAction,
  TEnrollmentPayload = unknown
> = KindIdentity<TEnrollmentPayload> &
  SnapshotSource<TWorld> &
  Decision<TWorld, TAction> &
  ActionExecutor<TWorld, TAction> & {
    concurrency?: KindConcurrencyPolicy<TWorld, TAction>
    stopPredicates?: readonly StopPredicate<TWorld>[]
    pacing?: PacingPolicy<TWorld>
    planner?: PlannerAdapter<TWorld>
    handoff?: HandoffAdapter<TWorld>
    debug?: KindDebugAdapter
    owner?: OwnerAdapter<TWorld, TAction>
    submission?: SubmissionAdapter<TWorld>
  }

export type { StopDisposition, StopPredicate, StopVerdict }
