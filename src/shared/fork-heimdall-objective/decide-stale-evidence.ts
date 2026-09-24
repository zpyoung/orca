import type { WatcherLedger } from '../fork-heimdall/ledger-types'
import {
  latestObjectiveAttempt,
  objectiveAttemptDisposition,
  type ObjectiveAttempt
} from './decision-context'
import type { ObjectiveAction } from './objective-actions'

/** Bounds re-issuing a check/gate whose evidence went stale mid-run at the same content identity. */
export const OBJECTIVE_STALE_EVIDENCE_RETRY_CAP = 3

/**
 * True while a plan-review, reviewer or integrator worker is reading the current workspace content.
 * Checks and gates must not touch that content until the read-only worker settles.
 */
export function objectiveReadOnlyWorkerInFlight(
  attempts: readonly ObjectiveAttempt[],
  ledger: WatcherLedger
): boolean {
  const worker = latestObjectiveAttempt(
    attempts,
    (action) =>
      action.kind === 'dispatch-plan-review' ||
      action.kind === 'dispatch-reviewer' ||
      action.kind === 'dispatch-integrator'
  )
  if (!worker) {
    return false
  }
  const disposition = objectiveAttemptDisposition(worker.attempt, ledger)
  return disposition === 'in-flight' || disposition === 'indeterminate'
}

/**
 * Re-issues a check/gate whose most recent attempt at this content identity went stale (the
 * workspace changed mid-run) with a distinct `#stale-<n>` evidenceKey suffix, so the kernel's
 * `[contentIdentity, kind, evidenceKey]` fingerprint gate does not hold the retry as already
 * settled. Returns null once prior stale attempts at that identity reach the cap, so the caller
 * falls through to the ordinary not-landed path instead of retrying forever.
 */
export function objectiveStaleEvidenceReissueEvidenceKey(
  baseEvidenceKey: string,
  attempts: readonly ObjectiveAttempt[],
  ledger: WatcherLedger,
  matches: (action: ObjectiveAction) => boolean
): string | null {
  let staleCount = 0
  for (const candidate of attempts) {
    if (
      matches(candidate.action) &&
      candidate.attempt.reason === 'check-evidence-stale' &&
      objectiveAttemptDisposition(candidate.attempt, ledger) === 'not-landed'
    ) {
      staleCount += 1
    }
  }
  if (staleCount >= OBJECTIVE_STALE_EVIDENCE_RETRY_CAP) {
    return null
  }
  return `${baseEvidenceKey}#stale-${staleCount}`
}
