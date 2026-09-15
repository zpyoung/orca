import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { FiredStopPredicate } from '../../shared/fork-heimdall/stop-policy'
import type { WatcherEnrollment, WatcherStatus } from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import type { LeaseGuard, LeaseStore } from './lease-store'
import type { RegisteredWatcherKind } from './registry'
import type { DispatchLifecycleBudgetClock, DispatchLifecycleLedgerStore } from './ledger-lifecycle'

export type RunnerLedgerStore = {
  appendTickTrace(watcherId: string, trace: WatcherTickTrace): void
  readTickTraces(watcherId: string): WatcherTickTrace[]
  releaseTickTracePin(watcherId: string, seq: number): void
} & DispatchLifecycleLedgerStore

export type RunnerBudgetClock = {
  checkpoint(watcherId: string): void
  recoverOnStart(watcherId: string): boolean
} & DispatchLifecycleBudgetClock

export type WatcherRunner = {
  enrollment: WatcherEnrollment
  kind: RegisteredWatcherKind
  status: WatcherStatus
  timer: NodeJS.Timeout | null
  operationTail: Promise<void>
  tickQueued: boolean
  reconcileAgain: boolean
  stopped: boolean
  suspended: boolean
  controlPending: 'pause' | 'disarm' | null
  recovered: boolean
  forceFresh: boolean
  consecutiveErrors: number
  lastFullResyncAtMs: number | null
  lastSnapshot: Snapshot<unknown> | null
  traceSequence: number
  traces: WatcherTickTrace[]
  leaseGuard: LeaseGuard | null
  leaseRenewal: { dispose(): void } | null
}

export type WatcherRunnerDependencies = {
  ledgerStore: RunnerLedgerStore
  budgetClock: RunnerBudgetClock
  leaseStore: LeaseStore
  orchestration: HeimdallOrchestrationAdapter
  persistEnabled(enrollment: WatcherEnrollment, enabled: boolean): WatcherEnrollment
  persistTerminal(runner: WatcherRunner, fired: FiredStopPredicate): WatcherEnrollment
  now?: () => number
  createId?: () => string
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  holderId: string
  leaseTtlMs?: number
  onStatus?(status: WatcherStatus): void
  notifyApproval?(enrollment: WatcherEnrollment, action: KernelAction): void
}
