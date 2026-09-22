import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import {
  getInFlightAttempts,
  hasPendingAttemptOutcome
} from '../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import { HEIMDALL_RAPID_POLL_MS } from '../../shared/fork-heimdall/pacing'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { WatcherRunnerActions } from './runner-actions'
import type { WatcherRunnerGateLifecycle } from './runner-gating'
import type { WatcherRunnerStatusLifecycle } from './runner-status'
import type { WatcherRunnerStopLifecycle } from './runner-stop-lifecycle'
import type { WatcherRunner, WatcherRunnerDependencies } from './runner-state'

const MAX_ACTIONS_PER_TICK = 32

type ActionLoopDependencies = {
  runner: WatcherRunner
  snapshot: Snapshot<unknown>
  ledger: WatcherLedger
  recoverableDispatches: readonly AttemptEntry[]
  trace: WatcherTickTrace
  gating: WatcherRunnerGateLifecycle
  actions: Pick<WatcherRunnerActions, 'execute' | 'recordGateRejection'>
  statusLifecycle: Pick<WatcherRunnerStatusLifecycle, 'gate' | 'markSuccessful'>
  stopLifecycle: Pick<WatcherRunnerStopLifecycle, 'evaluate'>
  ledgerStore: WatcherRunnerDependencies['ledgerStore']
  schedule(runner: WatcherRunner, delayMs: number): void
  publishStatus(runner: WatcherRunner): void
  scheduleFromPacing(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    ledger: WatcherLedger,
    trace: WatcherTickTrace
  ): void
}

/** Runs a bounded sequence of independent actions while retaining serial lease ownership. */
export async function runActionLoop(args: ActionLoopDependencies): Promise<void> {
  let actionsThisTick = 0
  let snapshot = args.snapshot
  let ledger = args.ledger
  let recoverableDispatches = args.recoverableDispatches
  while (actionsThisTick < MAX_ACTIONS_PER_TICK) {
    const gateEvaluation = await args.gating.evaluate(
      args.runner,
      snapshot,
      ledger,
      recoverableDispatches,
      args.trace
    )
    recoverableDispatches = []
    snapshot = gateEvaluation.snapshot
    if (gateEvaluation.outcome === 'watching') {
      args.trace.exitPath = actionsThisTick > 0 ? 'acted' : 'watching'
      if (gateEvaluation.immediate) {
        args.schedule(args.runner, 0)
      } else {
        args.scheduleFromPacing(args.runner, snapshot, gateEvaluation.ledger, args.trace)
      }
      if (gateEvaluation.successful) {
        args.statusLifecycle.markSuccessful(
          args.runner,
          actionsThisTick > 0 ? 'acting' : 'watching'
        )
      }
      return
    }
    if (gateEvaluation.outcome === 'gated') {
      args.actions.recordGateRejection(
        args.runner,
        gateEvaluation.action,
        gateEvaluation.gate,
        gateEvaluation.advisory
      )
      args.trace.exitPath =
        gateEvaluation.gate.verdict === 'escalate' ? 'gate-escalated' : 'gate-held'
      args.statusLifecycle.gate(
        args.runner,
        gateEvaluation.gate.verdict === 'escalate',
        gateEvaluation.gate.reason
      )
      args.runner.consecutiveGateHolds += 1
      args.scheduleFromPacing(
        args.runner,
        snapshot,
        args.ledgerStore.read(args.runner.enrollment.watcherId),
        args.trace
      )
      return
    }

    const executed = await args.actions.execute(
      args.runner,
      snapshot,
      gateEvaluation.action,
      gateEvaluation.recoveredAttempt
    )
    if (!executed) {
      args.trace.exitPath = 'gate-held'
      return
    }
    actionsThisTick += 1
    args.trace.exitPath = 'acted'
    ledger = args.ledgerStore.read(args.runner.enrollment.watcherId)
    if (args.runner.enrollment.paused) {
      args.runner.status = {
        ...args.runner.status,
        enabled: true,
        state: 'held',
        phase: 'paused',
        reason: 'paused',
        nextPulseAtMs: null
      }
      args.publishStatus(args.runner)
      if (hasPendingAttemptOutcome(ledger)) {
        args.schedule(args.runner, HEIMDALL_RAPID_POLL_MS)
      }
      return
    }
    if (!args.runner.enrollment.enabled) {
      args.runner.status = {
        ...args.runner.status,
        enabled: false,
        state: 'disabled',
        phase: 'disarmed',
        reason: null,
        parkReason: null,
        nextPulseAtMs: null
      }
      args.publishStatus(args.runner)
      if (hasPendingAttemptOutcome(ledger)) {
        args.schedule(args.runner, HEIMDALL_RAPID_POLL_MS)
      }
      return
    }
    args.statusLifecycle.markSuccessful(args.runner, 'acting')
    const afterStop = await args.stopLifecycle.evaluate(args.runner, snapshot, ledger)
    if (afterStop !== 'clear') {
      if (afterStop === 'deferred') {
        args.schedule(args.runner, HEIMDALL_RAPID_POLL_MS)
      }
      return
    }
    if (!args.runner.kind.concurrency) {
      args.schedule(args.runner, 0)
      return
    }
    const fingerprint = makeAttemptFingerprint(
      gateEvaluation.action.contentIdentity,
      gateEvaluation.action.kind,
      gateEvaluation.action.evidenceKey
    )
    const actionStillRunning = getInFlightAttempts(ledger).some(
      (attempt) => attempt.fingerprint === fingerprint && attempt.state === 'running'
    )
    if (!actionStillRunning) {
      args.schedule(args.runner, 0)
      return
    }
  }
  args.schedule(args.runner, 0)
}
