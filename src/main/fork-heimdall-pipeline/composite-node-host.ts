import type {
  DecisionOutcome,
  DispatchResult,
  DispatchWorkerRequest,
  ExecuteContext,
  KernelAction,
  LeaseGuard,
  PreflightContext,
  SubmissionPreflightResult,
  WatcherKind
} from '../../shared/fork-heimdall/kind-contract'
import {
  createReportValidationProvenance,
  type ActionOutcome,
  type EffectCertaintyResolution,
  type ReportValidationCode
} from '../../shared/fork-heimdall/effect-certainty'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { PacingTier } from '../../shared/fork-heimdall/pacing'
import {
  evaluateStopPredicates,
  type FiredStopPredicate
} from '../../shared/fork-heimdall/stop-policy'
import type { LiveSnapshot, Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  objectiveCompositePhase,
  sitterCompositePhase
} from '../../shared/fork-heimdall-pipeline/composite-phase'
import {
  scopeLedgerForNode,
  unwrapCompositeAction,
  wrapCompositeAction
} from '../../shared/fork-heimdall-pipeline/interpreter/ledger-lens'
import {
  nodeIdFromInstanceId,
  pipelineNodeIdentity
} from '../../shared/fork-heimdall-pipeline/interpreter/node-instance'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { PipelineStore } from './pipeline-store'
import {
  captureProtectedDigest,
  compareProtectedDigest,
  parseProtectedDigest,
  PROTECTED_PIPELINE_OVER_CAP_PATH
} from './protected-pipeline-files'

export type CompositeProtectedFileComparison =
  | Readonly<{ status: 'clear' }>
  | Readonly<{ status: 'changed'; paths: readonly string[] }>
  | Readonly<{ status: 'unverifiable'; detail: string }>

/** Captures the protected-file baseline before a node-scoped composite dispatches its worker. */
export async function dispatchCompositeWorkerWithProtectedBaseline(args: {
  request: DispatchWorkerRequest
  action: KernelAction
  enrollment: WatcherEnrollment
  pipelineStore: PipelineStore
  dispatchWorker(request: DispatchWorkerRequest): Promise<DispatchResult>
}): Promise<DispatchResult> {
  try {
    const baseline = await captureProtectedDigest({
      executionHostId: args.enrollment.executionHostId,
      workspacePath: args.enrollment.workspacePath
    })
    args.pipelineStore.recordAttemptBaseline({
      watcherId: args.enrollment.watcherId,
      attemptFingerprint: makeAttemptFingerprint(
        args.action.contentIdentity,
        args.action.kind,
        args.action.evidenceKey
      ),
      workspacePath: args.enrollment.workspacePath,
      digest: baseline
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return {
      status: 'refused',
      reason: 'pre-dispatch-failure',
      detail: `Could not capture the composite protected-file baseline: ${detail}`
    }
  }
  return await args.dispatchWorker(args.request)
}

/** Compares an attempt's host-owned protected-file baseline with the current workspace. */
export async function compareCompositeAttemptProtectedFiles(
  attempt: AttemptEntry,
  enrollment: WatcherEnrollment,
  pipelineStore: PipelineStore
): Promise<CompositeProtectedFileComparison> {
  if (attempt.watcherId !== enrollment.watcherId) {
    return { status: 'unverifiable', detail: 'The composite attempt belongs to another watcher' }
  }
  const baseline = pipelineStore.attemptBaseline(enrollment.watcherId, attempt.fingerprint)
  if (!baseline || baseline.workspacePath !== enrollment.workspacePath) {
    return {
      status: 'unverifiable',
      detail: 'The composite worker has no matching protected-file baseline'
    }
  }
  const before = parseProtectedDigest(baseline.digest)
  if (!before) {
    return {
      status: 'unverifiable',
      detail: 'The composite worker protected-file baseline is invalid'
    }
  }
  try {
    const after = await captureProtectedDigest({
      executionHostId: enrollment.executionHostId,
      workspacePath: enrollment.workspacePath
    })
    const changed = compareProtectedDigest(before, after).changed
    return changed.length === 0 ? { status: 'clear' } : { status: 'changed', paths: changed }
  } catch (error) {
    return {
      status: 'unverifiable',
      detail: error instanceof Error ? error.message : String(error)
    }
  }
}

function protectedReportValidation(
  attempt: AttemptEntry,
  status: 'rejected' | 'unverifiable',
  code: ReportValidationCode,
  detail: string,
  hostVerifiable: boolean,
  observedFiles: readonly string[]
) {
  const identity = pipelineNodeIdentity(attempt.action)
  return createReportValidationProvenance({
    status,
    code,
    role: 'implementer',
    dispatchId: attempt.dispatchId ?? attempt.attemptId,
    ...(identity === null ? {} : { taskKey: identity.nodeId }),
    reportPath: null,
    detail,
    observedFiles,
    hostVerifiable
  })
}

/** Converts a protection comparison into the same strict pipeline report-resolution shape as Agent. */
export function compositeProtectedOutcome(
  attempt: AttemptEntry,
  comparison: CompositeProtectedFileComparison
): EffectCertaintyResolution | null {
  if (comparison.status === 'clear') {
    return null
  }
  if (comparison.status === 'unverifiable') {
    return {
      effect: 'indeterminate',
      reportValidation: protectedReportValidation(
        attempt,
        'unverifiable',
        'read-unverifiable',
        comparison.detail,
        false,
        []
      )
    }
  }
  const path = comparison.paths[0] ?? PROTECTED_PIPELINE_OVER_CAP_PATH
  return {
    effect: 'not-landed',
    failureClass: 'criteria',
    reportValidation: protectedReportValidation(
      attempt,
      'rejected',
      'evidence-mismatch',
      `protected-path-modified:${path}`,
      true,
      comparison.paths
    )
  }
}

/** Rejects a composite worker report unless its protected files are verifiably unchanged. */
export function compositeProtectedSubmissionResult(
  comparison: CompositeProtectedFileComparison
): SubmissionPreflightResult {
  if (comparison.status === 'clear') {
    return { status: 'accepted' }
  }
  const reason =
    comparison.status === 'changed'
      ? `protected-path-modified:${comparison.paths[0] ?? PROTECTED_PIPELINE_OVER_CAP_PATH}`
      : comparison.detail
  return { status: 'rejected', code: 'protected-pipeline-files', reason }
}
export type CompositeMode =
  | { kind: 'identity' }
  | { kind: 'node-scoped'; instanceId: string; epoch: number }

export type CompositeNodeHost<
  TWorld,
  TAction extends KernelAction,
  TEnrollmentPayload = unknown
> = WatcherKind<TWorld, TAction, TEnrollmentPayload> & {
  evaluateStops(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): FiredStopPredicate | null
  pace(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): PacingTier
  phase(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): string
}

export class CompositeScopeError extends Error {
  constructor(instanceId: string, epoch: number) {
    super(`Composite action is outside node scope ${instanceId}@${epoch}`)
    this.name = 'CompositeScopeError'
  }
}

export class CompositeNodeConfigurationError extends Error {
  readonly instanceId: string
  readonly epoch: number
  readonly detail: string

  constructor(instanceId: string, epoch: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Composite node ${instanceId}@${epoch} could not be read: ${detail}`)
    this.name = 'CompositeNodeConfigurationError'
    this.instanceId = instanceId
    this.epoch = epoch
    this.detail = detail
  }
}

function scopedLedger(ledger: WatcherLedger, instanceId: string, epoch: number): WatcherLedger {
  return scopeLedgerForNode(ledger, instanceId, epoch)
}

function requireInnerAction<TAction extends KernelAction>(
  action: KernelAction,
  instanceId: string,
  epoch: number,
  runContentIdentity: string
): TAction {
  const identity = pipelineNodeIdentity(action)
  if (
    identity === null ||
    identity.instanceId !== instanceId ||
    identity.nodeId !== nodeIdFromInstanceId(instanceId) ||
    identity.epoch !== epoch ||
    identity.inner === undefined ||
    action.contentIdentity !== runContentIdentity
  ) {
    throw new CompositeScopeError(instanceId, epoch)
  }
  const inner = unwrapCompositeAction(action)
  if (inner === null) {
    throw new CompositeScopeError(instanceId, epoch)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this host only emits wrapped actions from the inner kind's own decide result; matching node, epoch, run identity, and inner identity proves unwrap restores that action type.
  return inner as TAction
}

function requireInnerAttempt(
  attempt: AttemptEntry,
  innerLedger: WatcherLedger,
  instanceId: string,
  epoch: number,
  runContentIdentity: string
): AttemptEntry {
  const innerAction = requireInnerAction(attempt.action, instanceId, epoch, runContentIdentity)
  const innerAttempt = innerLedger.entries.find(
    (entry): entry is AttemptEntry =>
      entry.kind === 'attempt' && entry.attemptId === attempt.attemptId
  )
  if (
    innerAttempt === undefined ||
    innerAttempt.action.kind !== innerAction.kind ||
    innerAttempt.action.contentIdentity !== innerAction.contentIdentity ||
    innerAttempt.action.evidenceKey !== innerAction.evidenceKey
  ) {
    throw new CompositeScopeError(instanceId, epoch)
  }
  return innerAttempt
}

function scopedHost<TWorld, TAction extends KernelAction, TEnrollmentPayload>(
  inner: WatcherKind<TWorld, TAction, TEnrollmentPayload>,
  instanceId: string,
  epoch: number,
  runContentIdentity: string
): CompositeNodeHost<TWorld, TAction, TEnrollmentPayload> {
  if (inner.id !== 'hosted-review') {
    throw new Error('Node-scoped composites require the hosted-review kind')
  }
  if (runContentIdentity.length === 0) {
    throw new CompositeNodeConfigurationError(
      instanceId,
      epoch,
      'Node-scoped composites require the outer run content identity'
    )
  }
  if (!Number.isInteger(epoch) || epoch < 0 || instanceId.length === 0) {
    throw new Error('Node-scoped composites require a valid instance and epoch')
  }

  const host: CompositeNodeHost<TWorld, TAction, TEnrollmentPayload> = {
    ...inner,
    async read(enrollment: WatcherEnrollment, options: { fresh: boolean }) {
      try {
        return await inner.read(enrollment, options)
      } catch (cause) {
        throw new CompositeNodeConfigurationError(instanceId, epoch, cause)
      }
    },
    decide(snapshot: Snapshot<TWorld>, ledger: WatcherLedger): DecisionOutcome<TAction> {
      const outcome = inner.decide(snapshot, scopedLedger(ledger, instanceId, epoch))
      if (!('action' in outcome) || outcome.action === null) {
        return outcome
      }
      const action = wrapCompositeAction(instanceId, epoch, outcome.action, runContentIdentity)
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: wrapCompositeAction preserves the inner action fields and discriminant while adding only pipeline identity metadata.
      return { action: action as TAction }
    },
    ...(inner.preflight === undefined
      ? {}
      : {
          preflight(
            action: TAction,
            snapshot: Snapshot<TWorld>,
            ledger: WatcherLedger,
            context: PreflightContext
          ) {
            return inner.preflight!(
              requireInnerAction<TAction>(action, instanceId, epoch, runContentIdentity),
              snapshot,
              scopedLedger(ledger, instanceId, epoch),
              context
            )
          }
        }),
    ...(inner.attemptExpectation === undefined
      ? {}
      : {
          attemptExpectation(action: TAction, snapshot: Snapshot<TWorld>) {
            return inner.attemptExpectation!(
              requireInnerAction<TAction>(action, instanceId, epoch, runContentIdentity),
              snapshot
            )
          }
        }),
    async execute(action: TAction, context: ExecuteContext<TWorld>): Promise<ActionOutcome> {
      const innerAction = requireInnerAction<TAction>(action, instanceId, epoch, runContentIdentity)
      return inner.execute(innerAction, {
        ...context,
        ledger: scopedLedger(context.ledger, instanceId, epoch)
      })
    },
    resolveOutcome(
      attempt: AttemptEntry,
      fresh: LiveSnapshot<TWorld>,
      ledger: WatcherLedger,
      lease: LeaseGuard
    ): EffectCertaintyResolution | Promise<EffectCertaintyResolution> {
      const innerLedger = scopedLedger(ledger, instanceId, epoch)
      const innerAttempt = requireInnerAttempt(
        attempt,
        innerLedger,
        instanceId,
        epoch,
        runContentIdentity
      )
      return inner.resolveOutcome(innerAttempt, fresh, innerLedger, lease)
    },
    evaluateStops(snapshot: Snapshot<TWorld>, ledger: WatcherLedger) {
      return evaluateStopPredicates(
        inner.stopPredicates ?? [],
        snapshot,
        scopedLedger(ledger, instanceId, epoch)
      )
    },
    pace(snapshot: Snapshot<TWorld>, ledger: WatcherLedger) {
      return inner.pacing?.pace(snapshot, scopedLedger(ledger, instanceId, epoch)) ?? 'idle'
    },
    phase(_snapshot: Snapshot<TWorld>, ledger: WatcherLedger) {
      try {
        return sitterCompositePhase(scopedLedger(ledger, instanceId, epoch))
      } catch {
        return 'unknown'
      }
    }
  }
  return host
}

function identityHost<TWorld, TAction extends KernelAction, TEnrollmentPayload>(
  inner: WatcherKind<TWorld, TAction, TEnrollmentPayload>
): CompositeNodeHost<TWorld, TAction, TEnrollmentPayload> {
  return {
    ...inner,
    evaluateStops(snapshot, ledger) {
      return evaluateStopPredicates(inner.stopPredicates ?? [], snapshot, ledger)
    },
    pace(snapshot, ledger) {
      return inner.pacing?.pace(snapshot, ledger) ?? 'idle'
    },
    phase(snapshot, ledger) {
      try {
        if (inner.id === 'hosted-review') {
          return sitterCompositePhase(ledger)
        }
        if (inner.id === 'objective') {
          const summary = inner.describeSnapshot(snapshot)
          const phase = typeof summary.phase === 'string' ? summary.phase : null
          return objectiveCompositePhase(null, phase)
        }
      } catch {
        return 'unknown'
      }
      return 'unknown'
    }
  }
}

/**
 * Creates a pass-through identity host or a node-scoped hosted-review host. Node-scoped hosts require
 * the outer pipeline run identity so their action fingerprints remain stable across inner reads.
 */
export function createCompositeNodeHost<TWorld, TAction extends KernelAction, TEnrollmentPayload>(
  inner: WatcherKind<TWorld, TAction, TEnrollmentPayload>,
  mode: { kind: 'identity' }
): CompositeNodeHost<TWorld, TAction, TEnrollmentPayload>
export function createCompositeNodeHost<TWorld, TAction extends KernelAction, TEnrollmentPayload>(
  inner: WatcherKind<TWorld, TAction, TEnrollmentPayload>,
  mode: { kind: 'node-scoped'; instanceId: string; epoch: number },
  runContentIdentity: string
): CompositeNodeHost<TWorld, TAction, TEnrollmentPayload>
export function createCompositeNodeHost<TWorld, TAction extends KernelAction, TEnrollmentPayload>(
  inner: WatcherKind<TWorld, TAction, TEnrollmentPayload>,
  mode: CompositeMode,
  runContentIdentity?: string
): CompositeNodeHost<TWorld, TAction, TEnrollmentPayload> {
  if (mode.kind === 'identity') {
    return identityHost(inner)
  }
  if (runContentIdentity === undefined) {
    throw new CompositeNodeConfigurationError(
      mode.instanceId,
      mode.epoch,
      'Node-scoped composites require the outer run content identity'
    )
  }
  return scopedHost(inner, mode.instanceId, mode.epoch, runContentIdentity)
}
