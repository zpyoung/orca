import { sanitizeCrashReportString } from '../crash-report-redaction'
import { deriveBudgetState, type BudgetPolicy, type BudgetState } from '../fork-heimdall/budget'
import type { LedgerEntry, WatcherLedger } from '../fork-heimdall/ledger-types'
import { TICK_TRACE_FULL_DETAIL_COUNT, type WatcherTickTrace } from '../fork-heimdall/tick-trace'
import type { WatcherStatus } from '../fork-heimdall/watcher-types'
import type { HostedReviewSitterDefinition } from './types'

export const HOSTED_REVIEW_SITTER_DEBUG_REPORT_SCHEMA_VERSION = 2
export const DEBUG_REPORT_LEDGER_ENTRY_LIMIT = 200
export const DEBUG_REPORT_TRACE_LIMIT = TICK_TRACE_FULL_DETAIL_COUNT

const ERROR_MESSAGE_MAX_LENGTH = 2_000
const ERROR_STACK_MAX_LENGTH = 8_000

/** Live loop state. `null` for a stopped watcher whose runner has been deleted. */
export type HostedReviewSitterRunnerSnapshot = {
  consecutiveErrors: number
  lastFullResyncAtMs: number | null
  tickQueued: boolean
  reconcileAgain: boolean
  fenced: boolean
  timerArmed: boolean
  actionInFlight: boolean
}

export type HostedReviewSitterDebugReportInput = {
  definition: HostedReviewSitterDefinition
  status: WatcherStatus | null
  budgetPolicy: BudgetPolicy
  ledger: WatcherLedger
  traces: readonly WatcherTickTrace[]
  runner: HostedReviewSitterRunnerSnapshot | null
  generatedAtMs: number
  appVersion: string
  platform: string
  homeDirectory?: string
}

export type HostedReviewSitterDebugReport = {
  schemaVersion: number
  generatedAtMs: number
  appVersion: string
  platform: string
  definition: HostedReviewSitterDefinition
  status: WatcherStatus | null
  budget: BudgetState & { policy: BudgetPolicy }
  runner: HostedReviewSitterRunnerSnapshot | null
  ledger: {
    totalEntries: number
    entries: readonly LedgerEntry[]
  }
  traces: readonly WatcherTickTrace[]
}

/** Collapse a home-directory prefix to `~` while retaining the useful worktree suffix. */
export function collapseHomeDirectory(path: string, homeDirectory?: string): string {
  if (!homeDirectory || !path.startsWith(homeDirectory)) {
    return path
  }
  const remainder = path.slice(homeDirectory.length)
  if (remainder === '') {
    return '~'
  }
  return remainder.startsWith('/') || remainder.startsWith('\\') ? `~${remainder}` : path
}

function sanitizeTrace(trace: WatcherTickTrace): WatcherTickTrace {
  const error = trace.error
    ? {
        message: sanitizeCrashReportString(trace.error.message, ERROR_MESSAGE_MAX_LENGTH),
        ...(trace.error.stack === undefined
          ? {}
          : { stack: sanitizeCrashReportString(trace.error.stack, ERROR_STACK_MAX_LENGTH) })
      }
    : null
  return { ...trace, error }
}

function sanitizeLedgerEntry(entry: LedgerEntry): LedgerEntry {
  if (entry.kind === 'attempt-abandoned') {
    return entry
  }
  if (!('reason' in entry) || typeof entry.reason !== 'string') {
    return entry
  }
  return { ...entry, reason: sanitizeCrashReportString(entry.reason, ERROR_MESSAGE_MAX_LENGTH) }
}

/** Assemble a copyable report entirely from caller-supplied, already-authoritative state. */
export function buildHostedReviewSitterDebugReport(
  input: HostedReviewSitterDebugReportInput
): HostedReviewSitterDebugReport {
  const { definition, ledger, traces } = input
  const newestFirst = [...traces]
    .sort((left, right) => right.seq - left.seq)
    .slice(0, DEBUG_REPORT_TRACE_LIMIT)
  const allEntries = ledger.entries
  const keptEntries = allEntries.slice(-DEBUG_REPORT_LEDGER_ENTRY_LIMIT)

  return {
    schemaVersion: HOSTED_REVIEW_SITTER_DEBUG_REPORT_SCHEMA_VERSION,
    generatedAtMs: input.generatedAtMs,
    appVersion: input.appVersion,
    platform: input.platform,
    definition: {
      ...definition,
      repoPath: collapseHomeDirectory(definition.repoPath, input.homeDirectory)
    },
    status: input.status,
    budget: { ...deriveBudgetState(ledger, input.budgetPolicy), policy: input.budgetPolicy },
    runner: input.runner,
    ledger: {
      totalEntries: allEntries.length,
      entries: keptEntries.map(sanitizeLedgerEntry)
    },
    traces: newestFirst.map(sanitizeTrace)
  }
}
