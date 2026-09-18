import { HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY } from '../../../../../shared/fork-heimdall/capability'
import type { WatcherDetail } from '../../../../../shared/fork-heimdall/fleet-types'
import type { LedgerEntry, WatcherLedger } from '../../../../../shared/fork-heimdall/ledger-types'
import type { RpcContext } from '../../core'

type HeimdallWireProjectionContext = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

function hasPreDispatchFailureResult(entry: LedgerEntry): boolean {
  if (entry.kind !== 'attempt' || typeof entry.result !== 'object' || entry.result === null) {
    return false
  }
  const result = entry.result as { status?: unknown; reason?: unknown }
  return result.status === 'refused' && result.reason === 'pre-dispatch-failure'
}

function projectEntry(entry: LedgerEntry): LedgerEntry {
  if (!hasPreDispatchFailureResult(entry) || entry.kind !== 'attempt') {
    return entry
  }
  const projected = { ...entry }
  delete projected.result
  return projected
}

/** Keeps the durable certainty fields but hides the expanded DispatchResult enum from old readers. */
export function projectHeimdallLedgerForClient(
  ledger: WatcherLedger,
  context: HeimdallWireProjectionContext
): WatcherLedger {
  if (
    context.clientKind === undefined ||
    context.clientCapabilities?.includes(
      HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY
    ) === true ||
    !ledger.entries.some(hasPreDispatchFailureResult)
  ) {
    return ledger
  }
  return { ...ledger, entries: ledger.entries.map(projectEntry) }
}

export function projectHeimdallDetailForClient(
  detail: WatcherDetail,
  context: HeimdallWireProjectionContext
): WatcherDetail {
  const ledger = projectHeimdallLedgerForClient(detail.ledger, context)
  return ledger === detail.ledger ? detail : { ...detail, ledger }
}
