import { describe, expect, it, vi } from 'vitest'
import {
  deriveBudgetState,
  HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND
} from '../../../shared/fork-heimdall/budget'
import type { KernelAction } from '../../../shared/fork-heimdall/kind-contract'
import type { LedgerEntry, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherEnrollment } from '../../../shared/fork-heimdall/watcher-types'
import { WatcherLedgerLifecycle } from '../ledger-lifecycle'
import type { HeimdallOrchestrationAdapter } from './orchestration-adapter'
import { orchestrationRequestIdForAttemptFingerprint } from './orchestration-adapter'

const ENROLLMENT = {
  watcherId: 'watcher-1',
  kind: 'hosted-review',
  workspaceKey: 'local::/repo',
  executionHostId: 'local',
  repoId: 'repo-1',
  worktreeId: 'repo-1::/repo',
  workspacePath: '/repo',
  schedulerOwner: 'local_host_service',
  enabled: true,
  paused: false,
  commandRevision: 0,
  capabilities: { fixChecks: 'on' },
  budget: { wallClockActiveMs: null, turns: 10 },
  kindPayload: {},
  coordinatorIdentity: { handle: 'heimdall-coordinator', paneKey: 'heimdall-pane' },
  orchestrationRunId: 'run-1',
  createdAtMs: 1,
  terminalAtMs: null
} as WatcherEnrollment

const ACTION = {
  kind: 'prepare-fix',
  capability: 'fixChecks',
  visibility: 'local',
  contentIdentity: 'head-1',
  evidenceKey: 'check-1'
} as KernelAction

type DispatchAdapter = Pick<HeimdallOrchestrationAdapter, 'dispatchWorker' | 'recoverDispatch'>

function harness(adapter: DispatchAdapter, events: string[] = []) {
  const entries: LedgerEntry[] = []
  const ledgerStore = {
    read: (): WatcherLedger => ({ watcherId: ENROLLMENT.watcherId, entries }),
    append: (_watcherId: string, entry: LedgerEntry) => {
      entries.push(entry)
      events.push(`append:${entry.kind}${entry.kind === 'attempt' ? `:${entry.state}` : ''}`)
    }
  }
  let nextId = 0
  const budgetClock = {
    open: vi.fn((watcherId: string) => ({ watcherId, intervalId: 'worker-interval' })),
    close: vi.fn(),
    current: vi.fn(() => null)
  }
  const lifecycle = new WatcherLedgerLifecycle({
    ledgerStore,
    budgetClock,
    adapter,
    now: () => 100,
    createId: () => `event-${++nextId}`
  })
  return { lifecycle, entries, ledgerStore, budgetClock }
}

function input(fingerprint: string) {
  return {
    enrollment: ENROLLMENT,
    action: ACTION,
    fingerprint,
    spec: 'Fix the check, commit locally, and do not publish.',
    agent: 'codex',
    deps: ['task-plan', 'task-contract'],
    taskKey: 'prepare-fix' as const,
    dispatchKind: 'child' as const
  }
}

describe('Heimdall dispatch write-ahead lifecycle', () => {
  it('durably appends attempted before calling orchestration and leaves no dispatch id on a crash', async () => {
    const events: string[] = []
    const adapter = {
      dispatchWorker: vi.fn(async () => {
        events.push('adapter')
        throw new Error('process crashed after crossing the database boundary')
      }),
      recoverDispatch: vi.fn(async () => ({ status: 'absent' as const }))
    }
    const world = harness(adapter, events)

    await expect(world.lifecycle.dispatch(input('attempt-1'))).rejects.toThrow('process crashed')

    expect(events.slice(0, 2)).toEqual(['append:attempt:attempted', 'adapter'])
    expect(world.entries).toHaveLength(1)
    expect(world.entries[0]).toMatchObject({
      kind: 'attempt',
      state: 'attempted',
      fingerprint: 'attempt-1',
      orchestrationRequestId: orchestrationRequestIdForAttemptFingerprint('attempt-1'),
      dispatch: expect.objectContaining({ deps: ['task-plan', 'task-contract'] })
    })
    expect(world.entries[0]).not.toHaveProperty('dispatchId')
  })

  it('replays a crashed attempt with the same request identity and charges exactly one turn', async () => {
    const adapter = {
      dispatchWorker: vi.fn().mockRejectedValueOnce(new Error('crash')),
      recoverDispatch: vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', dispatchId: 'dispatch-1' } as const)
    }
    const world = harness(adapter)
    await expect(world.lifecycle.dispatch(input('attempt-replay'))).rejects.toThrow('crash')

    const recovered = new WatcherLedgerLifecycle({
      ledgerStore: world.ledgerStore,
      budgetClock: world.budgetClock,
      adapter,
      now: () => 101,
      createId: (() => {
        let id = 100
        return () => `event-${++id}`
      })()
    })
    await recovered.recover(ENROLLMENT)
    await recovered.recover(ENROLLMENT)

    expect(adapter.dispatchWorker).toHaveBeenCalledOnce()
    expect(adapter.recoverDispatch).toHaveBeenCalledOnce()
    expect(adapter.recoverDispatch.mock.calls[0]![0].attemptFingerprint).toBe('attempt-replay')
    expect(adapter.recoverDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ deps: ['task-plan', 'task-contract'] })
    )
    expect(
      world.entries.filter((entry) => entry.kind === 'turn' && entry.dispatchId === 'dispatch-1')
    ).toHaveLength(1)
    expect(
      world.entries.filter(
        (entry) =>
          entry.kind === 'attempt' && entry.state === 'running' && entry.dispatchId === 'dispatch-1'
      )
    ).toHaveLength(1)
    expect(world.budgetClock.open).toHaveBeenCalledOnce()
  })

  it('recovers pre-generation dispatches without charging their late turn or work interval', async () => {
    const adapter = {
      dispatchWorker: vi.fn().mockRejectedValueOnce(new Error('crash')),
      recoverDispatch: vi
        .fn()
        .mockResolvedValue({ status: 'dispatched', dispatchId: 'dispatch-old' } as const)
    }
    const world = harness(adapter)
    await expect(world.lifecycle.dispatch(input('attempt-before-disarm'))).rejects.toThrow('crash')
    world.ledgerStore.append(ENROLLMENT.watcherId, {
      eventId: 'budget-generation',
      watcherId: ENROLLMENT.watcherId,
      atMs: 101,
      origin: 'owner',
      class: 'fact',
      kind: 'evidence',
      evidenceKind: HEIMDALL_BUDGET_GENERATION_EVIDENCE_KIND,
      payload: { reason: 're-enrollment-after-explicit-disarm' }
    })

    const recovered = new WatcherLedgerLifecycle({
      ledgerStore: world.ledgerStore,
      budgetClock: world.budgetClock,
      adapter,
      now: () => 102,
      createId: (() => {
        let id = 100
        return () => `event-${++id}`
      })()
    })
    await recovered.recover(ENROLLMENT)

    expect(world.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        state: 'running',
        dispatchId: 'dispatch-old'
      })
    )
    expect(world.entries).toContainEqual(
      expect.objectContaining({
        kind: 'turn',
        attemptId: expect.any(String),
        dispatchId: 'dispatch-old'
      })
    )
    expect(
      deriveBudgetState(
        { watcherId: ENROLLMENT.watcherId, entries: world.entries },
        ENROLLMENT.budget
      )
    ).toEqual({ activeMs: 0, turns: 0, exhausted: null })
    expect(world.budgetClock.open).not.toHaveBeenCalled()
  })

  it('keeps operation_unknown unresolved and blocks a second dispatch', async () => {
    const adapter = {
      dispatchWorker: vi.fn().mockRejectedValueOnce(new Error('crash')),
      recoverDispatch: vi.fn().mockResolvedValueOnce({
        status: 'indeterminate',
        requestId: orchestrationRequestIdForAttemptFingerprint('attempt-unknown')
      } as const)
    }
    const world = harness(adapter)
    await expect(world.lifecycle.dispatch(input('attempt-unknown'))).rejects.toThrow('crash')
    await world.lifecycle.recover(ENROLLMENT)

    await expect(world.lifecycle.dispatch(input('different-attempt'))).resolves.toEqual({
      status: 'refused',
      reason: 'capability-invalid',
      detail: 'unresolved-attempt'
    })
    expect(adapter.dispatchWorker).toHaveBeenCalledOnce()
    expect(adapter.recoverDispatch).toHaveBeenCalledOnce()
    expect(world.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        fingerprint: 'attempt-unknown',
        state: 'settled',
        effect: 'indeterminate',
        reason: 'operation-unknown'
      })
    )
    expect(world.entries.some((entry) => entry.kind === 'turn')).toBe(false)
    expect(world.budgetClock.open).not.toHaveBeenCalled()
  })

  it('does not charge a turn or open an interval for a refused dispatch', async () => {
    const adapter = {
      dispatchWorker: vi.fn(async () => ({
        status: 'refused' as const,
        reason: 'placement-unavailable' as const,
        detail: 'workspace unavailable'
      })),
      recoverDispatch: vi.fn(async () => ({ status: 'absent' as const }))
    }
    const world = harness(adapter)

    await expect(world.lifecycle.dispatch(input('attempt-refused'))).resolves.toMatchObject({
      status: 'refused'
    })
    expect(world.entries.some((entry) => entry.kind === 'turn')).toBe(false)
    expect(world.budgetClock.open).not.toHaveBeenCalled()
    expect(world.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        state: 'settled',
        effect: 'not-landed',
        reason: 'placement-unavailable'
      })
    )
  })

  it('repairs a crash after charging a turn without charging it twice', async () => {
    const adapter = {
      dispatchWorker: vi.fn(async () => ({
        status: 'dispatched' as const,
        dispatchId: 'dispatch-1'
      })),
      recoverDispatch: vi.fn(async () => ({
        status: 'dispatched' as const,
        dispatchId: 'dispatch-1'
      }))
    }
    const world = harness(adapter)
    const append = world.ledgerStore.append
    world.ledgerStore.append = (_watcherId: string, entry: LedgerEntry) => {
      if (entry.kind === 'attempt' && entry.state === 'running') {
        throw new Error('ledger busy')
      }
      append(_watcherId, entry)
    }

    await expect(world.lifecycle.dispatch(input('turn-crash'))).rejects.toThrow('ledger busy')
    world.ledgerStore.append = append
    await world.lifecycle.recover(ENROLLMENT)

    expect(adapter.dispatchWorker).toHaveBeenCalledOnce()
    expect(adapter.recoverDispatch).toHaveBeenCalledOnce()
    expect(world.entries.filter((entry) => entry.kind === 'turn')).toHaveLength(1)
    expect(world.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        state: 'running',
        attemptId: expect.any(String),
        dispatchId: 'dispatch-1'
      })
    )
    expect(world.budgetClock.open).toHaveBeenCalledOnce()
  })

  it('repairs a legacy running dispatch that has no turn without redispatching it', async () => {
    const adapter = {
      dispatchWorker: vi.fn(),
      recoverDispatch: vi.fn()
    }
    const world = harness(adapter)
    const attempted = {
      eventId: 'attempt-event',
      watcherId: ENROLLMENT.watcherId,
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-legacy',
      fingerprint: 'legacy-fingerprint',
      action: ACTION,
      state: 'attempted',
      dispatch: {
        spec: 'Fix the check.',
        agent: 'codex',
        taskKey: 'prepare-fix',
        dispatchKind: 'child'
      }
    } as const satisfies LedgerEntry
    world.entries.push(attempted, {
      ...attempted,
      eventId: 'running-event',
      state: 'running',
      dispatchId: 'dispatch-legacy'
    })

    await world.lifecycle.recover(ENROLLMENT)

    expect(adapter.dispatchWorker).not.toHaveBeenCalled()
    expect(adapter.recoverDispatch).not.toHaveBeenCalled()
    expect(world.entries.filter((entry) => entry.kind === 'turn')).toHaveLength(1)
  })

  it('restores an indeterminate dispatch receipt to running with its original deps and one turn', async () => {
    const adapter = {
      dispatchWorker: vi.fn(),
      recoverDispatch: vi.fn(async () => ({
        status: 'dispatched' as const,
        dispatchId: 'dispatch-recovered'
      }))
    }
    const world = harness(adapter)
    const writeAhead = {
      eventId: 'attempt-event',
      watcherId: ENROLLMENT.watcherId,
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-unknown',
      fingerprint: 'unknown-fingerprint',
      action: ACTION,
      state: 'attempted',
      dispatch: {
        spec: 'Fix the check.',
        agent: 'codex',
        taskKey: 'prepare-fix',
        deps: ['task-plan'],
        dispatchKind: 'child'
      }
    } as const satisfies LedgerEntry
    world.entries.push(writeAhead, {
      ...writeAhead,
      eventId: 'uncertain-event',
      state: 'settled',
      effect: 'indeterminate',
      reason: 'operation-unknown'
    })

    await world.lifecycle.recover(ENROLLMENT)

    expect(adapter.recoverDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ deps: ['task-plan'], attemptFingerprint: 'unknown-fingerprint' })
    )
    expect(world.entries).toContainEqual(
      expect.objectContaining({
        kind: 'attempt',
        attemptId: 'attempt-unknown',
        state: 'running',
        dispatchId: 'dispatch-recovered'
      })
    )
    const running = world.entries.findLast(
      (entry) => entry.kind === 'attempt' && entry.attemptId === 'attempt-unknown'
    )
    expect(running).not.toHaveProperty('effect')
    expect(world.entries.filter((entry) => entry.kind === 'turn')).toHaveLength(1)
    expect(world.budgetClock.open).toHaveBeenCalledOnce()
  })

  it('resolves an uncertain pre-receipt dispatch when recovery confirms no receipt', async () => {
    const adapter = {
      dispatchWorker: vi.fn(),
      recoverDispatch: vi.fn(async () => ({ status: 'absent' as const }))
    }
    const world = harness(adapter)
    const writeAhead = {
      eventId: 'attempt-event',
      watcherId: ENROLLMENT.watcherId,
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-unknown',
      fingerprint: 'unknown-fingerprint',
      action: ACTION,
      state: 'attempted',
      dispatch: { spec: 'Fix the check.', dispatchKind: 'child' }
    } as const satisfies LedgerEntry
    const unresolved = {
      ...writeAhead,
      eventId: 'uncertain-event',
      state: 'settled',
      effect: 'indeterminate',
      reason: 'operation-unknown'
    } as const satisfies LedgerEntry
    world.entries.push(writeAhead, unresolved)

    await expect(world.lifecycle.recover(ENROLLMENT)).resolves.toEqual([])

    expect(world.entries.at(-1)).toEqual(
      expect.objectContaining({
        kind: 'attempt-resolved',
        attemptId: 'attempt-unknown',
        effect: 'not-landed',
        evidence: { status: 'absent' }
      })
    )
    expect(adapter.dispatchWorker).not.toHaveBeenCalled()
    expect(world.entries.some((entry) => entry.kind === 'turn')).toBe(false)
  })

  it('does not resurrect a worker that exited without completion evidence', async () => {
    const adapter = {
      dispatchWorker: vi.fn(),
      recoverDispatch: vi.fn(async () => ({
        status: 'dispatched' as const,
        dispatchId: 'dispatch-old'
      }))
    }
    const world = harness(adapter)
    const writeAhead = {
      eventId: 'attempt-event',
      watcherId: ENROLLMENT.watcherId,
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-exited',
      fingerprint: 'exited-fingerprint',
      action: ACTION,
      state: 'attempted',
      dispatch: { spec: 'Fix the check.', dispatchKind: 'child' }
    } as const satisfies LedgerEntry
    const running = {
      ...writeAhead,
      eventId: 'running-event',
      state: 'running',
      dispatchId: 'dispatch-old'
    } as const satisfies LedgerEntry
    const exited = {
      ...running,
      eventId: 'exited-event',
      state: 'settled',
      effect: 'indeterminate',
      reason: 'worker-exited-without-completion'
    } as const satisfies LedgerEntry
    world.entries.push(writeAhead, running, exited)

    await expect(world.lifecycle.recover(ENROLLMENT)).resolves.toEqual([])

    expect(adapter.recoverDispatch).not.toHaveBeenCalled()
    expect(world.entries.at(-1)).toEqual(exited)
  })

  it('does not create work while recovering an absent receipt for a disabled watcher', async () => {
    const adapter = {
      dispatchWorker: vi.fn(),
      recoverDispatch: vi.fn(async () => ({ status: 'absent' as const }))
    }
    const world = harness(adapter)
    const seeded = {
      eventId: 'attempt-event',
      watcherId: ENROLLMENT.watcherId,
      atMs: 1,
      origin: 'owner',
      class: 'fact',
      kind: 'attempt',
      attemptId: 'attempt-disabled',
      fingerprint: 'disabled-fingerprint',
      action: ACTION,
      state: 'attempted',
      dispatch: {
        spec: 'Fix the check.',
        agent: 'codex',
        taskKey: 'prepare-fix',
        dispatchKind: 'child'
      }
    } as const satisfies LedgerEntry
    world.entries.push(seeded)

    const absent = await world.lifecycle.recover({ ...ENROLLMENT, enabled: false })

    expect(absent).toEqual([seeded])
    expect(adapter.recoverDispatch).toHaveBeenCalledOnce()
    expect(adapter.dispatchWorker).not.toHaveBeenCalled()
    expect(world.entries).toEqual([seeded])
    expect(world.budgetClock.open).not.toHaveBeenCalled()
  })
})
