import { expect, it, vi } from 'vitest'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import {
  cleanupAppliedObjectiveDispatch,
  reconcileObjectiveDispatchWorktrees
} from './dispatch-worktree-lifecycle'
import type { ObjectiveStore } from './objective-store'

function appliedDispatch(taskKey: string, workspaceId: string): ObjectiveDispatchRecord {
  return {
    attemptFingerprint: `attempt-${taskKey}`,
    watcherId: 'watcher-1',
    executionHostId: 'local',
    revisionId: 'revision-1',
    taskKey,
    dispatchId: `dispatch-${taskKey}`,
    workspaceId,
    workspacePath: `/workspace/${workspaceId}`,
    baseCommit: 'base-commit',
    laneTaskKeys: [taskKey],
    sessionNodeCount: 1,
    state: 'applied',
    commitSha: `commit-${taskKey}`,
    appliedCommitSha: `applied-${taskKey}`,
    reportDigest: `digest-${taskKey}`,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    planTaskDigest: `plan-digest-${taskKey}`,
    createdAtMs: 1,
    completedAtMs: 2,
    terminalHandle: `terminal-${taskKey}`,
    setupState: 'ready',
    reportPath: `/reports/${taskKey}.json`,
    report: {
      taskKey,
      summary: `Implemented ${taskKey}`,
      filesModified: [`src/${taskKey}.ts`],
      criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified' }]
    },
    task: {
      taskKey,
      title: taskKey,
      spec: `Implement ${taskKey}`,
      deps: [],
      criteria: [{ body: `${taskKey} works`, shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
  }
}

it('retains an unreleased dispatch worktree while cleaning a released sibling worktree', async () => {
  const unsafe = appliedDispatch('unsafe', 'workspace-unsafe')
  const released = appliedDispatch('released', 'workspace-released')
  const records = new Map<string, ObjectiveDispatchRecord>([
    [unsafe.attemptFingerprint, unsafe],
    [released.attemptFingerprint, released]
  ])
  const objectiveStore = {
    getDispatch: (fingerprint: string) => records.get(fingerprint) ?? null,
    listDispatches: () => [...records.values()],
    saveDispatch: (record: ObjectiveDispatchRecord) => {
      records.set(record.attemptFingerprint, record)
      return record
    }
  } as unknown as ObjectiveStore
  const removeManagedWorktree = vi.fn(async () => ({}))
  const runtime = { removeManagedWorktree } as unknown as OrcaRuntimeService
  const lease = { assertHeld: vi.fn(async () => undefined) } as never
  const workerReleaseConfirmed = (dispatchId: string): boolean => dispatchId === released.dispatchId

  await cleanupAppliedObjectiveDispatch({
    runtime,
    objectiveStore,
    record: unsafe,
    lease,
    workerReleaseConfirmed
  })
  await cleanupAppliedObjectiveDispatch({
    runtime,
    objectiveStore,
    record: released,
    lease,
    workerReleaseConfirmed
  })

  expect(removeManagedWorktree).toHaveBeenCalledOnce()
  expect(removeManagedWorktree).toHaveBeenCalledWith(`id:${released.workspaceId}`, {
    force: true,
    hostId: 'local'
  })
  expect(records.get(unsafe.attemptFingerprint)?.setupState).toBe('ready')
  expect(records.get(released.attemptFingerprint)?.setupState).toBe('cleaned')
})

it('marks an absent cleanup-pending child cleaned after exact worker release', async () => {
  const pending = {
    ...appliedDispatch('pending', 'workspace-pending'),
    setupState: 'cleanup-pending' as const
  }
  const records = new Map<string, ObjectiveDispatchRecord>([[pending.attemptFingerprint, pending]])
  const objectiveStore = {
    getDispatch: (fingerprint: string) => records.get(fingerprint) ?? null,
    listDispatches: () => [...records.values()],
    saveDispatch: (record: ObjectiveDispatchRecord) => {
      records.set(record.attemptFingerprint, record)
      return record
    },
    setParallelNote: vi.fn()
  } as unknown as ObjectiveStore
  const removeManagedWorktree = vi.fn(async () => ({}))
  const runtime = {
    listManagedWorktrees: vi.fn(async () => ({ worktrees: [] })),
    removeManagedWorktree
  } as unknown as OrcaRuntimeService

  await reconcileObjectiveDispatchWorktrees({
    runtime,
    binding: {
      enrollment: { watcherId: 'watcher-1', repoId: 'repo-1' }
    } as never,
    objectiveStore,
    lease: { assertHeld: vi.fn(async () => undefined) } as never,
    workerReleaseConfirmed: () => true
  })

  expect(removeManagedWorktree).not.toHaveBeenCalled()
  expect(records.get(pending.attemptFingerprint)).toMatchObject({
    state: 'applied',
    setupState: 'cleaned'
  })
})

it('retains a whole lane workspace when an earlier sibling failed', async () => {
  const current = appliedDispatch('current', 'workspace-lane')
  const failed = {
    ...appliedDispatch('failed', 'workspace-lane'),
    state: 'failed' as const,
    setupState: 'retained' as const
  }
  const records = new Map<string, ObjectiveDispatchRecord>([
    [current.attemptFingerprint, current],
    [failed.attemptFingerprint, failed]
  ])
  const objectiveStore = {
    listDispatches: () => [...records.values()],
    saveDispatch: (record: ObjectiveDispatchRecord) => {
      records.set(record.attemptFingerprint, record)
      return record
    }
  } as unknown as ObjectiveStore
  const removeManagedWorktree = vi.fn(async () => ({}))

  await cleanupAppliedObjectiveDispatch({
    runtime: { removeManagedWorktree } as unknown as OrcaRuntimeService,
    objectiveStore,
    record: current,
    lease: { assertHeld: vi.fn(async () => undefined) } as never,
    workerReleaseConfirmed: () => true
  })

  expect(removeManagedWorktree).not.toHaveBeenCalled()
  expect(records.get(current.attemptFingerprint)?.setupState).toBe('ready')
})

it('requires release only from the latest owner of one warm terminal incarnation', async () => {
  const older = {
    ...appliedDispatch('older', 'workspace-warm'),
    terminalHandle: 'terminal-warm',
    sessionNodeCount: 1
  }
  const latest = {
    ...appliedDispatch('latest', 'workspace-warm'),
    terminalHandle: 'terminal-warm',
    sessionNodeCount: 2
  }
  const records = new Map<string, ObjectiveDispatchRecord>([
    [older.attemptFingerprint, older],
    [latest.attemptFingerprint, latest]
  ])
  const objectiveStore = {
    listDispatches: () => [...records.values()],
    saveDispatch: (record: ObjectiveDispatchRecord) => {
      records.set(record.attemptFingerprint, record)
      return record
    }
  } as unknown as ObjectiveStore
  const removeManagedWorktree = vi.fn(async () => ({}))

  await cleanupAppliedObjectiveDispatch({
    runtime: { removeManagedWorktree } as unknown as OrcaRuntimeService,
    objectiveStore,
    record: latest,
    lease: { assertHeld: vi.fn(async () => undefined) } as never,
    workerReleaseConfirmed: (dispatchId) => dispatchId === latest.dispatchId
  })

  expect(removeManagedWorktree).toHaveBeenCalledOnce()
  expect(records.get(older.attemptFingerprint)?.setupState).toBe('cleaned')
  expect(records.get(latest.attemptFingerprint)?.setupState).toBe('cleaned')
})

it('waits for release of an older distinct terminal before cleaning its successor workspace', async () => {
  const older = appliedDispatch('older-terminal', 'workspace-fresh-session')
  const latest = appliedDispatch('latest-terminal', 'workspace-fresh-session')
  const records = new Map<string, ObjectiveDispatchRecord>([
    [older.attemptFingerprint, older],
    [latest.attemptFingerprint, latest]
  ])
  const objectiveStore = {
    listDispatches: () => [...records.values()],
    saveDispatch: (record: ObjectiveDispatchRecord) => {
      records.set(record.attemptFingerprint, record)
      return record
    }
  } as unknown as ObjectiveStore
  const removeManagedWorktree = vi.fn(async () => ({}))
  const released = new Set([latest.dispatchId])
  const args = {
    runtime: { removeManagedWorktree } as unknown as OrcaRuntimeService,
    objectiveStore,
    record: latest,
    lease: { assertHeld: vi.fn(async () => undefined) } as never,
    workerReleaseConfirmed: (dispatchId: string) => released.has(dispatchId)
  }

  await cleanupAppliedObjectiveDispatch(args)
  expect(removeManagedWorktree).not.toHaveBeenCalled()
  released.add(older.dispatchId)
  await cleanupAppliedObjectiveDispatch(args)

  expect(removeManagedWorktree).toHaveBeenCalledOnce()
  expect(records.get(latest.attemptFingerprint)?.setupState).toBe('cleaned')
})

it('never treats a same-id child on another execution host as the recorded workspace', async () => {
  const record = appliedDispatch('host-bound', 'workspace-shared-id')
  const records = new Map<string, ObjectiveDispatchRecord>([[record.attemptFingerprint, record]])
  const objectiveStore = {
    getDispatch: (fingerprint: string) => records.get(fingerprint) ?? null,
    listDispatches: () => [...records.values()],
    saveDispatch: (saved: ObjectiveDispatchRecord) => {
      records.set(saved.attemptFingerprint, saved)
      return saved
    },
    setParallelNote: vi.fn()
  } as unknown as ObjectiveStore
  const removeManagedWorktree = vi.fn(async () => ({}))
  const runtime = {
    listManagedWorktrees: vi.fn(async () => ({
      worktrees: [
        {
          id: record.workspaceId,
          hostId: 'ssh:other',
          comment: `heimdall-objective-dispatch:${record.watcherId}:${record.attemptFingerprint}`,
          displayName: 'Wrong-host child',
          head: record.baseCommit,
          path: '/remote/wrong-host'
        }
      ]
    })),
    removeManagedWorktree
  } as unknown as OrcaRuntimeService

  await reconcileObjectiveDispatchWorktrees({
    runtime,
    binding: {
      enrollment: {
        watcherId: record.watcherId,
        repoId: 'repo-1',
        executionHostId: 'local'
      }
    } as never,
    objectiveStore,
    lease: { assertHeld: vi.fn(async () => undefined) } as never,
    workerReleaseConfirmed: () => true
  })

  expect(removeManagedWorktree).not.toHaveBeenCalled()
  expect(records.get(record.attemptFingerprint)).toMatchObject({
    state: 'failed',
    setupState: 'retained'
  })
})
