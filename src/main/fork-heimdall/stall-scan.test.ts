import { describe, expect, it, vi } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import type { WorkerIdleObservation } from './orchestration/orchestration-contract'
import { decodeOwnerDeviation, findOldestOpenOwnerDeviation } from './owner/deviation-ledger'
import { OWNER_IDLE_GRACE_MS } from './owner/idle-worker-detector'
import { OWNER_STALL_THRESHOLD_MS } from './owner/stall-detector'
import type { RegisteredWatcherKind } from './registry'
import type { WatcherRunner } from './runner-state'
import { runStallScan, type StallScanDependencies } from './stall-scan'

const IDLE_SINCE_MS = 1_000_000

function runningAttempt(): LedgerEntry {
  return {
    eventId: 'attempt-running',
    watcherId: 'watcher-1',
    atMs: 10,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-1',
    fingerprint: 'fp-1',
    action: {
      kind: 'dispatch-node',
      capability: 'write',
      visibility: 'local',
      contentIdentity: 'revision-1',
      evidenceKey: 'evidence-1'
    },
    state: 'running',
    dispatchId: 'dispatch-1'
  }
}

function runner(args: { owned: boolean; paused?: boolean; isolated?: boolean }): WatcherRunner {
  const enrollment: Partial<WatcherEnrollment> = {
    watcherId: 'watcher-1',
    enabled: true,
    paused: args.paused ?? false,
    ...(args.owned ? { owner: { agent: 'claude' as const } } : {})
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scan reads only enrollment, kind.concurrency, leaseGuard and idleRecheckAtMs.
  return {
    enrollment,
    kind: args.isolated ? { concurrency: { isIsolatedAttempt: () => true } } : {},
    leaseGuard: null,
    idleRecheckAtMs: null
  } as unknown as WatcherRunner & { kind: RegisteredWatcherKind }
}

function scanWorld(observation: WorkerIdleObservation, nowMs: number) {
  const entries: LedgerEntry[] = [runningAttempt()]
  let ids = 0
  const dependencies = {
    ledgerStore: {
      read: (watcherId: string): WatcherLedger => ({ watcherId, entries }),
      append: (_watcherId: string, entry: LedgerEntry) => {
        entries.push(entry)
      }
    },
    orchestration: { observeWorkerIdle: vi.fn(async () => observation) },
    dispatchLifecycle: { pauseWorker: vi.fn() },
    statusLifecycle: { parkForWorkerEscalation: vi.fn() },
    schedule: vi.fn(),
    now: () => nowMs,
    createId: () => `event-${++ids}`,
    stallCause: { consider: vi.fn() }
  }
  return {
    entries,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the scan only calls read/append on the ledger store, which this double implements.
    dependencies: dependencies as unknown as StallScanDependencies & typeof dependencies
  }
}

const idle = (text: string, idleSinceMs = IDLE_SINCE_MS): WorkerIdleObservation => ({
  status: 'idle',
  activity: 'waiting',
  idleSinceMs,
  lastMessage: { text, truncated: false }
})

describe('runStallScan', () => {
  it('records an idle stall with the last message for an owned watcher and consults the judge', async () => {
    const { entries, dependencies } = scanWorld(
      idle('Should I proceed?'),
      IDLE_SINCE_MS + OWNER_IDLE_GRACE_MS
    )
    await runStallScan(dependencies, runner({ owned: true }))

    const pending = findOldestOpenOwnerDeviation({ watcherId: 'watcher-1', entries })
    expect(pending && decodeOwnerDeviation(pending)).toMatchObject({
      kind: 'stall',
      trigger: 'idle',
      dispatchId: 'dispatch-1',
      lastMessage: 'Should I proceed?'
    })
    expect(dependencies.stallCause.consider).toHaveBeenCalledWith(
      expect.objectContaining({ watcherId: 'watcher-1' }),
      { dispatchId: 'dispatch-1', activity: 'waiting', lastMessage: 'Should I proceed?' }
    )
    expect(dependencies.statusLifecycle.parkForWorkerEscalation).not.toHaveBeenCalled()
  })

  it('enriches the silent backstop stall with the last message of an idle worker', async () => {
    const { entries, dependencies } = scanWorld(
      idle('Waiting on you.', OWNER_STALL_THRESHOLD_MS),
      OWNER_STALL_THRESHOLD_MS + 60_000
    )
    await runStallScan(dependencies, runner({ owned: true }))

    const pending = findOldestOpenOwnerDeviation({ watcherId: 'watcher-1', entries })
    const deviation = pending ? decodeOwnerDeviation(pending) : null
    expect(deviation).toMatchObject({ kind: 'stall', lastMessage: 'Waiting on you.' })
    expect(deviation).not.toHaveProperty('trigger')
  })

  it('does nothing while the watcher is paused', async () => {
    const { entries, dependencies } = scanWorld(
      idle('Should I proceed?'),
      IDLE_SINCE_MS + OWNER_IDLE_GRACE_MS
    )
    await runStallScan(dependencies, runner({ owned: false, paused: true }))

    expect(entries).toHaveLength(1)
    expect(dependencies.orchestration.observeWorkerIdle).not.toHaveBeenCalled()
  })

  it('records a dispatch-scoped prose question without parking the watcher', async () => {
    const { entries, dependencies } = scanWorld(
      idle('Which config should I keep?'),
      IDLE_SINCE_MS + OWNER_IDLE_GRACE_MS
    )
    const scoped = runner({ owned: false, isolated: true })
    await runStallScan(dependencies, scoped)
    await runStallScan(dependencies, scoped)

    const escalations = entries.filter(
      (entry) => entry.kind === 'escalation' && entry.escalationKind === 'worker-escalation'
    )
    expect(escalations).toHaveLength(1)
    expect(dependencies.dispatchLifecycle.pauseWorker).toHaveBeenCalledWith(
      'watcher-1',
      'dispatch-1'
    )
    expect(dependencies.statusLifecycle.parkForWorkerEscalation).not.toHaveBeenCalled()
  })
})
