import {
  HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY,
  HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY
} from '../../../../../shared/fork-heimdall/capability'
import type { WatcherDetailReader } from '../../../../../shared/fork-heimdall/remote-reader-schemas'
import type { LedgerEntry, WatcherLedger } from '../../../../../shared/fork-heimdall/ledger-types'
import type { RuntimeCapability } from '../../../../../shared/protocol-version'
import type { RpcContext } from '../../core'

type HeimdallWireProjectionContext = Pick<RpcContext, 'clientKind' | 'clientCapabilities'>

function needsProjection(
  context: HeimdallWireProjectionContext,
  capability: RuntimeCapability
): boolean {
  return (
    context.clientKind !== undefined && context.clientCapabilities?.includes(capability) !== true
  )
}

function hasPreDispatchFailureResult(entry: LedgerEntry): boolean {
  if (entry.kind !== 'attempt' || typeof entry.result !== 'object' || entry.result === null) {
    return false
  }
  const result = entry.result
  return (
    'status' in result &&
    result.status === 'refused' &&
    'reason' in result &&
    result.reason === 'pre-dispatch-failure'
  )
}

function hasHumanReply(entry: LedgerEntry): boolean {
  return entry.kind === 'escalation' && entry.humanReply !== undefined
}

function stripPreDispatchFailure(entry: LedgerEntry): LedgerEntry {
  if (!hasPreDispatchFailureResult(entry) || entry.kind !== 'attempt') {
    return entry
  }
  const projected = { ...entry }
  delete projected.result
  return projected
}

function stripHumanReply(entry: LedgerEntry): LedgerEntry {
  if (entry.kind !== 'escalation' || entry.humanReply === undefined) {
    return entry
  }
  const projected = { ...entry }
  delete projected.humanReply
  return projected
}

/**
 * Keeps the durable certainty fields but hides the expanded DispatchResult enum and the operator's
 * answer-escalation reply from readers that have not negotiated the capabilities that describe them.
 */
export function projectHeimdallLedgerForClient(
  ledger: WatcherLedger,
  context: HeimdallWireProjectionContext
): WatcherLedger {
  const stripDispatchResult =
    needsProjection(context, HEIMDALL_DISPATCH_RESULT_PRE_DISPATCH_FAILURE_RUNTIME_CAPABILITY) &&
    ledger.entries.some(hasPreDispatchFailureResult)
  const stripReply =
    needsProjection(context, HEIMDALL_WATCHER_ANSWER_ESCALATION_RUNTIME_CAPABILITY) &&
    ledger.entries.some(hasHumanReply)
  if (!stripDispatchResult && !stripReply) {
    return ledger
  }
  return {
    ...ledger,
    entries: ledger.entries.map((entry) => {
      const withoutDispatchResult = stripDispatchResult ? stripPreDispatchFailure(entry) : entry
      return stripReply ? stripHumanReply(withoutDispatchResult) : withoutDispatchResult
    })
  }
}

export function projectHeimdalDetailForClient(
  detail: WatcherDetailReader,
  context: HeimdallWireProjectionContext
): WatcherDetailReader {
  const ledger = projectHeimdallLedgerForClient(detail.ledger, context)
  return ledger === detail.ledger ? detail : { ...detail, ledger }
}
