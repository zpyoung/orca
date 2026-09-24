import { describe, expect, it, vi } from 'vitest'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import { WatcherEnrollmentControlLifecycle } from './control-enrollment-lifecycle'
import { isMalformedKindPayloadEnrollment } from './enrollment-store'
import type { WatcherRunner } from './runner-state'

function enrollment(maxConcurrency: number): WatcherEnrollment {
  return {
    watcherId: 'watcher-1',
    kind: 'objective',
    workspaceKey: 'local::/repo',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    workspacePath: '/repo',
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 1,
    capabilities: { implement: 'on' },
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {
      objectiveText: 'Ship it',
      tier: 'standard',
      landingBar: 'files-on-disk',
      maxConcurrency,
      workspaceKind: 'git',
      writeTerritory: ['**'],
      roleAgents: {},
      sitterOverrides: {}
    },
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  }
}

describe('WatcherEnrollmentControlLifecycle.resume', () => {
  it('resyncs an already-enabled, unpaused watcher instead of refusing it', () => {
    const current = enrollment(1)
    const runner = {
      enrollment: current,
      status: { phase: 'lease-refused', reason: 'stale' }
    } as unknown as WatcherRunner
    const commit = vi.fn()
    const schedule = vi.fn()
    const read = vi.fn(() => ({ watcherId: 'watcher-1', entries: [] }))
    const lifecycle = new WatcherEnrollmentControlLifecycle({
      ledger: { read } as never,
      lease: {} as never,
      runnerLoop: { schedule } as never,
      runner: () => runner,
      commit,
      requireValidCommit: () => {
        throw new Error('resume must not commit for an already-enabled, unpaused watcher')
      },
      latestHaltWasAutomaticPark: () => false,
      appendResumeEscalationTransitions: vi.fn(),
      appendDisarmTransitions: vi.fn(),
      now: () => 10
    })

    const result = lifecycle.resume(current, {
      executionHostId: 'local',
      schedulerOwner: 'local_host_service',
      workspaceKey: 'local::/repo',
      revision: 1
    })

    expect(result).toMatchObject({ status: 'applied' })
    expect(commit).not.toHaveBeenCalled()
    expect(runner.enrollment).toBe(current)
    expect(runner.status.phase).not.toBe('lease-refused')
    expect(schedule).toHaveBeenCalledWith(runner, 0)
  })
})

describe('WatcherEnrollmentControlLifecycle concurrency fencing', () => {
  it('waits for the active tick before committing a lower cap', async () => {
    let finishTick!: () => void
    const operationTail = new Promise<void>((resolve) => {
      finishTick = resolve
    })
    const current = enrollment(3)
    const updated = { ...enrollment(1), commandRevision: 2 }
    const runner = {
      enrollment: current,
      operationTail,
      controlPending: null
    } as WatcherRunner
    const commit = vi.fn(() => ({ status: 'committed' as const, enrollment: updated }))
    const schedule = vi.fn()
    const lifecycle = new WatcherEnrollmentControlLifecycle({
      ledger: {} as never,
      lease: {} as never,
      runnerLoop: { schedule } as never,
      runner: () => runner,
      commit,
      requireValidCommit: (result) => {
        if (result.status !== 'committed' || isMalformedKindPayloadEnrollment(result.enrollment)) {
          throw new Error('expected valid committed enrollment')
        }
        return result.enrollment
      },
      latestHaltWasAutomaticPark: () => false,
      appendResumeEscalationTransitions: vi.fn(),
      appendDisarmTransitions: vi.fn(),
      now: () => 10
    })
    const result = lifecycle.setConcurrency(
      current,
      {
        executionHostId: 'local',
        schedulerOwner: 'local_host_service',
        workspaceKey: 'local::/repo',
        revision: 1
      },
      1
    )

    expect(runner.controlPending).toBe('set-concurrency')
    expect(commit).not.toHaveBeenCalled()

    finishTick()
    await expect(result).resolves.toMatchObject({ status: 'applied' })
    expect(commit).toHaveBeenCalledOnce()
    expect(runner.enrollment).toBe(updated)
    expect(runner.controlPending).toBeNull()
    expect(schedule).toHaveBeenCalledWith(runner, 0)
  })
})
