import type { KernelAction } from '../../shared/fork-heimdall/kind-contract'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { FiredStopPredicate } from '../../shared/fork-heimdall/stop-policy'
import type {
  WatcherEnrollment,
  WatcherStatus,
  WatcherTerminalSummary
} from '../../shared/fork-heimdall/watcher-types'
import type { HeimdallOrchestrationAdapter } from './orchestration/orchestration-adapter'
import type { LeaseGuard, LeaseStore } from './lease-store'
import type { OwnerRuntimeDependencies } from './owner/deviation-routing'
import type { RegisteredWatcherKind } from './registry'
import type { StallCauseJudgePort } from './stall-scan'
import type {
  DispatchIntervalHandle,
  DispatchLifecycleBudgetClock,
  DispatchLifecycleLedgerStore
} from './ledger-lifecycle'

export type RunnerLedgerStore = {
  appendTickTrace(watcherId: string, trace: WatcherTickTrace): void
  readTickTraces(watcherId: string): WatcherTickTrace[]
  releaseTickTracePin(watcherId: string, seq: number): void
  readTerminalSummary(watcherId: string): WatcherTerminalSummary | null
} & DispatchLifecycleLedgerStore

export type RunnerBudgetClock = {
  checkpoint(watcherId: string): void
  recoverOnStart(watcherId: string): boolean
  owned(watcherId: string): DispatchIntervalHandle | null
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
  controlPending: 'pause' | 'disarm' | 'delete' | 'set-concurrency' | null
  recovered: boolean
  forceFresh: boolean
  consecutiveErrors: number
  consecutiveGateHolds: number
  lastFullResyncAtMs: number | null
  lastSnapshot: Snapshot<unknown> | null
  traceSequence: number
  traces: WatcherTickTrace[]
  leaseGuard: LeaseGuard | null
  leaseRenewal: { dispose(): void } | null
  ownerBudgetInterval: DispatchIntervalHandle | null
  /** When an idle worker's grace window ends; pacing wakes no later so the idle trigger fires on time. */
  idleRecheckAtMs?: number | null
}

export type WatcherRunnerDependencies = {
  ledgerStore: RunnerLedgerStore
  budgetClock: RunnerBudgetClock
  leaseStore: LeaseStore
  orchestration: HeimdallOrchestrationAdapter
  persistEnabled(enrollment: WatcherEnrollment, enabled: boolean): WatcherEnrollment
  persistTerminal(runner: WatcherRunner, fired: FiredStopPredicate): Promise<WatcherEnrollment>
  persistRemovedWorkspace(runner: WatcherRunner, fired: FiredStopPredicate): WatcherEnrollment
  /** Reads the durable enrollment record; null if the watcher is gone or its payload is malformed. */
  readEnrollment(watcherId: string): WatcherEnrollment | null
  now?: () => number
  createId?: () => string
  setTimer?: typeof setTimeout
  clearTimer?: typeof clearTimeout
  holderId: string
  leaseTtlMs?: number
  onStatus?(status: WatcherStatus): void
  notifyApproval?(enrollment: WatcherEnrollment, action: KernelAction): void
  /** Absent means no owner support is wired at all; every deviation branch stays inert. */
  owner?: OwnerRuntimeDependencies
  /** Absent means idle workers are never judged; the stall scan itself still runs. */
  stallCause?: StallCauseJudgePort
}
