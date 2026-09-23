import { describe, expect, it } from 'vitest'
import { attempt, ledger, node, projection, snapshot } from './decision-test-harness'
import { objectiveFrozenTaskKeys, nextObjectiveRepairOrdinal } from './objective-repair-state'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectiveDispatchRecord } from './parallel-types'
import type { ObjectivePlanPatchProjection } from './detail-types'

function dispatchNodeAction(taskKey: string): Extract<ObjectiveAction, { kind: 'dispatch-node' }> {
  return {
    kind: 'dispatch-node',
    capability: 'implement',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey: `revision-1:${taskKey}`,
    revisionId: 'revision-1',
    taskKey,
    depsOrchestrationIds: []
  }
}

function planTask(taskKey: string) {
  return {
    taskKey,
    title: `Task ${taskKey}`,
    spec: `Implement ${taskKey}`,
    deps: [],
    criteria: [{ body: `${taskKey} works`, shellCheckable: false, checkCommand: null }],
    declaresDependencyChange: false
  }
}

function dispatchRecord(
  taskKey: string,
  state: ObjectiveDispatchRecord['state'],
  overrides: Partial<ObjectiveDispatchRecord> = {}
): ObjectiveDispatchRecord {
  return {
    attemptFingerprint: `fingerprint-${taskKey}`,
    watcherId: 'watcher-1',
    executionHostId: 'local',
    revisionId: 'revision-1',
    taskKey,
    dispatchId: `dispatch-${taskKey}`,
    workspaceId: `workspace-${taskKey}`,
    workspacePath: `/workspaces/${taskKey}`,
    baseCommit: 'base-commit',
    laneTaskKeys: [taskKey],
    sessionNodeCount: 1,
    state,
    commitSha: null,
    appliedCommitSha: null,
    reportDigest: null,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    planTaskDigest: `plan-digest-${taskKey}`,
    createdAtMs: 10,
    completedAtMs: null,
    terminalHandle: null,
    setupState: 'ready',
    reportPath: null,
    report: null,
    task: planTask(taskKey),
    ...overrides
  }
}

function planPatch(
  overrides: Partial<ObjectivePlanPatchProjection> = {}
): ObjectivePlanPatchProjection {
  return {
    id: 'patch-1',
    revisionId: 'revision-1',
    createdByDispatchId: 'dispatch-planner-repair-1',
    repairOrdinal: 1,
    digest: 'patch-digest-1',
    status: 'pending',
    rejection: null,
    touchedTaskKeys: [],
    createdAtMs: 10,
    resolvedAtMs: null,
    ...overrides
  }
}

describe('objectiveFrozenTaskKeys', () => {
  it('freezes nodes in a succeeded or dispatched state for the given revision only', () => {
    const plan = projection({
      nodes: [
        node('succeeded-task', { state: 'succeeded' }),
        node('dispatched-task', { state: 'dispatched' }),
        node('pending-task', { state: 'pending' }),
        node('other-revision-task', { state: 'succeeded', revisionId: 'revision-2' })
      ]
    })
    const world = snapshot(plan).world
    const frozen = objectiveFrozenTaskKeys(world, ledger(), 'revision-1')
    expect(frozen).toEqual(new Set(['succeeded-task', 'dispatched-task']))
  })

  it('freezes a task with an unsettled dispatch-node attempt, via objectiveInFlightTaskKeys', () => {
    const plan = projection({ nodes: [node('core')] })
    const world = snapshot(plan).world
    const running = ledger([attempt(dispatchNodeAction('core'), { state: 'running' })])
    expect(objectiveFrozenTaskKeys(world, running, 'revision-1')).toEqual(new Set(['core']))

    const settled = ledger([
      attempt(dispatchNodeAction('core'), { state: 'settled', effect: 'not-landed' })
    ])
    expect(objectiveFrozenTaskKeys(world, settled, 'revision-1')).toEqual(new Set())
  })

  it('freezes a task with a parallel dispatch still running or queued to apply', () => {
    const plan = projection({ nodes: [node('lane-a'), node('lane-b'), node('lane-c')] })
    const world = {
      ...snapshot(plan).world,
      parallel: {
        effectiveMaxConcurrency: 3,
        runningCount: 3,
        dispatches: [
          dispatchRecord('lane-a', 'running'),
          dispatchRecord('lane-b', 'waiting-to-apply'),
          dispatchRecord('lane-c', 'applied')
        ]
      }
    }
    expect(objectiveFrozenTaskKeys(world, ledger(), 'revision-1')).toEqual(
      new Set(['lane-a', 'lane-b'])
    )
  })

  it('ignores a parallel dispatch recorded against a different revision', () => {
    const plan = projection({ nodes: [node('lane-a')] })
    const world = {
      ...snapshot(plan).world,
      parallel: {
        effectiveMaxConcurrency: 1,
        runningCount: 1,
        dispatches: [dispatchRecord('lane-a', 'running', { revisionId: 'revision-2' })]
      }
    }
    expect(objectiveFrozenTaskKeys(world, ledger(), 'revision-1')).toEqual(new Set())
  })
})

describe('nextObjectiveRepairOrdinal', () => {
  it('starts at 1 when the revision has no prior repair attempt or stored patch', () => {
    const world = snapshot(projection()).world
    expect(nextObjectiveRepairOrdinal(world, [], 'revision-1')).toBe(1)
  })

  it('is one past the highest repair ordinal among dispatch-planner attempts for the revision', () => {
    const world = snapshot(projection()).world
    const repairDispatch = (
      ordinal: number
    ): Extract<ObjectiveAction, { kind: 'dispatch-planner' }> => ({
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: `plan:repair:${ordinal}`,
      revisionNumber: 2,
      reason: 'replan-after-block',
      shape: 'repair',
      repairOrdinal: ordinal,
      repairRevisionId: 'revision-1'
    })
    const attempts = [
      { attempt: attempt(repairDispatch(1)), action: repairDispatch(1) },
      { attempt: attempt(repairDispatch(2)), action: repairDispatch(2) },
      // a repair attempt for a different revision never bumps this revision's ordinal
      {
        attempt: attempt({ ...repairDispatch(9), repairRevisionId: 'revision-other' }),
        action: { ...repairDispatch(9), repairRevisionId: 'revision-other' }
      }
    ]
    expect(nextObjectiveRepairOrdinal(world, attempts, 'revision-1')).toBe(3)
  })

  it('is one past the highest repair ordinal among stored plan patches for the revision', () => {
    const world = {
      ...snapshot(projection()).world,
      plan: {
        ...projection(),
        patches: [planPatch({ repairOrdinal: 1 }), planPatch({ repairOrdinal: 4, id: 'patch-2' })]
      }
    }
    expect(nextObjectiveRepairOrdinal(world, [], 'revision-1')).toBe(5)
  })

  it('takes the maximum across both attempts and stored patches', () => {
    const world = {
      ...snapshot(projection()).world,
      plan: { ...projection(), patches: [planPatch({ repairOrdinal: 2 })] }
    }
    const repairDispatch: ObjectiveAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan:repair:7',
      revisionNumber: 2,
      reason: 'replan-after-block',
      shape: 'repair',
      repairOrdinal: 7,
      repairRevisionId: 'revision-1'
    }
    const attempts = [{ attempt: attempt(repairDispatch), action: repairDispatch }]
    expect(nextObjectiveRepairOrdinal(world, attempts, 'revision-1')).toBe(8)
  })
})
