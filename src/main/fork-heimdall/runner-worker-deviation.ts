import type { Deviation } from '../../shared/fork-heimdall/owner/deviation'
import { recordDeviation } from './owner/deviation-ledger'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

type WorkerDeviationRecorderDependencies = {
  ledgerStore: RunnerLedgerStore
  now(): number
  createId(): string
}

export function recordWorkerDeviationIfOwned(
  dependencies: WorkerDeviationRecorderDependencies,
  runner: WatcherRunner,
  deviation: Deviation
): void {
  if (!runner.enrollment.owner) {
    return
  }
  recordDeviation(
    {
      ledgerStore: dependencies.ledgerStore,
      now: dependencies.now,
      createId: dependencies.createId
    },
    runner.enrollment.watcherId,
    deviation
  )
}
