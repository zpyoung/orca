import { describe, expect, it } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  WORKER_ESCALATION_CONSUMED_EVIDENCE_KIND,
  workerEscalationConsumedMessageId,
  type WorkerEscalationConsumedPayload
} from '../../shared/fork-heimdall/worker-escalation-consumption'
import { WatcherRunnerStatusLifecycle } from './runner-status'
import type { RunnerLedgerStore, WatcherRunner } from './runner-state'

function harness(options: { enabled?: boolean; entries?: LedgerEntry[] } = {}): {
  status: WatcherRunnerStatusLifecycle
  runner: WatcherRunner
  entries: LedgerEntry[]
} {
  const entries: LedgerEntry[] = options.entries ?? []
  let nextId = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of RunnerLedgerStore; the park/parkForWorkerEscalation/readyToResume paths under test only call read and append.
  const ledgerStore = {
    read: (): WatcherLedger => ({ watcherId: 'watcher-1', entries }),
    append: (_watcherId: string, entry: LedgerEntry): void => {
      entries.push(entry)
    }
  } as unknown as RunnerLedgerStore
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of WatcherRunner; the methods under test only read/write runner.enrollment and runner.status.
  const runner = {
    enrollment: {
      watcherId: 'watcher-1',
      enabled: options.enabled ?? true,
      budget: { wallClockActiveMs: null, turns: null }
    },
    status: {}
  } as unknown as WatcherRunner
  const status = new WatcherRunnerStatusLifecycle({
    ledgerStore,
    persistEnabled: (runnerArg, enabled) => ({ ...runnerArg.enrollment, enabled }),
    persistTerminal: async (runnerArg) => runnerArg.enrollment,
    now: () => 100,
    createId: () => `event-${(nextId += 1)}`,
    publish: () => {}
  })
  return { status, runner, entries }
}

function parkWorkerQuestionEntry(status: 'open' | 'acknowledged'): LedgerEntry {
  return {
    kind: 'escalation',
    eventId: 'event-park-question',
    watcherId: 'watcher-1',
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    escalationId: 'park:watcher-1:worker-question:message-1',
    escalationKind: 'park-worker-question',
    status,
    foldCount: 1
  }
}

function isConsumedMarker(entry: LedgerEntry): entry is Extract<LedgerEntry, { kind: 'evidence' }> {
  return (
    entry.kind === 'evidence' && entry.evidenceKind === WORKER_ESCALATION_CONSUMED_EVIDENCE_KIND
  )
}

function consumedMarkers(
  entries: readonly LedgerEntry[]
): readonly WorkerEscalationConsumedPayload[] {
  return entries.filter(isConsumedMarker).flatMap((entry) => {
    const messageId = workerEscalationConsumedMessageId(entry.payload)
    return messageId === null ? [] : [{ messageId }]
  })
}

describe('WatcherRunnerStatusLifecycle worker-escalation consumption marker', () => {
  it('parkForWorkerEscalation writes a consumption marker for the escalated message', () => {
    const { status, runner, entries } = harness()
    const escalationId = 'worker-escalation:dispatch-1:message-1'
    status.parkForWorkerEscalation(runner, escalationId, 'Blocked', 'message-1')
    expect(consumedMarkers(entries)).toEqual([{ messageId: 'message-1' }])
  })

  it('park writes the same marker shape for a worker-escalation stop-predicate park', () => {
    const { status, runner, entries } = harness()
    status.park(runner, {
      kind: 'stop-predicate',
      predicateId: 'worker-escalation',
      reason: 'Agent exited unexpectedly',
      messageId: 'message-1'
    })
    expect(consumedMarkers(entries)).toEqual([{ messageId: 'message-1' }])
  })

  it('does not write a marker for a stop-predicate park with no message id', () => {
    const { status, runner, entries } = harness()
    status.park(runner, {
      kind: 'stop-predicate',
      predicateId: 'objective-bar-reached',
      reason: 'files-on-disk landing bar reached'
    })
    expect(consumedMarkers(entries)).toEqual([])
  })

  it('is a no-op if either detector parks again once the watcher is already parked', () => {
    const { status, runner, entries } = harness()
    const escalationId = 'worker-escalation:dispatch-1:message-1'
    status.parkForWorkerEscalation(runner, escalationId, 'Blocked', 'message-1')
    status.park(runner, {
      kind: 'stop-predicate',
      predicateId: 'worker-escalation',
      reason: 'Agent exited unexpectedly',
      messageId: 'message-1'
    })
    expect(consumedMarkers(entries)).toEqual([{ messageId: 'message-1' }])
  })
})

describe('WatcherRunnerStatusLifecycle.park reason', () => {
  it('describes a stop-predicate park with its persisted reason, not the bare kind', () => {
    const { status, runner, entries } = harness()
    status.park(runner, {
      kind: 'stop-predicate',
      predicateId: 'objective-bar-reached',
      reason: 'files-on-disk landing bar reached'
    })
    expect(runner.status.reason).toBe('files-on-disk landing bar reached')
    const parkEntry = entries.find((entry) => entry.kind === 'escalation')
    expect(parkEntry).toMatchObject({ reason: 'files-on-disk landing bar reached' })
  })

  it('falls back to the bare kind for a budget park', () => {
    const { status, runner, entries } = harness()
    status.park(runner, { kind: 'budget', exhaustion: { kind: 'turns' } })
    expect(runner.status.reason).toBe('budget')
    const parkEntry = entries.find((entry) => entry.kind === 'escalation')
    expect(parkEntry).toMatchObject({ reason: 'budget' })
  })
})

describe('WatcherRunnerStatusLifecycle.readyToResume', () => {
  it('persists enabled and folds the park-worker-question escalation to resolved', () => {
    const { status, runner, entries } = harness({
      enabled: false,
      entries: [parkWorkerQuestionEntry('acknowledged')]
    })
    status.readyToResume(runner, 'park-worker-question')
    expect(runner.enrollment.enabled).toBe(true)
    expect(runner.status).toMatchObject({ enabled: true, state: 'watching', phase: 'resumed' })
    const folded = entries.findLast(
      (entry) => entry.kind === 'escalation' && entry.escalationKind === 'park-worker-question'
    )
    expect(folded).toMatchObject({ status: 'resolved', foldCount: 2 })
  })

  it('is provable from the ledger alone: a fresh read shows no open park after resuming', () => {
    const { status, runner, entries } = harness({
      enabled: false,
      entries: [parkWorkerQuestionEntry('acknowledged')]
    })
    status.readyToResume(runner, 'park-worker-question')
    expect(entries.some((entry) => entry.kind === 'escalation' && entry.status === 'open')).toBe(
      false
    )
  })

  it('is idempotent: a second call once already enabled appends nothing further', () => {
    const { status, runner, entries } = harness({
      enabled: false,
      entries: [parkWorkerQuestionEntry('acknowledged')]
    })
    status.readyToResume(runner, 'park-worker-question')
    const countAfterFirstCall = entries.length
    status.readyToResume(runner, 'park-worker-question')
    expect(entries).toHaveLength(countAfterFirstCall)
  })

  it('does nothing durable when there is no park-worker-question escalation to fold', () => {
    const { status, runner, entries } = harness({ enabled: false, entries: [] })
    status.readyToResume(runner, 'park-worker-question')
    expect(runner.enrollment.enabled).toBe(true)
    expect(entries).toHaveLength(0)
  })
})
