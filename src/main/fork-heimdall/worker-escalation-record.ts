import { getLatestEscalations } from '../../shared/fork-heimdall/ledger-queries'
import type { RunnerLedgerStore } from './runner-state'

export function workerEscalationId(dispatchId: string | undefined, messageId: string): string {
  return `worker-escalation:${encodeURIComponent(dispatchId ?? 'unknown')}:${encodeURIComponent(messageId)}`
}

/**
 * Opens a worker escalation unless one with the same id was ever recorded, in any status, so a
 * redelivered or re-observed escalation never reopens one a human already settled. Returns the id,
 * or null when it already existed.
 */
export function appendWorkerEscalation(
  dependencies: {
    ledgerStore: Pick<RunnerLedgerStore, 'append' | 'read'>
    now(): number
    createId(): string
  },
  watcherId: string,
  input: { messageId: string; dispatchId?: string; reason: string }
): string | null {
  const escalationId = workerEscalationId(input.dispatchId, input.messageId)
  if (
    getLatestEscalations(dependencies.ledgerStore.read(watcherId)).some(
      (entry) => entry.escalationId === escalationId
    )
  ) {
    return null
  }
  dependencies.ledgerStore.append(watcherId, {
    eventId: dependencies.createId(),
    watcherId,
    atMs: dependencies.now(),
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId,
    escalationKind: 'worker-escalation',
    status: 'open',
    foldCount: 1,
    reason: input.reason
  })
  return escalationId
}
