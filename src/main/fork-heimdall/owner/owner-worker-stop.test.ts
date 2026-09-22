import { describe, expect, it, vi } from 'vitest'
import { getLatestEscalations } from '../../../shared/fork-heimdall/ledger-queries'
import type { LedgerEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import { recordDeviation, type DeviationRecordDependencies } from './deviation-ledger'
import { applyOwnerWorkerStop } from './owner-worker-stop'

function ledgerHarness() {
  const entries: LedgerEntry[] = [
    {
      kind: 'attempt',
      eventId: 'attempt-event',
      watcherId: 'watcher-1',
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      attemptId: 'attempt-1',
      fingerprint: 'fingerprint-1',
      action: {
        kind: 'dispatch-node',
        capability: 'write',
        visibility: 'local',
        contentIdentity: 'revision-1',
        evidenceKey: 'task-a',
        taskKey: 'task-a'
      },
      state: 'running',
      dispatchId: 'dispatch-1'
    }
  ]
  let sequence = 0
  const ledgerRecord: DeviationRecordDependencies = {
    ledgerStore: {
      read: (): WatcherLedger => ({ watcherId: 'watcher-1', entries: [...entries] }),
      append: (_watcherId, entry) => entries.push(entry)
    },
    now: () => 10 + sequence,
    createId: () => `event-${++sequence}`
  }
  const pending = recordDeviation(ledgerRecord, 'watcher-1', {
    kind: 'stall',
    what: 'dispatch-node',
    dispatchId: 'dispatch-1',
    taskKey: 'task-a',
    inFlightSinceMs: 1,
    thresholdMs: 2
  })
  return { entries, ledgerRecord, pending }
}

describe('applyOwnerWorkerStop', () => {
  it('stops only the active named dispatch and resolves after host confirmation', async () => {
    const world = ledgerHarness()
    const stopWorker = vi.fn(async () => ({ status: 'applied' as const, appliedAtMs: 20 }))

    await applyOwnerWorkerStop({
      watcherId: 'watcher-1',
      pending: world.pending,
      move: { kind: 'stop-worker', dispatchId: 'dispatch-1', rationale: 'Worker is stalled' },
      lease: {
        epoch: 1,
        holder: 'holder-1',
        assertHeld: async () => {},
        renewLoop: () => ({ dispose: () => {} })
      },
      ledgerRecord: world.ledgerRecord,
      stopWorker
    })

    expect(stopWorker).toHaveBeenCalledWith('dispatch-1')
    expect(getLatestEscalations({ watcherId: 'watcher-1', entries: world.entries })).toContainEqual(
      expect.objectContaining({ escalationId: world.pending.escalationId, status: 'resolved' })
    )
  })

  it('escalates an unknown dispatch without issuing a host stop', async () => {
    const world = ledgerHarness()
    const stopWorker = vi.fn()

    await applyOwnerWorkerStop({
      watcherId: 'watcher-1',
      pending: world.pending,
      move: { kind: 'stop-worker', dispatchId: 'dispatch-other', rationale: 'Stop this worker' },
      lease: {
        epoch: 1,
        holder: 'holder-1',
        assertHeld: async () => {},
        renewLoop: () => ({ dispose: () => {} })
      },
      ledgerRecord: world.ledgerRecord,
      stopWorker
    })

    expect(stopWorker).not.toHaveBeenCalled()
    expect(getLatestEscalations({ watcherId: 'watcher-1', entries: world.entries })).toContainEqual(
      expect.objectContaining({ escalationId: world.pending.escalationId, status: 'escalated' })
    )
  })

  it('escalates a refused targeted stop without resolving the dispatch deviation', async () => {
    const world = ledgerHarness()
    const stopWorker = vi.fn(async () => ({
      status: 'refused' as const,
      reason: 'worker-unverifiable' as const,
      detail: 'worker ownership changed'
    }))

    await applyOwnerWorkerStop({
      watcherId: 'watcher-1',
      pending: world.pending,
      move: { kind: 'stop-worker', dispatchId: 'dispatch-1', rationale: 'Worker is stalled' },
      lease: {
        epoch: 1,
        holder: 'holder-1',
        assertHeld: async () => {},
        renewLoop: () => ({ dispose: () => {} })
      },
      ledgerRecord: world.ledgerRecord,
      stopWorker
    })

    expect(stopWorker).toHaveBeenCalledWith('dispatch-1')
    expect(getLatestEscalations({ watcherId: 'watcher-1', entries: world.entries })).toContainEqual(
      expect.objectContaining({ escalationId: world.pending.escalationId, status: 'escalated' })
    )
  })
})
