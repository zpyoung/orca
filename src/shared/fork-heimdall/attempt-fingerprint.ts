import type { EffectCertainty } from './effect-certainty'
import type { AttemptEntry, WatcherLedger } from './ledger-types'

export type AttemptDisposition =
  | 'unseen'
  | 'in-flight'
  | 'completed'
  | 'retryable-failure'
  | 'unresolved'

export type AttemptLedgerInspection = {
  disposition: AttemptDisposition
  hasInFlight: boolean
  hasUnresolved: boolean
}

/** JSON tuple encoding is delimiter-safe and stable across processes and restarts. */
export function makeAttemptFingerprint(
  contentIdentity: string,
  actionKind: string,
  evidenceKey: string
): string {
  return JSON.stringify([contentIdentity, actionKind, evidenceKey])
}

function dispositionFor(
  attempt: AttemptEntry | null,
  resolvedEffect: EffectCertainty | undefined
): AttemptDisposition {
  if (!attempt) {
    return 'unseen'
  }
  if (resolvedEffect === 'landed') {
    return 'completed'
  }
  if (resolvedEffect === 'not-landed') {
    return 'retryable-failure'
  }
  if (attempt.state === 'attempted' || attempt.state === 'running') {
    return 'in-flight'
  }
  const effect = attempt.effect
  if (effect === 'landed') {
    return 'completed'
  }
  if (effect === 'not-landed') {
    return 'retryable-failure'
  }
  return 'unresolved'
}

/** Derives all gate-facing attempt facts in one pass over append-only revisions. */
export function inspectAttemptLedger(
  ledger: WatcherLedger,
  fingerprint: string
): AttemptLedgerInspection {
  const latestById = new Map<string, AttemptEntry>()
  const resolutionByAttemptId = new Map<string, EffectCertainty>()
  for (const entry of ledger.entries) {
    if (entry.kind === 'attempt') {
      latestById.delete(entry.attemptId)
      latestById.set(entry.attemptId, entry)
    } else if (entry.kind === 'attempt-resolved') {
      resolutionByAttemptId.set(entry.attemptId, entry.effect)
    }
  }

  let matching: AttemptEntry | null = null
  let hasInFlight = false
  let hasUnresolved = false
  for (const attempt of latestById.values()) {
    if (attempt.fingerprint === fingerprint) {
      matching = attempt
    }
    if (resolutionByAttemptId.has(attempt.attemptId)) {
      continue
    }
    if (attempt.state === 'attempted' || attempt.state === 'running') {
      hasInFlight = true
    } else if (attempt.effect === 'indeterminate') {
      hasUnresolved = true
    }
  }

  return {
    disposition: dispositionFor(
      matching,
      matching ? resolutionByAttemptId.get(matching.attemptId) : undefined
    ),
    hasInFlight,
    hasUnresolved
  }
}

export function getAttemptDisposition(
  ledger: WatcherLedger,
  fingerprint: string
): AttemptDisposition {
  return inspectAttemptLedger(ledger, fingerprint).disposition
}
