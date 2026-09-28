import { describe, expect, it, vi } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import { WorkerPromptUndeliverableError } from '../orchestration/orchestration-contract'
import { findOldestOpenOwnerDeviation, recordDeviation } from './deviation-ledger'
import { applyOwnerWorkerMessage } from './owner-worker-message'

function world() {
  const entries: LedgerEntry[] = []
  let ids = 0
  const ledgerRecord = {
    ledgerStore: {
      read: (watcherId: string): WatcherLedger => ({ watcherId, entries }),
      append: (_watcherId: string, entry: LedgerEntry) => {
        entries.push(entry)
      }
    },
    now: () => ++ids,
    createId: () => `event-${++ids}`
  }
  const pending = recordDeviation(ledgerRecord, 'watcher-1', {
    kind: 'stall',
    what: 'dispatch-node',
    dispatchId: 'dispatch-1',
    inFlightSinceMs: 0,
    thresholdMs: 1,
    trigger: 'idle',
    idleSinceMs: 0,
    lastMessage: 'Which config should I keep?'
  })
  return { entries, ledgerRecord, pending }
}

const move = { kind: 'message-worker' as const, dispatchId: 'dispatch-1', message: 'Keep both.' }

describe('applyOwnerWorkerMessage', () => {
  it('sends the reply and resolves the stall', async () => {
    const { entries, ledgerRecord, pending } = world()
    const messageWorker = vi.fn(async () => {})

    await expect(
      applyOwnerWorkerMessage({ ledgerRecord, messageWorker }, 'watcher-1', pending, move)
    ).resolves.toBeNull()

    expect(messageWorker).toHaveBeenCalledWith('dispatch-1', 'Keep both.')
    expect(findOldestOpenOwnerDeviation({ watcherId: 'watcher-1', entries })).toBeNull()
  })

  it('hands an undeliverable reply back for a human, leaving the stall open', async () => {
    const { entries, ledgerRecord, pending } = world()
    const messageWorker = vi.fn(async () => {
      throw new WorkerPromptUndeliverableError('dispatch-1', 'worker identity changed')
    })

    const refusal = await applyOwnerWorkerMessage(
      { ledgerRecord, messageWorker },
      'watcher-1',
      pending,
      move
    )

    expect(refusal).toContain('worker identity changed')
    expect(refusal).toContain('Keep both.')
    expect(findOldestOpenOwnerDeviation({ watcherId: 'watcher-1', entries })).not.toBeNull()
  })

  it('lets any other failure propagate so the tick retries', async () => {
    const { ledgerRecord, pending } = world()
    const messageWorker = vi.fn(async () => {
      throw new Error('coordinator seat lost')
    })
    await expect(
      applyOwnerWorkerMessage({ ledgerRecord, messageWorker }, 'watcher-1', pending, move)
    ).rejects.toThrow('coordinator seat lost')
  })
})
