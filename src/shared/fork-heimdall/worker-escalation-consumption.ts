export const WORKER_ESCALATION_CONSUMED_EVIDENCE_KIND = 'worker-escalation-consumed'

export type WorkerEscalationConsumedPayload = { messageId: string }

/** Reads the mailbox message id a consumption marker records, or null if malformed. */
export function workerEscalationConsumedMessageId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null) {
    return null
  }
  const messageId = (payload as Record<string, unknown>).messageId
  return typeof messageId === 'string' && messageId.length > 0 ? messageId : null
}
