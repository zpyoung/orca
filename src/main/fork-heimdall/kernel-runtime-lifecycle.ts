import {
  getInFlightAttempts,
  getUnresolvedAttempts
} from '../../shared/fork-heimdall/ledger-queries'
import type { HeimdallKernelServiceDependencies } from './kernel-service-dependencies'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'
import type { WatcherRunnerLoop } from './runner-loop'
import {
  heimdallMailboxAddressForDispatch,
  heimdallMailboxAddressForRun
} from './mailbox-wake-registry'

export function hasKernelStorage(dependencies: HeimdallKernelServiceDependencies): boolean {
  if (dependencies.database) {
    return true
  }
  const store: unknown = dependencies.store
  if (
    typeof store !== 'object' ||
    store === null ||
    !('getProfileStorageDirectory' in store) ||
    typeof store.getProfileStorageDirectory !== 'function'
  ) {
    return false
  }
  const directory = store.getProfileStorageDirectory()
  return typeof directory === 'string' && directory.length > 0
}

export function wakeHeimdallMailboxRunners(args: {
  address: string
  runners: Iterable<WatcherRunner>
  ledgerStore: RunnerLedgerStore
  runnerLoop: WatcherRunnerLoop
}): void {
  const dispatchScoped = args.address.startsWith('dispatch:')
  for (const runner of args.runners) {
    const runId = runner.enrollment.orchestrationRunId
    if (runId && heimdallMailboxAddressForRun(runId) === args.address) {
      args.runnerLoop.schedule(runner, 0)
      continue
    }
    if (dispatchScoped && hasPendingDispatchAddress(runner, args.address, args.ledgerStore)) {
      args.runnerLoop.schedule(runner, 0)
    }
  }
}

/** Whether a loaded watcher with an owner supervises this run, so its workers' questions go to that owner. */
export function isOwnedHeimdallRun(runners: Iterable<WatcherRunner>, runId: string): boolean {
  for (const runner of runners) {
    if (runner.enrollment.orchestrationRunId === runId && runner.enrollment.owner) {
      return true
    }
  }
  return false
}

// Remote workers notify dispatch-scoped mailboxes rather than their home run address.
function hasPendingDispatchAddress(
  runner: WatcherRunner,
  address: string,
  ledgerStore: RunnerLedgerStore
): boolean {
  const ledger = ledgerStore.read(runner.enrollment.watcherId)
  for (const attempt of getInFlightAttempts(ledger)) {
    if (
      attempt.dispatchId !== undefined &&
      heimdallMailboxAddressForDispatch(attempt.dispatchId) === address
    ) {
      return true
    }
  }
  for (const attempt of getUnresolvedAttempts(ledger)) {
    if (
      attempt.dispatchId !== undefined &&
      heimdallMailboxAddressForDispatch(attempt.dispatchId) === address
    ) {
      return true
    }
  }
  return false
}
