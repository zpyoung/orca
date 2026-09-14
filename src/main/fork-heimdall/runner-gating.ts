import { gateAction, type GateVerdict } from '../../shared/fork-heimdall/gate'
import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { requireLiveSnapshot, type Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
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
}

type AllowedEvaluation = {
  outcome: 'allowed'
  snapshot: Snapshot<unknown>
  action: KernelAction
  recoveredAttempt?: AttemptEntry
}

export type RunnerGateEvaluation = WatchingEvaluation | GatedEvaluation | AllowedEvaluation

export class WatcherRunnerGateLifecycle {
  constructor(
    private readonly dependencies: Pick<WatcherRunnerDependencies, 'ledgerStore'>,
    private readonly actions: WatcherRunnerActions
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
      this.actions.settleAbsentDispatches(runner, absentDispatches)
      ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
      return { outcome: 'watching', snapshot, ledger, immediate: false, successful: true }
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
    const gateLedger = this.withoutAttempt(ledger, recoveredAttempt?.attemptId)
    let gate = gateAction(action, snapshot, runner.enrollment, gateLedger)
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
      gate = gateAction(action, live, runner.enrollment, gateLedger)
      if (gate.verdict === 'allow' && runner.kind.preflight) {
        gate = await runner.kind.preflight(action, live, ledger, {
          enrollment: runner.enrollment
        })
      }
    }

    if (gate.verdict === 'allow') {
      gate = this.commitGate(runner, action, snapshot, recoveredAttempt?.attemptId)
      if (gate.verdict === 'allow') {
        const guard = runner.leaseGuard
        if (!guard) {
          gate = { verdict: 'hold', reason: 'lease-not-held' }
        } else {
          await guard.assertHeld()
          gate = this.commitGate(runner, action, snapshot, recoveredAttempt?.attemptId)
        }
      }
    }
    trace.gate = gate
    if (gate.verdict !== 'allow') {
      return { outcome: 'gated', snapshot, action, gate }
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
    const ledger = this.dependencies.ledgerStore.read(runner.enrollment.watcherId)
    return gateAction(
      action,
      snapshot,
      runner.enrollment,
      this.withoutAttempt(ledger, ignoredAttemptId)
    )
  }

  private withoutAttempt(ledger: WatcherLedger, attemptId?: string): WatcherLedger {
    if (!attemptId) {
      return ledger
    }
    return {
      ...ledger,
      entries: ledger.entries.filter(
        (entry) => entry.kind !== 'attempt' || entry.attemptId !== attemptId
      )
    }
  }
}
