import { describe, expect, it, vi } from 'vitest'
import type { LedgerEntry, WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { Snapshot } from '../../shared/fork-heimdall/snapshot'
import type { StopPredicate } from '../../shared/fork-heimdall/stop-policy'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { findOldestOpenOwnerDeviation } from './owner/deviation-ledger'
import { WatcherRunnerStopLifecycle } from './runner-stop-lifecycle'
import type { WatcherRunner } from './runner-state'
import type { WatcherRunnerStatusLifecycle } from './runner-status'

type World = { revision: string }

function memoryLedgerStore(): {
  read(watcherId: string): WatcherLedger
  append(watcherId: string, entry: LedgerEntry): void
} {
  const byWatcher = new Map<string, LedgerEntry[]>()
  return {
    read: (watcherId) => ({ watcherId, entries: byWatcher.get(watcherId) ?? [] }),
    append: (watcherId, entry) => {
      const list = byWatcher.get(watcherId) ?? []
      list.push(entry)
      byWatcher.set(watcherId, list)
    }
  }
}

function buildRunner(args: {
  stopPredicates: readonly StopPredicate<World>[]
  owner?: { agent: 'claude' }
}): WatcherRunner {
  const enrollment: WatcherEnrollment = {
    watcherId: 'watcher-1',
    kind: 'hosted-review',
    workspaceKey: 'local::/repo',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath: '/repo',
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'coordinator-pane' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null,
    ...(args.owner ? { owner: args.owner } : {})
  }
  return {
    enrollment,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherRunnerStopLifecycle.evaluate only reads kind.stopPredicates here; RegisteredWatcherKind's identity/decision/execution methods are unused in this fixture.
    kind: { stopPredicates: args.stopPredicates } as unknown as WatcherRunner['kind'],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this suite never reads runner.status; WatcherStatus's full schema shape is unused here.
    status: {} as WatcherRunner['status'],
    timer: null,
    operationTail: Promise.resolve(),
    tickQueued: false,
    reconcileAgain: false,
    stopped: false,
    suspended: false,
    controlPending: null,
    recovered: false,
    forceFresh: false,
    consecutiveErrors: 0,
    consecutiveGateHolds: 0,
    lastFullResyncAtMs: null,
    lastSnapshot: null,
    traceSequence: 0,
    traces: [],
    leaseGuard: {
      epoch: 1,
      holder: 'test-holder',
      assertHeld: async () => {},
      renewLoop: () => ({ dispose: () => {} })
    },
    leaseRenewal: null,
    ownerBudgetInterval: null
  }
}

const snapshot: Snapshot<World> = {
  freshness: 'live',
  contentIdentity: 'revision-1',
  observedAtMs: 1,
  world: { revision: 'revision-1' }
}

const ownerRoutablePredicate: StopPredicate<World> = {
  id: 'infra-retry-exhausted',
  evaluate: () => ({ stop: true, reason: 'retried too many times' }),
  deviationForFiring: () => ({
    kind: 'retry-exhausted',
    taskKey: 'task-1',
    retryCount: 3,
    lastFailureClass: null
  })
}

const plainParkPredicate: StopPredicate<World> = {
  id: 'plain-park',
  evaluate: () => ({ stop: true, reason: 'something else stopped it' })
}

describe('WatcherRunnerStopLifecycle: owner-routable predicates', () => {
  it('records a deviation instead of parking when an owner is configured', async () => {
    const ledgerStore = memoryLedgerStore()
    const park = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherRunnerStopLifecycle only calls status.park/status.terminal; the class's private dependencies field makes any plain object double require a cast, and no other public method is exercised here.
    const statusLifecycle = { park, terminal: vi.fn() } as unknown as WatcherRunnerStatusLifecycle
    const stopLifecycle = new WatcherRunnerStopLifecycle(statusLifecycle, {
      ledgerStore,
      now: () => 100,
      createId: () => 'event-1'
    })
    const runner = buildRunner({
      stopPredicates: [ownerRoutablePredicate],
      owner: { agent: 'claude' }
    })

    const outcome = await stopLifecycle.evaluate(runner, snapshot, ledgerStore.read('watcher-1'))

    expect(outcome).toBe('clear')
    expect(park).not.toHaveBeenCalled()
    const pending = findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))
    expect(pending).not.toBeNull()
  })

  it('parks exactly as before when no owner is configured, even for an opted-in predicate', async () => {
    const ledgerStore = memoryLedgerStore()
    const park = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherRunnerStopLifecycle only calls status.park/status.terminal; the class's private dependencies field makes any plain object double require a cast, and no other public method is exercised here.
    const statusLifecycle = { park, terminal: vi.fn() } as unknown as WatcherRunnerStatusLifecycle
    const stopLifecycle = new WatcherRunnerStopLifecycle(statusLifecycle, {
      ledgerStore,
      now: () => 100,
      createId: () => 'event-1'
    })
    const runner = buildRunner({ stopPredicates: [ownerRoutablePredicate] })

    const outcome = await stopLifecycle.evaluate(runner, snapshot, ledgerStore.read('watcher-1'))

    expect(outcome).toBe('parked')
    expect(park).toHaveBeenCalledTimes(1)
    expect(findOldestOpenOwnerDeviation(ledgerStore.read('watcher-1'))).toBeNull()
  })

  it('parks as before for a predicate that never opted in, even with an owner configured', async () => {
    const ledgerStore = memoryLedgerStore()
    const park = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherRunnerStopLifecycle only calls status.park/status.terminal; the class's private dependencies field makes any plain object double require a cast, and no other public method is exercised here.
    const statusLifecycle = { park, terminal: vi.fn() } as unknown as WatcherRunnerStatusLifecycle
    const stopLifecycle = new WatcherRunnerStopLifecycle(statusLifecycle, {
      ledgerStore,
      now: () => 100,
      createId: () => 'event-1'
    })
    const runner = buildRunner({ stopPredicates: [plainParkPredicate], owner: { agent: 'claude' } })

    const outcome = await stopLifecycle.evaluate(runner, snapshot, ledgerStore.read('watcher-1'))

    expect(outcome).toBe('parked')
    expect(park).toHaveBeenCalledTimes(1)
  })

  it('does not persist a stop transition when deletion begins during lease validation', async () => {
    const ledgerStore = memoryLedgerStore()
    const park = vi.fn()
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: WatcherRunnerStopLifecycle only calls status.park/status.terminal; the class's private dependencies field makes any plain object double require a cast, and no other public method is exercised here.
    const statusLifecycle = { park, terminal: vi.fn() } as unknown as WatcherRunnerStatusLifecycle
    const stopLifecycle = new WatcherRunnerStopLifecycle(statusLifecycle)
    const runner = buildRunner({ stopPredicates: [plainParkPredicate] })
    let markValidationStarted!: () => void
    const validationStarted = new Promise<void>((resolve) => {
      markValidationStarted = resolve
    })
    let finishValidation!: () => void
    const validationGate = new Promise<void>((resolve) => {
      finishValidation = resolve
    })
    runner.leaseGuard!.assertHeld = async () => {
      markValidationStarted()
      await validationGate
    }

    const evaluation = stopLifecycle.evaluate(runner, snapshot, ledgerStore.read('watcher-1'))
    await validationStarted
    runner.stopped = true
    runner.controlPending = 'delete'
    finishValidation()

    await expect(evaluation).resolves.toBe('quiesced')
    expect(park).not.toHaveBeenCalled()
  })
})
