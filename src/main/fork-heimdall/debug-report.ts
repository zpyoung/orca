import { sanitizeCrashReportString } from '../../shared/crash-report-redaction'
import { deriveBudgetState, type BudgetState } from '../../shared/fork-heimdall/budget'
import type { WatcherWorker } from '../../shared/fork-heimdall/fleet-types'
import type { DebugPointer } from '../../shared/fork-heimdall/kind-contract'
import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import {
  TICK_TRACE_FULL_DETAIL_COUNT,
  type TraceSnapshotSummary,
  type WatcherTickTrace
} from '../../shared/fork-heimdall/tick-trace'
import type {
  WatcherEnrollment,
  WatcherParkReason,
  WatcherStatus,
  WatcherTerminalSummary
} from '../../shared/fork-heimdall/watcher-types'

export const HEIMDALL_DEBUG_REPORT_SCHEMA_VERSION = 3
export const DEBUG_REPORT_LEDGER_ENTRY_LIMIT = 200
export const DEBUG_REPORT_TRACE_LIMIT = TICK_TRACE_FULL_DETAIL_COUNT

export type WatcherRunnerDebugState = {
  kindId: WatcherEnrollment['kind']
  consecutiveErrors: number
  lastFullResyncAtMs: number | null
  tickQueued: boolean
  reconcileAgain: boolean
  timerArmed: boolean
  actionInFlight: boolean
  leaseEpoch: number | null
  stopped: boolean
  suspended: boolean
  controlPending: 'pause' | 'disarm' | null
  recovered: boolean
  forceFresh: boolean
  traceSequence: number
  leaseRenewalArmed: boolean
  snapshot: {
    freshness: Snapshot<unknown>['freshness']
    observedAtMs: number
    contentIdentity: string
    summary: TraceSnapshotSummary | null
  } | null
}

export type { DebugPointer } from '../../shared/fork-heimdall/kind-contract'

export type HeimdallDebugReportInput = {
  enrollment: WatcherEnrollment
  status: WatcherStatus
  ledger: WatcherLedger
  terminalSummary: WatcherTerminalSummary | null
  traces: readonly WatcherTickTrace[]
  runner: WatcherRunnerDebugState | null
  generatedAtMs: number
  appVersion: string
  platform: string
  homeDirectory?: string
  budgetClock: { openIntervalId: string | null }
  malformedPayload: boolean
  pendingControlOperation: boolean
  workers: readonly WatcherWorker[]
  workersError: string | null
  pointers: readonly DebugPointer[]
}

export type HeimdallDebugReport = {
  schemaVersion: number
  // reconcile every runner.*AtMs field and each trace's pacing block against this instant, not against each other
  generatedAtMs: number
  appVersion: string
  platform: string
  enrollment: WatcherEnrollment
  status: WatcherStatus
  budget: BudgetState
  budgetClock: { openIntervalId: string | null }
  malformedPayload: boolean
  pendingControlOperation: boolean
  runner: WatcherRunnerDebugState | null
  workers: WatcherWorker[]
  workersError: string | null
  pointers: DebugPointer[]
  ledger: { totalEntries: number; entries: WatcherLedger['entries'] }
  traces: WatcherTickTrace[]
}

export function collapseWatcherHomeDirectory(path: string, homeDirectory?: string): string {
  if (!homeDirectory || !path.startsWith(homeDirectory)) {
    return path
  }
  const remainder = path.slice(homeDirectory.length)
  if (remainder === '') {
    return '~'
  }
  return remainder.startsWith('/') || remainder.startsWith('\\') ? `~${remainder}` : path
}

export function describeDebugSnapshot(
  snapshot: Snapshot<unknown>,
  describe: (snapshot: Snapshot<unknown>) => TraceSnapshotSummary
): NonNullable<WatcherRunnerDebugState['snapshot']> {
  let summary: TraceSnapshotSummary | null = null
  try {
    summary = describe(snapshot)
  } catch {
    // A kind-owned description must not make the diagnostic endpoint unavailable.
  }
  return {
    freshness: snapshot.freshness,
    observedAtMs: snapshot.observedAtMs,
    contentIdentity: snapshot.contentIdentity,
    summary
  }
}

function sanitizeLedgerEntry(entry: LedgerEntry): LedgerEntry {
  if (entry.kind === 'attempt-abandoned') {
    return entry
  }
  let sanitized: LedgerEntry = entry
  if ('reason' in sanitized && typeof sanitized.reason === 'string') {
    sanitized = { ...sanitized, reason: sanitizeCrashReportString(sanitized.reason, 2_000) }
  }
  if (sanitized.kind === 'attempt' && sanitized.dispatch?.spec) {
    sanitized = {
      ...sanitized,
      dispatch: {
        ...sanitized.dispatch,
        spec: sanitizeCrashReportString(sanitized.dispatch.spec, 4_000)
      }
    }
  }
  return sanitized
}
function persistedParkReason(
  enrollment: WatcherEnrollment,
  ledger: WatcherLedger,
  budget: BudgetState
): WatcherParkReason | null {
  const park = getLatestEscalations(ledger)
    .toReversed()
    .find((entry) => entry.status === 'open' && entry.escalationKind.startsWith('park-'))
  if (!park) {
    return null
  }
  if (park.escalationKind === 'park-budget') {
    const persisted = decodeParkDetail(park.escalationId, enrollment.watcherId, 'budget')
    if (persisted === 'wall-clock' || persisted === 'turns') {
      return { kind: 'budget', exhaustion: { kind: persisted } }
    }
    return budget.exhausted ? { kind: 'budget', exhaustion: budget.exhausted } : null
  }
  if (park.escalationKind === 'park-stop-predicate') {
    return {
      kind: 'stop-predicate',
      predicateId:
        decodeParkDetail(park.escalationId, enrollment.watcherId, 'stop-predicate') ??
        park.reason ??
        'persisted-stop-predicate',
      reason: park.reason ?? 'stop-predicate'
    }
  }
  if (park.escalationKind === 'park-worker-question') {
    const question = getLatestEscalations(ledger)
      .toReversed()
      .find((entry) => entry.status === 'open' && entry.escalationKind === 'worker-question')
    const messageId =
      decodeParkDetail(park.escalationId, enrollment.watcherId, 'worker-question') ??
      question?.escalationId.split(':').at(-1) ??
      null
    return messageId ? { kind: 'worker-question', messageId } : null
  }
  return park.escalationKind === 'park-coordinator-seat-lost'
    ? { kind: 'coordinator-seat-lost' }
    : null
}

function decodeParkDetail(
  escalationId: string,
  watcherId: string,
  kind: WatcherParkReason['kind']
): string | null {
  const prefix = `park:${watcherId}:${kind}:`
  if (!escalationId.startsWith(prefix)) {
    return null
  }
  try {
    return decodeURIComponent(escalationId.slice(prefix.length)) || null
  } catch {
    return null
  }
}

export function durableWatcherBudget(
  enrollment: WatcherEnrollment,
  ledger: WatcherLedger,
  terminalSummary: WatcherTerminalSummary | null = null
): BudgetState {
  return terminalSummary?.totals ?? deriveBudgetState(ledger, enrollment.budget)
}

export function dormantWatcherStatus(
  enrollment: WatcherEnrollment,
  ledger: WatcherLedger,
  terminalSummary: WatcherTerminalSummary | null = null
): WatcherStatus {
  const terminal = ledger.entries.find((entry) => entry.kind === 'terminal')
  const budget = durableWatcherBudget(enrollment, ledger, terminalSummary)
  const latestHalt = ledger.entries
    .toReversed()
    .find(
      (entry) =>
        entry.kind === 'escalation' &&
        (entry.escalationKind.startsWith('park-') || entry.escalationKind === 'control-disarm')
    )
  const automaticallyParked =
    !enrollment.enabled &&
    latestHalt?.kind === 'escalation' &&
    latestHalt.escalationKind.startsWith('park-')
  const parkReason = enrollment.enabled ? null : persistedParkReason(enrollment, ledger, budget)
  const automaticParkDetail =
    automaticallyParked && latestHalt?.kind === 'escalation'
      ? (latestHalt.reason ?? 'ready-to-resume')
      : null
  const attentionEscalation = enrollment.enabled
    ? getLatestEscalations(ledger)
        .toReversed()
        .find(
          (entry) =>
            (entry.status === 'open' || entry.status === 'escalated') &&
            (entry.escalationKind === 'worker-escalation' ||
              (entry.escalationKind === 'awaiting-approval' && entry.approvalScope))
        )
    : null
  const state = terminal
    ? 'terminal'
    : enrollment.paused
      ? 'held'
      : automaticallyParked
        ? 'parked'
        : attentionEscalation
          ? 'escalated'
          : enrollment.enabled
            ? 'watching'
            : 'disabled'
  return {
    watcherId: enrollment.watcherId,
    enabled: enrollment.enabled,
    state,
    phase:
      state === 'terminal'
        ? 'terminal'
        : state === 'held'
          ? 'paused'
          : state === 'parked'
            ? 'parked'
            : state === 'escalated'
              ? 'gate'
              : state === 'watching'
                ? 'starting'
                : 'disabled',
    reason:
      terminal?.reason ??
      (enrollment.paused
        ? 'paused'
        : (parkReason?.kind ?? automaticParkDetail ?? attentionEscalation?.reason ?? null)),
    parkReason,
    budget,
    startedAtMs: enrollment.createdAtMs,
    lastSuccessfulTickAtMs: null,
    nextPulseAtMs: null
  }
}

export function buildHeimdallDebugReport(input: HeimdallDebugReportInput): HeimdallDebugReport {
  const entries = input.ledger.entries
    .slice(-DEBUG_REPORT_LEDGER_ENTRY_LIMIT)
    .map(sanitizeLedgerEntry)
  const traces = [...input.traces]
    .sort((left, right) => right.seq - left.seq)
    .slice(0, DEBUG_REPORT_TRACE_LIMIT)
    .map((trace) => ({
      ...trace,
      error: trace.error
        ? {
            message: sanitizeCrashReportString(trace.error.message, 2_000),
            ...(trace.error.stack
              ? { stack: sanitizeCrashReportString(trace.error.stack, 8_000) }
              : {})
          }
        : null
    }))
  return {
    schemaVersion: HEIMDALL_DEBUG_REPORT_SCHEMA_VERSION,
    generatedAtMs: input.generatedAtMs,
    appVersion: input.appVersion,
    platform: input.platform,
    enrollment: {
      ...input.enrollment,
      workspacePath:
        input.enrollment.executionHostId === 'local'
          ? collapseWatcherHomeDirectory(input.enrollment.workspacePath, input.homeDirectory)
          : input.enrollment.workspacePath
    },
    status: input.status,
    budget: durableWatcherBudget(input.enrollment, input.ledger, input.terminalSummary),
    budgetClock: input.budgetClock,
    malformedPayload: input.malformedPayload,
    pendingControlOperation: input.pendingControlOperation,
    runner: input.runner,
    workers: [...input.workers],
    workersError:
      input.workersError === null ? null : sanitizeCrashReportString(input.workersError, 2_000),
    pointers: input.pointers.map((pointer) => ({
      ...pointer,
      ...(pointer.detail ? { detail: sanitizeCrashReportString(pointer.detail, 2_000) } : {})
    })),
    ledger: { totalEntries: input.ledger.entries.length, entries },
    traces
  }
}
