import { describe, expect, it } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { WatcherEnrollment } from '../../shared/fork-heimdall/watcher-types'
import {
  attempt,
  ledger,
  node,
  projection,
  snapshot
} from '../../shared/fork-heimdall-objective/decision-test-harness'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import { bindObjectiveSnapshot, type ObjectiveSnapshotBinding } from './execution-context'
import { createObjectiveConcurrencyPolicy } from './objective-concurrency'

function dispatch(taskKey: string): Extract<ObjectiveAction, { kind: 'dispatch-node' }> {
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

function record(taskKey: string, workspacePath = `/children/${taskKey}`): ObjectiveDispatchRecord {
  const action = dispatch(taskKey)
  return {
    attemptFingerprint: makeAttemptFingerprint(
      action.contentIdentity,
      action.kind,
      action.evidenceKey
    ),
    watcherId: 'watcher-1',
    executionHostId: 'local',
    revisionId: 'revision-1',
    taskKey,
    dispatchId: `dispatch-${taskKey}`,
    workspaceId: `workspace-${taskKey}`,
    workspacePath,
    baseCommit: 'base',
    laneTaskKeys: [taskKey],
    sessionNodeCount: 1,
    state: 'running',
    commitSha: null,
    appliedCommitSha: null,
    reportDigest: null,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    planTaskDigest: `plan-digest-${taskKey}`,
    createdAtMs: 1,
    completedAtMs: null,
    terminalHandle: null,
    setupState: 'ready',
    reportPath: null,
    report: null,
    task: {
      taskKey,
      title: taskKey,
      spec: `Implement ${taskKey}`,
      deps: [],
      criteria: [],
      declaresDependencyChange: false
    }
  }
}

function runGate(
  name: string,
  contentIdentity = 'content-current'
): Extract<ObjectiveAction, { kind: 'run-gate' }> {
  return {
    kind: 'run-gate',
    capability: 'check',
    visibility: 'local',
    contentIdentity,
    evidenceKey: `objective-gate:${name}:${contentIdentity}`,
    gateName: name,
    command: 'pnpm test',
    timeoutSeconds: 900
  }
}

function fixture(records: ObjectiveDispatchRecord[], cap: number) {
  const store = {
    getDispatch: (key: string) => records.find((entry) => entry.attemptFingerprint === key) ?? null,
    listDispatches: () => records
  }
  const world = snapshot(projection({ nodes: ['a', 'b', 'c', 'd'].map((key) => node(key)) }))
  world.world.contract = { ...world.world.contract, maxConcurrency: cap }
  world.world.parallel = {
    effectiveMaxConcurrency: cap,
    runningCount: records.length,
    dispatches: records
  }
  const enrollment: WatcherEnrollment = {
    watcherId: 'watcher-1',
    kind: 'objective',
    workspaceKey: 'local::enrolled',
    executionHostId: 'local',
    repoId: 'repo',
    worktreeId: 'enrolled',
    workspacePath: '/enrolled',
    schedulerOwner: 'local_host_service',
    enabled: true,
    paused: false,
    commandRevision: 0,
    capabilities: { implement: 'on' },
    budget: world.world.budget,
    kindPayload: world.world.contract,
    coordinatorIdentity: { handle: 'coordinator', paneKey: 'pane' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  }
  const bindings = new WeakMap<typeof world, ObjectiveSnapshotBinding>()
  bindObjectiveSnapshot(bindings, world, {
    enrollment,
    contract: world.world.contract,
    target: {
      kind: 'git',
      executionHostId: 'local',
      workspacePath: '/enrolled',
      fileProvider: null
    }
  })
  const policy = createObjectiveConcurrencyPolicy({
    objectiveStore: store,
    snapshotBindings: bindings,
    retainWorker: () => false,
    reconcile: async () => {}
  })
  return { records, world, policy }
}

describe('objective concurrency admission', () => {
  it('admits the final slot after its write-ahead attempt, but refuses an extra node', () => {
    const { policy, world, records } = fixture([record('a'), record('b')], 3)
    const third = dispatch('c')
    const pending = attempt(third, { state: 'attempted' })
    pending.fingerprint = makeAttemptFingerprint(
      third.contentIdentity,
      third.kind,
      third.evidenceKey
    )
    expect(
      policy.canRunAlongside(third, [dispatch('a'), dispatch('b')], world, ledger([pending]))
    ).toBe(true)

    records.push(record('c'))
    world.world.parallel!.runningCount = 3
    expect(
      policy.canRunAlongside(dispatch('d'), [dispatch('a'), dispatch('b'), third], world, ledger())
    ).toBe(false)
  })

  it('drains an isolated child after lowering to one without starting an in-place writer', () => {
    const { policy, world } = fixture([record('a')], 1)
    expect(policy.canRunAlongside(dispatch('b'), [dispatch('a')], world, ledger())).toBe(false)
    const apply: ObjectiveAction = {
      kind: 'apply-node',
      capability: 'implement',
      visibility: 'local',
      recovery: 'replay-safe',
      contentIdentity: 'content-current',
      evidenceKey: 'dispatch-b',
      revisionId: 'revision-1',
      taskKey: 'b',
      dispatchId: 'dispatch-b'
    }
    expect(policy.canRunAlongside(apply, [dispatch('a')], world, ledger())).toBe(true)
  })

  it('never overlaps a writer in the enrolled workspace, even after raising the cap', () => {
    const { policy, world } = fixture([record('a', '/enrolled')], 3)
    expect(policy.canRunAlongside(dispatch('b'), [dispatch('a')], world, ledger())).toBe(false)
    const current = attempt(dispatch('a'))
    expect(policy.preserveAttemptOnContentChange(current, world, ledger())).toBe(false)
  })
})

describe('objective gate concurrency carve-out', () => {
  it('runs two gates for different names concurrently', () => {
    const { policy, world } = fixture([], 1)
    expect(policy.canRunAlongside(runGate('full-suite'), [runGate('unit')], world, ledger())).toBe(
      true
    )
  })

  it('refuses a second run-gate for the same gate name', () => {
    const { policy, world } = fixture([], 1)
    expect(policy.canRunAlongside(runGate('unit'), [runGate('unit')], world, ledger())).toBe(false)
  })

  it('refuses a gate that would start beside any other action kind', () => {
    const { policy, world } = fixture([], 1)
    expect(policy.canRunAlongside(runGate('unit'), [dispatch('a')], world, ledger())).toBe(false)
  })

  it('refuses every other kind while a gate is active', () => {
    const { policy, world } = fixture([], 1)
    expect(policy.canRunAlongside(dispatch('a'), [runGate('unit')], world, ledger())).toBe(false)
  })
})
