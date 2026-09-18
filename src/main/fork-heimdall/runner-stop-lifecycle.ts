import {
  getInFlightAttempts,
  getUnresolvedAttempts
} from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import { evaluateStopPredicates } from '../../shared/fork-heimdall/stop-policy'
import { OBJECTIVE_WORKER_ESCALATION_PREDICATE_ID } from '../../shared/fork-heimdall-objective/stop-policy'
import type { WatcherRunner } from './runner-state'
import type { WatcherRunnerStatusLifecycle } from './runner-status'

export type StopLifecycleOutcome = 'clear' | 'deferred' | 'parked' | 'terminal'

/** Applies kind stop declarations only while the runner still owns its execution lease. */
export class WatcherRunnerStopLifecycle {
  constructor(private readonly status: WatcherRunnerStatusLifecycle) {}

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
      const outcomePending =
        getInFlightAttempts(ledger).length > 0 || getUnresolvedAttempts(ledger).length > 0
      if (outcomePending) {
        return 'deferred'
      }
      await this.assertLeaseHeld(runner)
      await this.status.terminal(runner, fired)
      return 'terminal'
    }
    await this.assertLeaseHeld(runner)
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
}
