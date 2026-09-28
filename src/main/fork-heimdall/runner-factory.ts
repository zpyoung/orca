import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { dormantWatcherStatus } from './debug-report'
import type { RegisteredWatcherKind } from './registry'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

/** Rehydrates the in-memory scheduler state from durable enrollment, ledger, and traces. */
export function createWatcherRunner(
  enrollment: WatcherEnrollment,
  kind: RegisteredWatcherKind,
  ledgerStore: RunnerLedgerStore
): WatcherRunner {
  const ledger = ledgerStore.read(enrollment.watcherId)
  const traces = ledgerStore.readTickTraces(enrollment.watcherId)
  return {
    enrollment,
    kind,
    status: dormantWatcherStatus(
      enrollment,
      ledger,
      ledgerStore.readTerminalSummary(enrollment.watcherId)
    ),
    timer: null,
    operationTail: Promise.resolve(),
    tickQueued: false,
    reconcileAgain: false,
    stopped: enrollment.terminalAtMs !== null,
    suspended: false,
    recovered: false,
    controlPending: null,
    forceFresh: false,
    consecutiveErrors: 0,
    consecutiveGateHolds: 0,
    lastFullResyncAtMs: null,
    lastSnapshot: null,
    traceSequence: traces.at(-1)?.seq ?? 0,
    traces,
    leaseGuard: null,
    leaseRenewal: null,
    ownerBudgetInterval: null,
    idleRecheckAtMs: null
  }
}
