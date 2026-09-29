import type { MessageWorkerIntervention } from '../../../shared/fork-heimdall/owner/intervention'
import { WorkerPromptUndeliverableError } from '../orchestration/orchestration-adapter'
import {
  resolveDeviation,
  type DeviationRecordDependencies,
  type OwnerDeviationEscalation
} from './deviation-ledger'

/**
 * Delivers an owner's reply to a stalled worker and settles the stall. Returns null once delivered,
 * or the reason a human must take over when the worker could not safely receive it.
 */
export async function applyOwnerWorkerMessage(
  deps: {
    ledgerRecord: DeviationRecordDependencies
    messageWorker(dispatchId: string, message: string): Promise<void>
  },
  watcherId: string,
  pending: OwnerDeviationEscalation,
  move: MessageWorkerIntervention
): Promise<string | null> {
  try {
    await deps.messageWorker(move.dispatchId, move.message)
  } catch (error) {
    if (!(error instanceof WorkerPromptUndeliverableError)) {
      throw error
    }
    return `The owner's reply could not be delivered: ${error.message}. Owner reply: ${move.message}`
  }
  resolveDeviation(deps.ledgerRecord, watcherId, pending)
  return null
}
