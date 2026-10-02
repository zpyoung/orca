import { getInFlightAttempts } from '../../shared/fork-heimdall/ledger-queries'
import type { EvidenceEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { LeaseGuard } from './lease-store'
import type { RegisteredWatcherKind } from './registry'

export type AcceptedCompletionRunner = {
  enrollment: { watcherId: string }
  kind: Pick<RegisteredWatcherKind, 'resolveAcceptedWorkerCompletion'>
  leaseGuard: LeaseGuard | null
}

export type AcceptedCompletionInput = {
  dispatchId: string
  outcome: string | undefined
  result: unknown
  evidence: EvidenceEntry
}

/**
 * Settlement effect for a worker completion. A succeeded worker lands only when its kind either
 * does not own completion resolution or confirms it; any other answer, or a throw, leaves the
 * attempt indeterminate so normal recovery reclassifies it.
 */
export async function resolveAcceptedCompletionEffect(
  runner: AcceptedCompletionRunner,
  ledgerStore: { read(watcherId: string): WatcherLedger },
  { dispatchId, outcome, result, evidence }: AcceptedCompletionInput
): Promise<'landed' | 'indeterminate'> {
  if (outcome !== 'succeeded') {
    return 'indeterminate'
  }
  const { kind } = runner
  if (!kind.resolveAcceptedWorkerCompletion) {
    return 'landed'
  }
  const ledger = ledgerStore.read(runner.enrollment.watcherId)
  const attempt = getInFlightAttempts(ledger).find(
    (candidate) => candidate.state === 'running' && candidate.dispatchId === dispatchId
  )
  if (!attempt) {
    return 'landed'
  }
  const lease = runner.leaseGuard
  if (!lease) {
    throw new Error('Watcher worker completion reached kind resolution without a lease')
  }
  await lease.assertHeld()
  let effect: 'landed' | 'indeterminate' = 'landed'
  try {
    const resolution = await kind.resolveAcceptedWorkerCompletion({
      attempt,
      dispatchId,
      evidence,
      ledger,
      lease,
      result
    })
    if (resolution !== null && resolution.effect !== 'landed') {
      effect = 'indeterminate'
    }
  } catch {
    effect = 'indeterminate'
  }
  await lease.assertHeld()
  return effect
}
