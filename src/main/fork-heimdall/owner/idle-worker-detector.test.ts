import { describe, expect, it } from 'vitest'
import type {
  AttemptEntry,
  EscalationEntry,
  EvidenceEntry,
  LedgerEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import { DeviationSchema, type StallDeviation } from '../../../shared/fork-heimdall/owner/deviation'
import type { WorkerIdleObservation } from '../orchestration/orchestration-contract'
import { decodeOwnerDeviation, recordDeviation, resolveDeviation } from './deviation-ledger'
import {
  detectIdleStall,
  idleStallCandidateDispatchIds,
  OWNER_IDLE_GRACE_MS
} from './idle-worker-detector'

function runningAttempt(dispatchId = 'dispatch-1', atMs = 0): AttemptEntry {
  return {
    eventId: `attempt-event-${dispatchId}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: `attempt-${dispatchId}`,
    fingerprint: `fp-${dispatchId}`,
    action: {
      kind: 'dispatch-node',
      capability: 'write',
      visibility: 'local',
      contentIdentity: 'revision-1',
      evidenceKey: `evidence-${dispatchId}`,
      taskKey: `task-${dispatchId}`
    },
    state: 'running',
    dispatchId
  }
}

function mail(type: string, atMs: number, dispatchId = 'dispatch-1'): EvidenceEntry {
  return {
    eventId: `mail-${type}-${atMs}`,
    watcherId: 'watcher-1',
    atMs,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    payload: { type, payload: JSON.stringify({ dispatchId }) }
  }
}

function escalation(escalationKind: string, escalationId: string): EscalationEntry {
  return {
    eventId: `escalation-${escalationId}`,
    watcherId: 'watcher-1',
    atMs: 5,
    origin: 'owner',
    class: 'fact',
    kind: 'escalation',
    escalationId,
    escalationKind,
    status: 'open',
    foldCount: 1
  }
}

function idle(
  idleSinceMs: number,
  text: string | null = 'Should I keep going?'
): WorkerIdleObservation {
  return {
    status: 'idle',
    activity: 'waiting',
    idleSinceMs,
    lastMessage: text === null ? null : { text, truncated: false }
  }
}

function memoryLedger(entries: LedgerEntry[]) {
  const list = [...entries]
  let ids = 0
  let clock = 1_000_000
  return {
    ledgerStore: {
      read: (watcherId: string): WatcherLedger => ({ watcherId, entries: list }),
      append: (_watcherId: string, entry: LedgerEntry) => {
        list.push(entry)
      }
    },
    now: () => ++clock,
    createId: () => `event-${++ids}`,
    ledger: (): WatcherLedger => ({ watcherId: 'watcher-1', entries: list })
  }
}

const observations = (entries: Record<string, WorkerIdleObservation>) =>
  new Map(Object.entries(entries))

describe('detectIdleStall', () => {
  it('waits out the grace window and reports when it ends', () => {
    const result = detectIdleStall({
      ledger: { watcherId: 'watcher-1', entries: [runningAttempt()] },
      nowMs: 100_000 + 30_000,
      observations: observations({ 'dispatch-1': idle(100_000) })
    })
    expect(result.stalls).toEqual([])
    expect(result.recheckInMs).toBe(OWNER_IDLE_GRACE_MS - 30_000)
  })

  it('raises an idle stall carrying the last message once the grace window has passed', () => {
    const result = detectIdleStall({
      ledger: { watcherId: 'watcher-1', entries: [runningAttempt('dispatch-1', 50)] },
      nowMs: 100_000 + OWNER_IDLE_GRACE_MS,
      observations: observations({ 'dispatch-1': idle(100_000) })
    })
    expect(result.recheckInMs).toBeNull()
    expect(result.stalls.map((detected) => detected.stall)).toEqual([
      {
        kind: 'stall',
        what: 'dispatch-node',
        dispatchId: 'dispatch-1',
        taskKey: 'task-dispatch-1',
        inFlightSinceMs: 50,
        thresholdMs: OWNER_IDLE_GRACE_MS,
        trigger: 'idle',
        idleSinceMs: 100_000,
        lastMessage: 'Should I keep going?',
        messageTruncated: false
      }
    ])
    expect(DeviationSchema.safeParse(result.stalls[0]!.stall).success).toBe(true)
  })

  it.each([
    ['active', { status: 'active' } as const],
    [
      'unavailable (SSH or unverifiable)',
      { status: 'unavailable', reason: 'remote worker' } as const
    ]
  ])('never treats an %s worker as idle', (_label, observation) => {
    const result = detectIdleStall({
      ledger: { watcherId: 'watcher-1', entries: [runningAttempt()] },
      nowMs: 10 * OWNER_IDLE_GRACE_MS,
      observations: observations({ 'dispatch-1': observation })
    })
    expect(result).toEqual({ stalls: [], recheckInMs: null })
  })

  it.each(['worker_done', 'question', 'escalation'])(
    'stays quiet when the worker sent %s mail after going idle',
    (type) => {
      const result = detectIdleStall({
        ledger: {
          watcherId: 'watcher-1',
          entries: [runningAttempt(), mail(type, 100_500)]
        },
        nowMs: 100_000 + OWNER_IDLE_GRACE_MS,
        observations: observations({ 'dispatch-1': idle(100_000) })
      })
      expect(result.stalls).toEqual([])
    }
  )

  it('ignores a heartbeat and mail from before the idle episode', () => {
    const result = detectIdleStall({
      ledger: {
        watcherId: 'watcher-1',
        entries: [runningAttempt(), mail('question', 99_000), mail('heartbeat', 100_500)]
      },
      nowMs: 100_000 + OWNER_IDLE_GRACE_MS,
      observations: observations({ 'dispatch-1': idle(100_000) })
    })
    expect(result.stalls).toHaveLength(1)
  })

  it.each([
    ['an open worker question', escalation('worker-question', 'worker-question:dispatch-1:msg-1')],
    [
      'an open worker escalation',
      escalation('worker-escalation', 'worker-escalation:dispatch-1:msg-1')
    ]
  ])('is suppressed by %s', (_label, entry) => {
    const ledger = { watcherId: 'watcher-1', entries: [runningAttempt(), entry] }
    expect(idleStallCandidateDispatchIds(ledger)).toEqual([])
    const result = detectIdleStall({
      ledger,
      nowMs: 100_000 + OWNER_IDLE_GRACE_MS,
      observations: observations({ 'dispatch-1': idle(100_000) })
    })
    expect(result.stalls).toEqual([])
  })

  it('is suppressed by an open deviation for the dispatch and re-raises only for a newer episode', () => {
    const memory = memoryLedger([runningAttempt()])
    const first = detectIdleStall({
      ledger: memory.ledger(),
      nowMs: 100_000 + OWNER_IDLE_GRACE_MS,
      observations: observations({ 'dispatch-1': idle(100_000) })
    })
    const recorded = recordDeviation(memory, 'watcher-1', first.stalls[0]!.stall)
    const whileOpen = detectIdleStall({
      ledger: memory.ledger(),
      nowMs: 100_000 + 2 * OWNER_IDLE_GRACE_MS,
      observations: observations({ 'dispatch-1': idle(100_000) })
    })
    expect(whileOpen.stalls).toEqual([])

    resolveDeviation(memory, 'watcher-1', recorded)
    const sameEpisode = detectIdleStall({
      ledger: memory.ledger(),
      nowMs: 100_000 + 3 * OWNER_IDLE_GRACE_MS,
      observations: observations({ 'dispatch-1': idle(100_000) })
    })
    expect(sameEpisode.stalls).toEqual([])

    const newerEpisode = detectIdleStall({
      ledger: memory.ledger(),
      nowMs: 500_000 + OWNER_IDLE_GRACE_MS,
      observations: observations({ 'dispatch-1': idle(500_000) })
    })
    expect(newerEpisode.stalls.map((detected) => detected.stall.idleSinceMs)).toEqual([500_000])
  })

  it('omits the message when none could be read', () => {
    const result = detectIdleStall({
      ledger: { watcherId: 'watcher-1', entries: [runningAttempt()] },
      nowMs: 100_000 + OWNER_IDLE_GRACE_MS,
      observations: observations({ 'dispatch-1': idle(100_000, null) })
    })
    expect(result.stalls[0]!.stall).not.toHaveProperty('lastMessage')
  })
})

describe('stall deviation records', () => {
  it('decodes a record written before the idle fields existed', () => {
    const legacy: StallDeviation = {
      kind: 'stall',
      what: 'dispatch-node',
      dispatchId: 'dispatch-1',
      inFlightSinceMs: 0,
      thresholdMs: 900_000
    }
    const memory = memoryLedger([])
    const recorded = recordDeviation(memory, 'watcher-1', legacy)
    expect(decodeOwnerDeviation(recorded)).toEqual(legacy)
  })

  it('rejects a last message over the 4 KiB bound', () => {
    const parsed = DeviationSchema.safeParse({
      kind: 'stall',
      what: 'dispatch-node',
      dispatchId: 'dispatch-1',
      inFlightSinceMs: 0,
      thresholdMs: 1,
      trigger: 'idle',
      lastMessage: 'x'.repeat(4097)
    })
    expect(parsed.success).toBe(false)
  })
})
