import { hasPendingAttemptOutcome } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { evaluateStopPredicates } from '../../shared/fork-heimdall/stop-policy'
import { OBJECTIVE_WORKER_ESCALATION_PREDICATE_ID } from '../../shared/fork-heimdall-objective/stop-policy'
import { recordDeviation, type DeviationRecordDependencies } from './owner/deviation-ledger'
import { WatcherDeletePendingError } from './runner-control-lifecycle'
import type { WatcherRunner } from './runner-state'
import type { WatcherRunnerStatusLifecycle } from './runner-status'

export type StopLifecycleOutcome = 'clear' | 'deferred' | 'quiesced' | 'parked' | 'terminal'

/** Applies kind stop declarations only while the runner still owns its execution lease. */
export class WatcherRunnerStopLifecycle {
  constructor(
    private readonly status: WatcherRunnerStatusLifecycle,
    private readonly ledgerRecord?: DeviationRecordDependencies
  ) {}

  async evaluate(
    runner: WatcherRunner,
    snapshot: Snapshot<unknown>,
    ledger: WatcherLedger
  ): Promise<StopLifecycleOutcome> {
    const fired = evaluateStopPredicates(runner.kind.stopPredicates ?? [], snapshot, ledger)
    if (!fired) {
      return 'clear'
    }
    if (fired.disposition === 'terminal') {
      if (hasPendingAttemptOutcome(ledger)) {
        return 'deferred'
      }
      await this.assertLeaseHeld(runner)
      if (this.deletePending(runner)) {
        return 'quiesced'
      }
      runner.kind.persistTerminalProjection?.(snapshot, ledger)
      try {
        await this.status.terminal(runner, fired)
      } catch (error) {
        if (error instanceof WatcherDeletePendingError) {
          return 'quiesced'
        }
        throw error
      }
      return 'terminal'
    }
    // a predicate that opted in hands its park to the owner instead, bounded by the same
    // retry-once-then-escalate policy every other deviation goes through — it still ends in a
    // park if the owner cannot resolve it, just later and via `deps.park`, not here
    if (fired.deviation && runner.enrollment.owner && this.ledgerRecord) {
      recordDeviation(this.ledgerRecord, runner.enrollment.watcherId, fired.deviation)
      return 'clear'
    }
    await this.assertLeaseHeld(runner)
    if (this.deletePending(runner)) {
      return 'quiesced'
    }
    const isWorkerEscalation = fired.predicateId === OBJECTIVE_WORKER_ESCALATION_PREDICATE_ID
    this.status.park(runner, {
      kind: 'stop-predicate',
      predicateId: fired.predicateId,
      reason: fired.reason,
      // detail is a mailbox message id only for this predicate; others use it for other identities
      ...(isWorkerEscalation && fired.detail !== undefined ? { messageId: fired.detail } : {})
    })
    return 'parked'
  }

  private async assertLeaseHeld(runner: WatcherRunner): Promise<void> {
    if (!runner.leaseGuard) {
      throw new Error('Watcher stop transition reached persistence without a lease')
    }
    await runner.leaseGuard.assertHeld()
  }

  private deletePending(runner: WatcherRunner): boolean {
    return runner.stopped || runner.controlPending === 'delete'
  }
}
