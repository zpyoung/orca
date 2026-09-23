import { describe, expect, it } from 'vitest'
import { decideObjective } from './decision'
import { attempt, ledger, node, projection, snapshot } from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectiveDispatchRecord } from './parallel-types'
import type { ObjectivePlanPatchProjection } from './detail-types'

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
    createdByDispatchId: 'repair-planner-1',
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

function repairDispatch(
  overrides: Partial<Extract<ObjectiveAction, { kind: 'dispatch-planner' }>> = {}
): Extract<ObjectiveAction, { kind: 'dispatch-planner' }> {
  return {
    kind: 'dispatch-planner',
    capability: 'plan',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey: 'plan-repair:revision-1:1',
    revisionNumber: 1,
    reason: 'replan-after-failure',
    shape: 'repair',
    repairOrdinal: 1,
    repairRevisionId: 'revision-1',
    ...overrides
  }
}

describe('decideObjective repair episode, end to end', () => {
  it('dispatches a repair planner for a failed node with no other work in flight', () => {
    const plan = projection({
      nodes: [node('core', { state: 'failed', dispatchId: 'dispatch-core' })]
    })
    const decision = decideObjective(snapshot(plan), ledger())
    expect(decision.action).toMatchObject({
      kind: 'dispatch-planner',
      shape: 'repair',
      repairRevisionId: 'revision-1',
      repairOrdinal: 1,
      reason: 'replan-after-failure'
    })
  })

  it('waits on the running sibling instead of starting a repair planner early', () => {
    const plan = projection({
      nodes: [
        node('failed-task', { state: 'failed', dispatchId: 'dispatch-failed' }),
        node('sibling', { state: 'dispatched', dispatchId: 'dispatch-sibling' })
      ]
    })
    const decision = decideObjective(
      snapshot(plan, {
        parallel: {
          effectiveMaxConcurrency: 2,
          runningCount: 1,
          dispatches: [dispatchRecord('sibling', 'running')]
        }
      }),
      ledger()
    )
    expect(decision).toMatchObject({ action: null, reason: 'node-in-flight' })
  })

  it('still applies a running sibling queued to merge while a node has failed', () => {
    const plan = projection({
      nodes: [
        node('failed-task', { state: 'failed', dispatchId: 'dispatch-failed' }),
        node('sibling', { state: 'dispatched', dispatchId: 'dispatch-sibling' })
      ]
    })
    const queuedToApply = dispatchRecord('sibling', 'waiting-to-apply', {
      commitSha: 'sibling-commit',
      reportDigest: 'sibling-report-digest',
      report: {
        taskKey: 'sibling',
        summary: 'Implemented the sibling task.',
        filesModified: ['src/sibling.ts'],
        criteriaSelfAssessment: []
      }
    })
    const decision = decideObjective(
      snapshot(plan, {
        parallel: { effectiveMaxConcurrency: 2, runningCount: 1, dispatches: [queuedToApply] }
      }),
      ledger()
    )
    expect(decision.action).toMatchObject({
      kind: 'apply-node',
      taskKey: 'sibling',
      dispatchId: 'dispatch-sibling'
    })
  })

  it('emits no new dispatch-node while the repair episode is open, even for an unrelated ready task', () => {
    const plan = projection({
      nodes: [
        node('failed-task', { state: 'failed', dispatchId: 'dispatch-failed' }),
        node('ready-task', { state: 'pending' })
      ]
    })
    const openEpisode = ledger([attempt(repairDispatch(), { dispatchId: 'repair-planner-1' })])
    const decision = decideObjective(snapshot(plan), openEpisode)
    expect(decision.action).toBeNull()
    expect(decision).toMatchObject({ reason: 'planner-in-flight' })
  })

  it('applies the pending repair patch instead of touching node scheduling', () => {
    const plan = {
      ...projection({ nodes: [node('open-task', { state: 'pending' })] }),
      patches: [planPatch({ status: 'pending' })]
    }
    const decision = decideObjective(snapshot(plan), ledger())
    expect(decision.action).toEqual({
      kind: 'apply-plan-patch',
      capability: 'plan',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'patch-1',
      revisionId: 'revision-1',
      patchId: 'patch-1',
      digest: 'patch-digest-1'
    })
  })

  it('resumes node dispatch once the repair patch has applied', () => {
    const plan = {
      ...projection({ nodes: [node('open-task', { state: 'pending' })] }),
      patches: [planPatch({ status: 'applied', resolvedAtMs: 20 })]
    }
    const decision = decideObjective(snapshot(plan), ledger())
    expect(decision.action).toMatchObject({ kind: 'dispatch-node', taskKey: 'open-task' })
  })

  it('never redispatches a succeeded task once its repair has applied', () => {
    const plan = {
      ...projection({
        nodes: [node('done-task', { state: 'succeeded' }), node('open-task', { state: 'pending' })]
      }),
      patches: [planPatch({ status: 'applied', resolvedAtMs: 20 })]
    }
    const decision = decideObjective(snapshot(plan), ledger())
    expect(decision.action).toMatchObject({ kind: 'dispatch-node', taskKey: 'open-task' })
    expect(decision.action).not.toMatchObject({ taskKey: 'done-task' })
  })
})
