import { describe, expect, it } from 'vitest'
import type {
  AttemptEntry,
  EscalationEntry,
  LedgerEntry,
  WatcherLedger
} from '../../shared/fork-heimdall/ledger-types'
import { workerEscalationParkId } from '../../shared/fork-heimdall/park-escalation-id'
import { parkedForWorkerQuestion, workerEscalationParkRecovered } from './runner-worker-state'

function haltEntry(escalationKind: string, atMs: number): EscalationEntry {
  return {
    kind: 'escalation',
    eventId: `event-${escalationKind}-${atMs}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    escalationId: `${escalationKind}:watcher-1:${atMs}`,
    escalationKind,
    status: 'open',
    foldCount: 1
  }
}

function ledger(entries: LedgerEntry[]): WatcherLedger {
  return { watcherId: 'watcher-1', entries }
}

describe('parkedForWorkerQuestion', () => {
  it('is true when the most recent halt is a worker-question park', () => {
    expect(parkedForWorkerQuestion(ledger([haltEntry('park-worker-question', 10)]))).toBe(true)
  })

  it('is false when the most recent halt is a budget park', () => {
    expect(parkedForWorkerQuestion(ledger([haltEntry('park-budget', 10)]))).toBe(false)
  })

  it('is false when the most recent halt is a stop-predicate park', () => {
    expect(parkedForWorkerQuestion(ledger([haltEntry('park-stop-predicate', 10)]))).toBe(false)
  })

  it('is false when the most recent halt is a configuration-error park', () => {
    expect(parkedForWorkerQuestion(ledger([haltEntry('park-configuration-error', 10)]))).toBe(false)
  })

  it('is false once an explicit disarm supersedes an earlier worker-question park', () => {
    expect(
      parkedForWorkerQuestion(
        ledger([haltEntry('park-worker-question', 10), haltEntry('control-disarm', 20)])
      )
    ).toBe(false)
  })

  it('is true again for a fresh worker-question park after an earlier disarm', () => {
    expect(
      parkedForWorkerQuestion(
        ledger([haltEntry('control-disarm', 10), haltEntry('park-worker-question', 20)])
      )
    ).toBe(true)
  })

  it('is false for a watcher that was never parked', () => {
    expect(parkedForWorkerQuestion(ledger([]))).toBe(false)
  })
})

function workerEscalationId(dispatchId: string): string {
  return `worker-escalation:${encodeURIComponent(dispatchId)}:${encodeURIComponent('message-1')}`
}

function escalationParkEntry(dispatchId: string, atMs: number): EscalationEntry {
  return {
    ...haltEntry('park-worker-escalation', atMs),
    escalationId: workerEscalationParkId('watcher-1', workerEscalationId(dispatchId))
  }
}

function workerEscalationEntry(
  dispatchId: string,
  status: 'open' | 'resolved',
  atMs: number
): EscalationEntry {
  return {
    ...haltEntry('worker-escalation', atMs),
    escalationKind: 'worker-escalation',
    escalationId: workerEscalationId(dispatchId),
    status
  }
}

function settledAttempt(
  dispatchId: string,
  effect: 'landed' | 'indeterminate',
  atMs: number
): AttemptEntry {
  return {
    kind: 'attempt',
    eventId: `attempt-${dispatchId}-${atMs}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    attemptId: `attempt-${dispatchId}`,
    fingerprint: 'fingerprint-1',
    action: {
      kind: 'apply-review-fix',
      capability: 'write',
      visibility: 'external',
      contentIdentity: 'revision-1',
      evidenceKey: 'review:revision-1'
    },
    state: 'settled',
    effect,
    dispatchId
  }
}

describe('workerEscalationParkRecovered', () => {
  it('is true once the escalation resolved and its dispatch landed', () => {
    expect(
      workerEscalationParkRecovered(
        ledger([
          workerEscalationEntry('dispatch-1', 'resolved', 10),
          escalationParkEntry('dispatch-1', 11),
          settledAttempt('dispatch-1', 'landed', 12)
        ])
      )
    ).toBe(true)
  })

  it('is false when the dispatch settled without landing', () => {
    expect(
      workerEscalationParkRecovered(
        ledger([
          workerEscalationEntry('dispatch-1', 'resolved', 10),
          escalationParkEntry('dispatch-1', 11),
          settledAttempt('dispatch-1', 'indeterminate', 12)
        ])
      )
    ).toBe(false)
  })

  it('is false while any worker escalation is still unresolved', () => {
    expect(
      workerEscalationParkRecovered(
        ledger([
          workerEscalationEntry('dispatch-1', 'resolved', 10),
          escalationParkEntry('dispatch-1', 11),
          settledAttempt('dispatch-1', 'landed', 12),
          workerEscalationEntry('dispatch-2', 'open', 13)
        ])
      )
    ).toBe(false)
  })

  it('is false when only an unrelated dispatch landed', () => {
    expect(
      workerEscalationParkRecovered(
        ledger([
          workerEscalationEntry('dispatch-1', 'resolved', 10),
          escalationParkEntry('dispatch-1', 11),
          settledAttempt('dispatch-2', 'landed', 12)
        ])
      )
    ).toBe(false)
  })

  it('is false when the most recent halt is a different park', () => {
    expect(
      workerEscalationParkRecovered(
        ledger([
          workerEscalationEntry('dispatch-1', 'resolved', 10),
          escalationParkEntry('dispatch-1', 11),
          settledAttempt('dispatch-1', 'landed', 12),
          haltEntry('park-budget', 13)
        ])
      )
    ).toBe(false)
  })

  it('is false once an explicit disarm supersedes the escalation park', () => {
    expect(
      workerEscalationParkRecovered(
        ledger([
          workerEscalationEntry('dispatch-1', 'resolved', 10),
          escalationParkEntry('dispatch-1', 11),
          settledAttempt('dispatch-1', 'landed', 12),
          haltEntry('control-disarm', 13)
        ])
      )
    ).toBe(false)
  })
})
