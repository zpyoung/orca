import { sanitizeCrashReportString } from '../../shared/crash-report-redaction'
import { deriveBudgetState, type BudgetState } from '../../shared/fork-heimdall/budget'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherTickTrace } from '../../shared/fork-heimdall/tick-trace'
import type { WatcherEnrollment, WatcherStatus } from '../../shared/fork-heimdall/watcher-types'

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
export function dormantWatcherStatus(
  enrollment: WatcherEnrollment,
  ledger: WatcherLedger
): WatcherStatus {
  const terminal = ledger.entries.find((entry) => entry.kind === 'terminal')
  return {
    watcherId: enrollment.watcherId,
    enabled: enrollment.enabled,
    state: terminal ? 'terminal' : enrollment.enabled ? 'watching' : 'disabled',
    phase: terminal ? 'terminal' : enrollment.enabled ? 'starting' : 'disabled',
    reason: terminal?.reason ?? null,
    parkReason: null,
    budget: deriveBudgetState(ledger, enrollment.budget),
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
