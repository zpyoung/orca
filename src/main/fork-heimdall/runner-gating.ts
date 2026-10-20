import { gateAction, type GateVerdict } from '../../shared/fork-heimdall/gate'
import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import { deriveBudgetState } from '../../shared/fork-heimdall/budget'
import { getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { requireLiveSnapshot, type Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import { judgmentApprovalAdvisory } from '../../shared/fork-heimdall/judgment/objective-judgment-policy'
import { ObjectiveWorldSchema } from '../../shared/fork-heimdall-objective/detail-types'
import { ObjectiveActionSchema } from '../../shared/fork-heimdall-objective/objective-actions'
import { recordDeviation } from './owner/deviation-ledger'
import type { WatcherRunnerActions } from './runner-actions'
import type { WatcherRunner, WatcherRunnerDependencies } from './runner-state'

type WatchingEvaluation = {
  outcome: 'watching'
  snapshot: Snapshot<unknown>
  ledger: WatcherLedger
  immediate: boolean
  successful: boolean
}

type GatedEvaluation = {
  outcome: 'gated'
  snapshot: Snapshot<unknown>
  action: KernelAction
  gate: Exclude<GateVerdict, { verdict: 'allow' }>
  advisory?: string
}

type AllowedEvaluation = {
  outcome: 'allowed'
  snapshot: Snapshot<unknown>
  action: KernelAction
  recoveredAttempt?: AttemptEntry
}

export type RunnerGateEvaluation = WatchingEvaluation | GatedEvaluation | AllowedEvaluation
export function gateRunnerAction(
  runner: WatcherRunner,
  action: KernelAction,
  snapshot: Snapshot<unknown>,
  ledger: WatcherLedger,
  ignoredAttemptId?: string
): GateVerdict {
  const baseLedger = ignoredAttemptId
    ? {
        ...ledger,
        entries: ledger.entries.filter(
          (entry) => entry.kind !== 'attempt' || entry.attemptId !== ignoredAttemptId
        )
      }
    : ledger
  const concurrency = runner.kind.concurrency
  const activeActions = getInFlightAttempts(baseLedger).map((attempt) => attempt.action)
  const concurrent = concurrency?.canRunAlongside(action, activeActions, snapshot, ledger) ?? false
  const fingerprint = makeAttemptFingerprint(
    action.contentIdentity,
    action.kind,
    action.evidenceKey
  )
  const gateLedger = concurrent
    ? {
        ...baseLedger,
        entries: baseLedger.entries.filter(
          (entry) => entry.kind !== 'attempt' || entry.fingerprint === fingerprint
        )
      }
    : baseLedger
  const budgetExhausted = deriveBudgetState(ledger, runner.enrollment.budget).exhausted !== null
  const enrollment =
    budgetExhausted && concurrency?.canRunWhenBudgetExhausted(action, snapshot, ledger)
      ? {
          ...runner.enrollment,
          budget: { wallClockActiveMs: null, turns: null }
        }
      : runner.enrollment
  return gateAction(action, snapshot, enrollment, gateLedger)
}

function approvalAdvisory(
  runner: WatcherRunner,
  snapshot: Snapshot<unknown>,
  action: KernelAction
): string | null {
  const kindAdvisory = runner.kind.describeApproval?.(snapshot, action)
  if (kindAdvisory !== undefined && kindAdvisory !== null) {
    return kindAdvisory.slice(0, 4_096)
  }
  const world = ObjectiveWorldSchema.safeParse(snapshot.world)
  const objectiveAction = ObjectiveActionSchema.safeParse(action)
  return world.success && objectiveAction.success
    ? judgmentApprovalAdvisory(world.data, objectiveAction.data)
    : null
}

export class WatcherRunnerGateLifecycle {
  constructor(
    private readonly dependencies: Pick<WatcherRunnerDependencies, 'ledgerStore'>,
    private readonly actions: WatcherRunnerActions,
    private readonly now: () => number,
    private readonly createId: () => string
  ) {}

  async evaluate(
    runner: WatcherRunner,
    initialSnapshot: Snapshot<unknown>,
    initialLedger: WatcherLedger,
    absentDispatches: readonly AttemptEntry[],
    trace: WatcherTickTrace
  ): Promise<RunnerGateEvaluation> {
    let snapshot = initialSnapshot
    let ledger = initialLedger
    let decision = runner.kind.decide(snapshot, ledger)
    trace.decision = decision
    trace.declined = 'considered' in decision ? decision.considered : []
    if (!decision.action) {
      // recording a deviation reschedules immediately so the owner wakes on its own cadence,
      // not whatever idle-pacing tier the kind would otherwise pick for plain watching
      let deviationRecorded = false
      if ('deviation' in decision && runner.enrollment.owner) {
        recordDeviation(
          { ledgerStore: this.dependencies.ledgerStore, now: this.now, createId: this.createId },
          runner.enrollment.watcherId,
          decision.deviation
        )
        deviationRecorded = true
      }
      this.actions.settleAbsentDispatches(runner, absentDispatches)
      ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      return {
        outcome: 'watching',
        snapshot,
        ledger,
        immediate: deviationRecorded,
        successful: true
      }
    }

    let action = decision.action
    const fingerprint = makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    )
    const recoveredAttempt = absentDispatches.find((attempt) => attempt.fingerprint === fingerprint)
    if (!recoveredAttempt && absentDispatches.length > 0) {
      this.actions.settleAbsentDispatches(runner, absentDispatches)
      ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    }
    let gate = gateRunnerAction(runner, action, snapshot, ledger, recoveredAttempt?.attemptId)
    if (gate.verdict === 'allow' && runner.kind.preflight) {
      gate = await runner.kind.preflight(action, snapshot, ledger, {
        enrollment: runner.enrollment
      })
    }

    if (
      action.visibility === 'external' &&
      snapshot.freshness === 'cached' &&
      gate.verdict === 'allow'
    ) {
      const cachedFingerprint = makeAttemptFingerprint(
        action.contentIdentity,
        action.kind,
        action.evidenceKey
      )
      snapshot = await runner.kind.read(runner.enrollment, { fresh: true })
      await this.assertLeaseHeld(runner)
      trace.snapshotReadCount += 1
      const live = requireLiveSnapshot(snapshot)
      decision = runner.kind.decide(live, ledger)
      trace.decision = decision
      if (!decision.action) {
        if (recoveredAttempt) {
          this.actions.settleAbsentDispatches(runner, [recoveredAttempt])
        }
        this.actions.abandonFingerprint(runner, cachedFingerprint, 'workspace-moved')
        return { outcome: 'watching', snapshot: live, ledger, immediate: false, successful: false }
      }
      action = decision.action
      const liveFingerprint = makeAttemptFingerprint(
        action.contentIdentity,
        action.kind,
        action.evidenceKey
      )
      if (liveFingerprint !== cachedFingerprint) {
        if (recoveredAttempt) {
          this.actions.settleAbsentDispatches(runner, [recoveredAttempt])
        }
        this.actions.abandonFingerprint(runner, cachedFingerprint, 'workspace-moved')
        return { outcome: 'watching', snapshot: live, ledger, immediate: true, successful: false }
      }
      gate = gateRunnerAction(runner, action, live, ledger, recoveredAttempt?.attemptId)
      if (gate.verdict === 'allow' && runner.kind.preflight) {
        gate = await runner.kind.preflight(action, live, ledger, {
          enrollment: runner.enrollment
        })
      }
    }

    if (gate.verdict === 'allow') {
      gate = this.commitGate(runner, action, snapshot, recoveredAttempt?.attemptId)
      if (gate.verdict === 'allow') {
        await this.assertLeaseHeld(runner)
        gate = this.commitGate(runner, action, snapshot, recoveredAttempt?.attemptId)
      }
    }
    if (gate.verdict !== 'allow') {
      await this.assertLeaseHeld(runner)
    }
    trace.gate = gate
    if (gate.verdict !== 'allow') {
      const advisory =
        gate.verdict === 'hold' && gate.reason === 'awaiting-approval'
          ? approvalAdvisory(runner, snapshot, action)
          : null
      return {
        outcome: 'gated',
        snapshot,
        action,
        gate,
        ...(advisory ? { advisory } : {})
      }
    }
    return {
      outcome: 'allowed',
      snapshot,
      action,
      ...(recoveredAttempt ? { recoveredAttempt } : {})
    }
  }

  private commitGate(
    runner: WatcherRunner,
    action: KernelAction,
    snapshot: Snapshot<unknown>,
    ignoredAttemptId?: string
  ): GateVerdict {
    if (runner.stopped) {
      return { verdict: 'hold', reason: 'stopped' }
    }
    if (runner.suspended) {
      return { verdict: 'hold', reason: 'suspended' }
    }
    if (runner.controlPending !== null) {
      return { verdict: 'hold', reason: `${runner.controlPending}-requested` }
    }
    if (!runner.enrollment.enabled) {
      return { verdict: 'hold', reason: 'disabled' }
    }
    if (runner.enrollment.paused) {
      return { verdict: 'hold', reason: 'paused' }
    }
    const ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    return gateRunnerAction(runner, action, snapshot, ledger, ignoredAttemptId)
  }

  private async assertLeaseHeld(runner: WatcherRunner): Promise<void> {
    if (!runner.leaseGuard) {
      throw new Error('Watcher gate reached a durable outcome without a lease')
    }
    await runner.leaseGuard.assertHeld()
  }
}
