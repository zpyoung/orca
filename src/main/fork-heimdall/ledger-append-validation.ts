import { isDeepStrictEqual } from 'node:util'
import { getUnresolvedAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type {
  AttemptEntry,
  AttemptResolvedEntry,
  IntervalCheckpointEntry,
  IntervalCloseEntry,
  IntervalOpenEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'

type IntervalEntry = IntervalOpenEntry | IntervalCheckpointEntry | IntervalCloseEntry

export function assertAttemptResolution(
  ledger: WatcherLedger,
  candidate: AttemptResolvedEntry
): void {
  if (
    ledger.entries.some(
      (entry) => entry.kind === 'attempt-resolved' && entry.attemptId === candidate.attemptId
    )
  ) {
    throw new Error(`Heimdall attempt ${candidate.attemptId} is already resolved`)
  }
  let latest: AttemptEntry | null = null
  for (const entry of ledger.entries) {
    if (entry.kind === 'attempt' && entry.attemptId === candidate.attemptId) {
      latest = entry
    }
  }
  if (!latest) {
    throw new Error(`Unknown Heimdall attempt: ${candidate.attemptId}`)
  }
  if (latest.state !== 'settled' || latest.effect !== 'indeterminate') {
    throw new Error(
      `Heimdall attempt ${candidate.attemptId} is not a settled indeterminate attempt`
    )
  }
}

export function assertAttemptTransition(ledger: WatcherLedger, candidate: AttemptEntry): void {
  let latest: AttemptEntry | null = null
  let resolved = false
  for (const entry of ledger.entries) {
    if (entry.kind === 'attempt' && entry.attemptId === candidate.attemptId) {
      latest = entry
    } else if (entry.kind === 'attempt-resolved' && entry.attemptId === candidate.attemptId) {
      resolved = true
    }
  }
  if (resolved) {
    throw new Error(`Heimdall attempt ${candidate.attemptId} is already resolved`)
  }
  if (latest) {
    if (
      latest.fingerprint !== candidate.fingerprint ||
      !isDeepStrictEqual(latest.action, candidate.action)
    ) {
      throw new Error(`Heimdall attempt ${candidate.attemptId} has immutable identity`)
    }
    if (latest.state === 'settled') {
      const validDispatchRecovery =
        latest.effect === 'indeterminate' &&
        latest.dispatch !== undefined &&
        candidate.state === 'running' &&
        candidate.dispatchId !== undefined &&
        candidate.effect === undefined &&
        candidate.reason === undefined &&
        candidate.result === undefined &&
        isDeepStrictEqual(latest.dispatch, candidate.dispatch)
      if (!validDispatchRecovery) {
        throw new Error(`Heimdall attempt ${candidate.attemptId} is already settled`)
      }
    }
    if (latest.state === 'running' && candidate.state === 'attempted') {
      throw new Error(`Heimdall attempt ${candidate.attemptId} cannot move backward`)
    }
  }

  const unresolved = getUnresolvedAttempts({
    watcherId: candidate.watcherId,
    entries: [...ledger.entries, candidate]
  })
  if (unresolved.length > 1) {
    throw new Error(`Heimdall watcher ${candidate.watcherId} already has an unresolved attempt`)
  }
}

export function assertIntervalTransition(ledger: WatcherLedger, candidate: IntervalEntry): void {
  const intervals = new Map<string, { lastAtMs: number; closed: boolean }>()
  for (const entry of ledger.entries) {
    if (entry.kind === 'interval-open') {
      if (!intervals.has(entry.intervalId)) {
        intervals.set(entry.intervalId, { lastAtMs: entry.atMs, closed: false })
      }
    } else if (entry.kind === 'interval-checkpoint') {
      const interval = intervals.get(entry.intervalId)
      if (interval && !interval.closed) {
        interval.lastAtMs = entry.atMs
      }
    } else if (entry.kind === 'interval-close') {
      const interval = intervals.get(entry.intervalId)
      if (interval) {
        interval.lastAtMs = entry.atMs
        interval.closed = true
      }
    }
  }
  if (candidate.kind === 'interval-open') {
    if ([...intervals.values()].some((interval) => !interval.closed)) {
      throw new Error(`Heimdall watcher ${candidate.watcherId} already has an open interval`)
    }
    if (intervals.has(candidate.intervalId)) {
      throw new Error(`Heimdall budget interval ${candidate.intervalId} already exists`)
    }
    return
  }
  const interval = intervals.get(candidate.intervalId)
  if (!interval || interval.closed) {
    throw new Error(`Heimdall budget interval ${candidate.intervalId} is not open`)
  }
  if (
    candidate.kind === 'interval-close' &&
    candidate.closeReason === 'contact-lost' &&
    candidate.atMs !== interval.lastAtMs
  ) {
    throw new Error(
      `Heimdall budget interval ${candidate.intervalId} contact-loss close must use its last checkpoint`
    )
  }
}
