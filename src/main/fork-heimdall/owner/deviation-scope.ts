import { getLatestAttempts } from '../../../shared/fork-heimdall/ledger-queries'
import type { AttemptEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { Deviation } from '../../../shared/fork-heimdall/owner/deviation'
import type { WatcherRunner } from '../runner-state'

/** Decides whether a human-routed owner escalation can remain scoped to this kind's live loop. */
export function deviationIsDispatchScoped(
  deviation: Deviation,
  runner: WatcherRunner,
  ledger: WatcherLedger
): boolean {
  if (runner.kind.owner?.humanEscalation === 'kind-handles') {
    return true
  }
  const concurrency = runner.kind.concurrency
  if (!concurrency) {
    return false
  }
  const attempt =
    deviation.kind === 'retry-exhausted'
      ? getLatestAttempts(ledger)
          .filter(
            (candidate) =>
              candidate.action.kind === 'dispatch-node' &&
              'taskKey' in candidate.action &&
              candidate.action.taskKey === deviation.taskKey
          )
          .reduce<AttemptEntry | undefined>(
            (latest, candidate) => (!latest || candidate.atMs >= latest.atMs ? candidate : latest),
            undefined
          )
      : 'dispatchId' in deviation && deviation.dispatchId
        ? getLatestAttempts(ledger).find(
            (candidate) => candidate.dispatchId === deviation.dispatchId
          )
        : null
  return attempt ? concurrency.isIsolatedAttempt(attempt, ledger) : false
}
