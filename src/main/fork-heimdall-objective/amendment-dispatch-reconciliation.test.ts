import { describe, expect, it, vi } from 'vitest'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import {
  ObjectivePlanTaskSchema,
  type ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import { objectiveResultDigest } from './execution-context'
import { reconcileAmendedObjectiveDispatches } from './amendment-dispatch-reconciliation'
import type { ObjectiveStore } from './objective-store'

const originalTask: ObjectivePlanTask = {
  taskKey: 'task-a',
  title: 'Task A',
  spec: 'Original plan specification',
  deps: [],
  criteria: [{ body: 'A works', shellCheckable: false, checkCommand: null }],
  declaresDependencyChange: false,
  declaredPaths: ['src/a.ts']
}

function dispatch(overrides: Partial<ObjectiveDispatchRecord> = {}): ObjectiveDispatchRecord {
  return {
    attemptFingerprint: 'fingerprint-a',
    watcherId: 'watcher-1',
    executionHostId: 'local',
    revisionId: 'revision-1',
    taskKey: 'task-a',
    dispatchId: 'dispatch-a',
    workspaceId: 'workspace-a',
    workspacePath: '/workspace-a',
    baseCommit: 'base-commit',
    laneTaskKeys: ['task-a'],
    sessionNodeCount: 1,
    state: 'running',
    commitSha: null,
    appliedCommitSha: null,
    reportDigest: null,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    createdAtMs: 1,
    completedAtMs: null,
    terminalHandle: 'terminal-a',
    setupState: 'ready',
    reportPath: null,
    report: null,
    task: originalTask,
    planTaskDigest: objectiveResultDigest(ObjectivePlanTaskSchema.parse(originalTask)),
    ...overrides
  }
}

const ledger: WatcherLedger = { watcherId: 'watcher-1', entries: [] }
const lease: LeaseGuard = {
  epoch: 1,
  holder: 'holder-1',
  assertHeld: async () => {},
  renewLoop: () => ({ dispose: () => {} })
}

function store(args: {
  record: ObjectiveDispatchRecord
  plan?: ObjectivePlanTask[]
  save: (record: ObjectiveDispatchRecord) => void
}): ObjectiveStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
  return {
    listDispatches: () => [args.record],
    getTask: () => originalTask,
    getPlan: () => args.plan ?? [originalTask],
    saveDispatch: args.save
  } as unknown as ObjectiveStore
}

describe('reconcileAmendedObjectiveDispatches', () => {
  it('preserves an owner-amended retry when the original planned task is unchanged', async () => {
    const save = vi.fn()
    const stopWorker = vi.fn(async () => ({ status: 'applied' as const, appliedAtMs: 2 }))
    const amendedRetry = dispatch({
      task: { ...originalTask, spec: 'Owner-corrected dispatch specification' }
    })

    await reconcileAmendedObjectiveDispatches({
      ledger,
      objectiveStore: store({ record: amendedRetry, save }),
      lease,
      stopWorker
    })

    expect(stopWorker).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('ends an applied lane when amendment-derived successors no longer match', async () => {
    const save = vi.fn()
    const replacement: ObjectivePlanTask = {
      ...originalTask,
      taskKey: 'task-c',
      title: 'Task C',
      spec: 'Replacement successor',
      deps: ['task-a'],
      declaredPaths: ['src/c.ts']
    }
    const applied = dispatch({
      state: 'applied',
      laneTaskKeys: ['task-a', 'task-b'],
      commitSha: 'node-commit',
      appliedCommitSha: 'applied-commit',
      reportDigest: 'report-digest',
      completedAtMs: 2
    })

    await reconcileAmendedObjectiveDispatches({
      ledger,
      objectiveStore: store({ record: applied, plan: [originalTask, replacement], save }),
      lease,
      stopWorker: vi.fn(async () => ({ status: 'applied' as const, appliedAtMs: 3 }))
    })

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ laneTaskKeys: ['task-a'] }))
  })
})
