import { getInFlightAttempts } from '../../../shared/fork-heimdall/ledger-queries'
import type { WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import { HEIMDALL_FULL_RESYNC_MS } from '../../../shared/fork-heimdall/pacing'
import type { StallDeviation } from '../../../shared/fork-heimdall/owner/deviation'
import { mailboxBody } from '../runner-mailbox'

/**
 * Seeded at the kernel's own "cached view is too old to trust" cadence rather than a new constant,
 * since a dispatch that hasn't moved in that long is exactly as stale as a snapshot would be.
 */
export const OWNER_STALL_THRESHOLD_MS = HEIMDALL_FULL_RESYNC_MS

function lastProgressAtMs(ledger: WatcherLedger, dispatchId: string, attemptAtMs: number): number {
  let latest = attemptAtMs
  for (const entry of ledger.entries) {
    if (entry.kind !== 'evidence') {
      continue
    }
    const body = mailboxBody(entry)
    if (body?.dispatchId === dispatchId && entry.atMs > latest) {
      latest = entry.atMs
    }
  }
  return latest
}

/** The first running dispatch whose last observed progress predates the stall threshold, if any. */
export function detectStall(
  ledger: WatcherLedger,
  nowMs: number,
  thresholdMs: number = OWNER_STALL_THRESHOLD_MS
): StallDeviation | null {
  for (const attempt of getInFlightAttempts(ledger)) {
    if (attempt.state !== 'running' || !attempt.dispatchId) {
      continue
    }
    const inFlightSinceMs = lastProgressAtMs(ledger, attempt.dispatchId, attempt.atMs)
    if (nowMs - inFlightSinceMs >= thresholdMs) {
      const taskKey =
        'taskKey' in attempt.action && typeof attempt.action.taskKey === 'string'
          ? attempt.action.taskKey
          : undefined
      return {
        kind: 'stall',
        what: attempt.action.kind,
        dispatchId: attempt.dispatchId,
        ...(taskKey ? { taskKey } : {}),
        inFlightSinceMs,
        thresholdMs
      }
    }
  }
  return null
}
