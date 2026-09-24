import {
  getInFlightAttempts,
  getLatestEscalations
} from '../../../shared/fork-heimdall/ledger-queries'
import type { EscalationEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import { HEIMDALL_FULL_RESYNC_MS } from '../../../shared/fork-heimdall/pacing'
import type { StallDeviation } from '../../../shared/fork-heimdall/owner/deviation'
import { mailboxBody } from '../runner-mailbox'
import { ownerDeviationEscalationId } from './deviation-ledger'

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
  let latestEscalations: readonly EscalationEntry[] | null = null
  for (const attempt of getInFlightAttempts(ledger)) {
    if (attempt.state !== 'running' || !attempt.dispatchId) {
      continue
    }
    const inFlightSinceMs = lastProgressAtMs(ledger, attempt.dispatchId, attempt.atMs)
    if (nowMs - inFlightSinceMs < thresholdMs) {
      continue
    }
    const taskKey =
      'taskKey' in attempt.action && typeof attempt.action.taskKey === 'string'
        ? attempt.action.taskKey
        : undefined
    const stall: StallDeviation = {
      kind: 'stall',
      what: attempt.action.kind,
      dispatchId: attempt.dispatchId,
      ...(taskKey ? { taskKey } : {}),
      inFlightSinceMs,
      thresholdMs
    }
    const escalationId = ownerDeviationEscalationId(ledger.watcherId, stall)
    latestEscalations ??= getLatestEscalations(ledger)
    const latest = latestEscalations.find((entry) => entry.escalationId === escalationId)
    if (latest?.status === 'resolved') {
      let resolvedOccurrences = 0
      for (const entry of ledger.entries) {
        if (
          entry.kind === 'escalation' &&
          entry.escalationId === escalationId &&
          entry.escalationKind === 'owner-deviation' &&
          entry.status === 'resolved'
        ) {
          resolvedOccurrences += 1
        }
      }
      const backoffMs = thresholdMs * 2 ** Math.min(resolvedOccurrences, 3)
      if (nowMs < latest.atMs + backoffMs) {
        continue
      }
    }
    return stall
  }
  return null
}
