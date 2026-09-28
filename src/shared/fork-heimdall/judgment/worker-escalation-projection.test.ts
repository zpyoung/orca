import { describe, expect, it } from 'vitest'
import type { EscalationEntry, EvidenceEntry, WatcherLedger } from '../ledger-types'
import { latestActiveWorkerEscalation } from './worker-escalation-projection'

function mailbox(messageId: string, atMs: number): EvidenceEntry {
  return {
    kind: 'evidence',
    eventId: `mailbox-${messageId}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    evidenceKind: 'orchestration-mailbox',
    source: { kind: 'orchestration', sequence: atMs, messageId },
    payload: {
      type: 'escalation',
      subject: 'Blocked',
      body: 'Need operator help',
      payload: { dispatchId: 'dispatch-1' }
    }
  }
}

function consumed(messageId: string, atMs: number): EvidenceEntry {
  return {
    kind: 'evidence',
    eventId: `consumed-${messageId}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    evidenceKind: 'worker-escalation-consumed',
    payload: { messageId }
  }
}

function durable(
  messageId: string,
  status: EscalationEntry['status'],
  atMs: number,
  foldCount = 1
): EscalationEntry {
  return {
    kind: 'escalation',
    eventId: `durable-${messageId}-${status}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    escalationId: `worker-escalation:${encodeURIComponent('dispatch-1')}:${encodeURIComponent(messageId)}`,
    escalationKind: 'worker-escalation',
    status,
    foldCount,
    reason: 'Blocked: Need operator help'
  }
}

function ledger(entries: WatcherLedger['entries']): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

describe('active worker escalation projection', () => {
  it('keeps a consumed-for-parking escalation active while its durable row is open', () => {
    const projected = latestActiveWorkerEscalation(
      ledger([
        mailbox('message-1', 10),
        durable('message-1', 'open', 11),
        consumed('message-1', 12)
      ])
    )

    expect(projected).toMatchObject({
      subjectId: 'message-1',
      report: {
        type: 'escalation',
        subjectId: 'message-1',
        subject: 'Blocked',
        body: 'Need operator help'
      }
    })
  })

  it.each(['acknowledged', 'resolved'] as const)(
    'drops an escalation after its durable row becomes %s',
    (status) => {
      expect(
        latestActiveWorkerEscalation(
          ledger([
            mailbox('message-1', 10),
            durable('message-1', 'open', 11),
            consumed('message-1', 12),
            durable('message-1', status, 13, 2)
          ])
        )
      ).toBeNull()
    }
  )

  it('gives a renewed same-text message a distinct active projection', () => {
    const firstLedger = ledger([
      mailbox('message-1', 10),
      durable('message-1', 'open', 11),
      consumed('message-1', 12)
    ])
    const first = latestActiveWorkerEscalation(firstLedger)
    const renewed = latestActiveWorkerEscalation(
      ledger([
        ...firstLedger.entries,
        durable('message-1', 'acknowledged', 13, 2),
        mailbox('message-2', 14),
        durable('message-2', 'open', 15),
        consumed('message-2', 16)
      ])
    )

    expect(first?.subjectId).toBe('message-1')
    expect(renewed?.subjectId).toBe('message-2')
    expect(renewed?.report).not.toEqual(first?.report)
  })
})
