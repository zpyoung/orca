import { describe, expect, it, vi } from 'vitest'
import type { DispatchResult, ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import {
  node,
  projection,
  snapshot
} from '../../shared/fork-heimdall-objective/decision-test-harness'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { ObjectiveEnrollmentPayload } from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import { dispatchObjectiveWorker, saveDispatchFailure } from './dispatch-worker-launch'
import type { ObjectiveStore } from './objective-store'
import type { PreparedObjectiveDispatchWorkspace } from './dispatch-worktree'

function context(dispatchResult: DispatchResult): ExecuteContext<ObjectiveWorld> {
  return {
    snapshot: snapshot(projection({ revisions: [], nodes: [node('node-a')] })),
    lease: {
      epoch: 1,
      holder: 'test',
      assertHeld: vi.fn(async () => undefined),
      renewLoop: () => ({ dispose: () => undefined })
    },
    ledger: { watcherId: 'watcher-1', entries: [] },
    dispatchWorker: vi.fn(async () => dispatchResult)
  }
}

function objectiveStore(overrides: Partial<ObjectiveStore> = {}): ObjectiveStore {
  const store = {
    saveDispatch: vi.fn(),
    listDispatches: vi.fn(() => []),
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ObjectiveStore is a class with private fields, so a structural test double can never satisfy it without this cast; only the overridden methods above are ever invoked by the code under test.
  return store as unknown as ObjectiveStore
}

function preparedWorkspace(
  overrides: Partial<ObjectiveDispatchRecord> = {}
): PreparedObjectiveDispatchWorkspace {
  return {
    record: {
      attemptFingerprint: 'attempt-node-a',
      watcherId: 'watcher-1',
      executionHostId: 'local',
      revisionId: 'revision-1',
      taskKey: 'node-a',
      planTaskDigest: 'plan-digest-node-a',
      workspaceId: 'workspace-node-a',
      workspacePath: '/workspaces/node-a',
      baseCommit: 'base-commit',
      laneTaskKeys: ['node-a'],
      sessionNodeCount: 1,
      state: 'applied',
      commitSha: null,
      appliedCommitSha: null,
      reportDigest: null,
      conflictPaths: [],
      conflictingTaskKeys: [],
      conflictingDispatchIds: [],
      createdAtMs: 1,
      completedAtMs: null,
      dispatchId: null,
      terminalHandle: null,
      setupState: 'ready',
      reportPath: null,
      report: null,
      task: {
        taskKey: 'node-a',
        title: 'node-a',
        spec: 'Implement node-a',
        deps: [],
        criteria: [{ body: 'node-a works', shellCheckable: false, checkCommand: null }],
        declaresDependencyChange: false
      },
      ...overrides
    },
    target: {
      kind: 'folder',
      executionHostId: 'local',
      workspacePath: '/workspaces/node-a',
      fileProvider: null
    },
    reuseTerminal: null,
    isolated: true
  }
}

const noLaunch: Pick<ObjectiveEnrollmentPayload, 'roleLaunch'> = {}

describe('saveDispatchFailure', () => {
  it('is a no-op when no workspace was prepared for this attempt', async () => {
    const store = objectiveStore()
    const executeContext = context({ status: 'dispatched', dispatchId: 'dispatch-1' })

    await saveDispatchFailure(store, null, executeContext)

    expect(store.saveDispatch).not.toHaveBeenCalled()
    expect(executeContext.lease.assertHeld).not.toHaveBeenCalled()
  })

  it('marks the prepared dispatch record failed and retains its setup', async () => {
    const store = objectiveStore()
    const executeContext = context({ status: 'dispatched', dispatchId: 'dispatch-1' })
    const prepared = preparedWorkspace()

    await saveDispatchFailure(store, prepared, executeContext)

    expect(store.saveDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ state: 'failed', setupState: 'retained' })
    )
  })
})

describe('dispatchObjectiveWorker', () => {
  it('sends the resolved role launch merged with the base worker request', async () => {
    const executeContext = context({ status: 'dispatched', dispatchId: 'dispatch-1' })

    await dispatchObjectiveWorker({
      context: executeContext,
      objectiveStore: objectiveStore(),
      request: { role: 'implementer', spec: 'do the task', taskKey: 'node-a', deps: [] },
      agent: 'claude',
      contract: { roleLaunch: { implementer: { model: 'opus', effort: 'high' } } },
      prepared: null,
      serialReuseTerminal: null,
      reportPath: '/reports/node-a.json'
    })

    expect(executeContext.dispatchWorker).toHaveBeenCalledWith({
      spec: 'do the task',
      agent: 'claude',
      taskKey: 'node-a',
      deps: [],
      model: 'opus',
      effort: 'high'
    })
  })

  it('omits model and effort when the role has no launch override', async () => {
    const executeContext = context({ status: 'dispatched', dispatchId: 'dispatch-1' })

    await dispatchObjectiveWorker({
      context: executeContext,
      objectiveStore: objectiveStore(),
      request: { role: 'implementer', spec: 'do the task' },
      agent: 'claude',
      contract: noLaunch,
      prepared: null,
      serialReuseTerminal: null,
      reportPath: '/reports/node-a.json'
    })

    const call = vi.mocked(executeContext.dispatchWorker).mock.calls[0][0]
    expect(call).not.toHaveProperty('model')
    expect(call).not.toHaveProperty('effort')
  })

  it('marks the dispatch failed and reports infra when the transport throws', async () => {
    const executeContext = context({ status: 'dispatched', dispatchId: 'dispatch-1' })
    executeContext.dispatchWorker = vi.fn(async () => {
      throw new Error('transport unreachable')
    })
    const store = objectiveStore()
    const prepared = preparedWorkspace()

    const outcome = await dispatchObjectiveWorker({
      context: executeContext,
      objectiveStore: store,
      request: { role: 'implementer', spec: 'do the task' },
      agent: 'claude',
      contract: noLaunch,
      prepared,
      serialReuseTerminal: null,
      reportPath: '/reports/node-a.json'
    })

    expect(outcome).toEqual({
      effect: 'not-landed',
      failureClass: 'infra',
      reason: 'transport unreachable'
    })
    expect(store.saveDispatch).toHaveBeenCalledWith(expect.objectContaining({ state: 'failed' }))
  })

  it('reports a refusal as not-landed infra with its detail', async () => {
    const executeContext = context({
      status: 'refused',
      reason: 'fenced',
      detail: 'lease unavailable'
    })

    const outcome = await dispatchObjectiveWorker({
      context: executeContext,
      objectiveStore: objectiveStore(),
      request: { role: 'implementer', spec: 'do the task' },
      agent: 'claude',
      contract: noLaunch,
      prepared: null,
      serialReuseTerminal: null,
      reportPath: '/reports/node-a.json'
    })

    expect(outcome).toEqual({
      effect: 'not-landed',
      failureClass: 'infra',
      reason: 'fenced',
      result: { detail: 'lease unavailable' }
    })
  })

  it('passes an indeterminate result through unchanged', async () => {
    const executeContext = context({ status: 'indeterminate', requestId: 'request-1' })

    const outcome = await dispatchObjectiveWorker({
      context: executeContext,
      objectiveStore: objectiveStore(),
      request: { role: 'implementer', spec: 'do the task' },
      agent: 'claude',
      contract: noLaunch,
      prepared: null,
      serialReuseTerminal: null,
      reportPath: '/reports/node-a.json'
    })

    expect(outcome).toEqual({
      effect: 'indeterminate',
      reason: 'dispatch-indeterminate',
      result: { status: 'indeterminate', requestId: 'request-1' }
    })
  })

  it('lands and marks the prepared record ready with the returned dispatch id', async () => {
    const executeContext = context({ status: 'dispatched', dispatchId: 'dispatch-2' })
    const store = objectiveStore()
    const prepared = preparedWorkspace()

    const outcome = await dispatchObjectiveWorker({
      context: executeContext,
      objectiveStore: store,
      request: { role: 'implementer', spec: 'do the task' },
      agent: 'claude',
      contract: noLaunch,
      prepared,
      serialReuseTerminal: null,
      reportPath: '/reports/node-a.json'
    })

    expect(outcome).toEqual({
      effect: 'landed',
      result: { dispatchId: 'dispatch-2', reportPath: '/reports/node-a.json' }
    })
    expect(store.saveDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ dispatchId: 'dispatch-2', setupState: 'ready' })
    )
  })
})
