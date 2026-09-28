import type { WatcherCommandResult } from '../../../shared/fork-heimdall/fleet-types'
import type { LeaseGuard } from '../../../shared/fork-heimdall/kind-contract'
import { getInFlightAttempts } from '../../../shared/fork-heimdall/ledger-queries'
import type { StopWorkerIntervention } from '../../../shared/fork-heimdall/owner/intervention'
import {
  escalateDeviationToHuman,
  resolveDeviation,
  type DeviationRecordDependencies,
  type OwnerDeviationEscalation
} from './deviation-ledger'

/** Applies a dispatch-scoped owner stop only when the durable attempt belongs to this watcher. */
export async function applyOwnerWorkerStop(args: {
  watcherId: string
  pending: OwnerDeviationEscalation
  move: StopWorkerIntervention
  lease: LeaseGuard
  ledgerRecord: DeviationRecordDependencies
  stopWorker(dispatchId: string): Promise<WatcherCommandResult>
}): Promise<void> {
  const ledger = args.ledgerRecord.ledgerStore.read(args.watcherId)
  const active = getInFlightAttempts(ledger).some(
    (attempt) => attempt.state === 'running' && attempt.dispatchId === args.move.dispatchId
  )
  if (!active) {
    escalateDeviationToHuman(
      args.ledgerRecord,
      args.watcherId,
      args.pending,
      `Cannot stop unknown or inactive dispatch ${args.move.dispatchId}: ${args.move.rationale}`
    )
    return
  }
  await args.lease.assertHeld()
  const stopped = await args.stopWorker(args.move.dispatchId)
  await args.lease.assertHeld()
  if (stopped.status === 'applied') {
    resolveDeviation(args.ledgerRecord, args.watcherId, args.pending)
    return
  }
  const detail =
    stopped.status === 'indeterminate' ? stopped.detail : `${stopped.reason}: ${stopped.detail}`
  escalateDeviationToHuman(
    args.ledgerRecord,
    args.watcherId,
    args.pending,
    `Could not confirm stop for dispatch ${args.move.dispatchId}: ${detail}`
  )
}
