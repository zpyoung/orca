import { sanitizeCrashReportString } from '../../shared/crash-report-redaction'
import { deriveBudgetState, type BudgetState } from '../../shared/fork-heimdall/budget'
import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type {
  WatcherEnrollment,
  WatcherParkReason,
  WatcherStatus
} from '../../shared/fork-heimdall/watcher-types'

export const HEIMDALL_DEBUG_REPORT_SCHEMA_VERSION = 1
export const DEBUG_REPORT_LEDGER_ENTRY_LIMIT = 200
export const DEBUG_REPORT_TRACE_LIMIT = 5

export type WatcherRunnerDebugState = {
  consecutiveErrors: number
  lastFullResyncAtMs: number | null
  tickQueued: boolean
  reconcileAgain: boolean
  timerArmed: boolean
  actionInFlight: boolean
  leaseEpoch: number | null
}

export type HeimdallDebugReportInput = {
  enrollment: WatcherEnrollment
  status: WatcherStatus
  ledger: WatcherLedger
  traces: readonly WatcherTickTrace[]
  runner: WatcherRunnerDebugState | null
  generatedAtMs: number
  appVersion: string
  platform: string
  homeDirectory?: string
}

export type HeimdallDebugReport = {
  schemaVersion: number
  generatedAtMs: number
  appVersion: string
  platform: string
  enrollment: WatcherEnrollment
  status: WatcherStatus
  budget: BudgetState
  runner: WatcherRunnerDebugState | null
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

export function dormantWatcherStatus(
  enrollment: WatcherEnrollment,
  ledger: WatcherLedger
): WatcherStatus {
  const terminal = ledger.entries.find((entry) => entry.kind === 'terminal')
  const budget = deriveBudgetState(ledger, enrollment.budget)
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
  const approval = enrollment.enabled
    ? getLatestEscalations(ledger)
        .toReversed()
        .find(
          (entry) =>
            entry.status === 'open' &&
            entry.escalationKind === 'awaiting-approval' &&
            entry.approvalScope
        )
    : null
  const state = terminal
    ? 'terminal'
    : enrollment.paused
      ? 'held'
      : automaticallyParked
        ? 'parked'
        : approval
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
        : (parkReason?.kind ??
          (automaticallyParked ? 'ready-to-resume' : (approval?.reason ?? null)))),
    parkReason,
    budget,
    startedAtMs: enrollment.createdAtMs,
    lastSuccessfulTickAtMs: null,
    nextPulseAtMs: null
  }
}

export function buildHeimdallDebugReport(input: HeimdallDebugReportInput): HeimdallDebugReport {
  const entries = input.ledger.entries.slice(-DEBUG_REPORT_LEDGER_ENTRY_LIMIT)
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
      workspacePath: collapseWatcherHomeDirectory(
        input.enrollment.workspacePath,
        input.homeDirectory
      )
    },
    status: input.status,
    budget: deriveBudgetState(input.ledger, input.enrollment.budget),
    runner: input.runner,
    ledger: { totalEntries: input.ledger.entries.length, entries },
    traces
  }
}
