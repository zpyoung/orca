import { describe, expect, it } from 'vitest'
import { attempt, ledger, node, projection, snapshot } from './decision-test-harness'
import type { ObjectiveAction } from './objective-actions'
import type { ObjectiveDispatchRecord } from './parallel-types'
import {
  deriveObjectiveLanes,
  objectiveLaneForTask,
  objectiveParallelSlotState,
  prioritizeReadyObjectiveTaskKeys
} from './parallel-scheduling'

function dispatchNode(taskKey: string): Extract<ObjectiveAction, { kind: 'dispatch-node' }> {
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

function dispatchRecord(
  taskKey: string,
  state: 'running' | 'waiting-to-apply' = 'running'
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
    commitSha: state === 'waiting-to-apply' ? 'commit-1' : null,
    appliedCommitSha: null,
    reportDigest: state === 'waiting-to-apply' ? 'report-digest' : null,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    planTaskDigest: `plan-digest-${taskKey}`,
    createdAtMs: 10,
    completedAtMs: state === 'waiting-to-apply' ? 20 : null,
    terminalHandle: 'terminal-1',
    setupState: 'ready',
    reportPath: null,
    report: null,
    task: {
      taskKey,
      title: `Task ${taskKey}`,
      spec: `Implement ${taskKey}`,
      deps: [],
      criteria: [{ body: 'Works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
  }
}

describe('objective lane derivation', () => {
  it('derives one-to-one chains and splits sessions at five nodes', () => {
    const chain = Array.from({ length: 7 }, (_, index) =>
      node(`n${index + 1}`, { deps: index === 0 ? [] : [`n${index}`] })
    )
    expect(deriveObjectiveLanes(chain)).toEqual([
      { taskKeys: ['n1', 'n2', 'n3', 'n4', 'n5'], planOrder: 0 },
      { taskKeys: ['n6', 'n7'], planOrder: 5 }
    ])
    expect(objectiveLaneForTask(chain, 'n6')?.taskKeys).toEqual(['n6', 'n7'])
  })

  it('breaks lanes at fanouts and joins while preserving original plan order', () => {
    const graph = [
      node('root'),
      node('left', { deps: ['root'] }),
      node('right', { deps: ['root'] }),
      node('join', { deps: ['left', 'right'] }),
      node('tail', { deps: ['join'] })
    ]
    expect(deriveObjectiveLanes(graph).map((lane) => lane.taskKeys)).toEqual([
      ['root'],
      ['left'],
      ['right'],
      ['join', 'tail']
    ])
  })

  it('turns every task into a one-node lane when lane reuse is disabled', () => {
    const chain = [node('first'), node('second', { deps: ['first'] })]
    expect(deriveObjectiveLanes(chain, { enabled: false }).map((lane) => lane.taskKeys)).toEqual([
      ['first'],
      ['second']
    ])
  })
})

describe('objective ready-work priority', () => {
  it('chooses the longest remaining chain and breaks ties by original plan order', () => {
    const graph = [
      node('earlier'),
      node('later'),
      node('short'),
      node('earlier-tail', { deps: ['earlier'] }),
      node('later-tail', { deps: ['later'] })
    ]
    expect(prioritizeReadyObjectiveTaskKeys(graph)).toEqual(['earlier', 'later', 'short'])
  })

  it('requires every join dependency to be applied and ignores an unavailable sibling only', () => {
    const graph = [
      node('left', { state: 'succeeded', orchestrationTaskId: 'left-task' }),
      node('right'),
      node('unrelated'),
      node('join', { deps: ['left', 'right'] })
    ]
    expect(prioritizeReadyObjectiveTaskKeys(graph, new Set(['right']))).toEqual(['unrelated'])
    graph[1] = node('right', { state: 'succeeded', orchestrationTaskId: 'right-task' })
    expect(prioritizeReadyObjectiveTaskKeys(graph)).toEqual(['unrelated', 'join'])
  })
})

describe('objective slot accounting', () => {
  it('combines durable train occupancy with same-fill-cycle ledger dispatches', () => {
    const world = snapshot(projection({ nodes: [node('first'), node('second')] }), {
      parallel: {
        effectiveMaxConcurrency: 3,
        runningCount: 1,
        dispatches: [dispatchRecord('first', 'waiting-to-apply')]
      }
    }).world
    const second = dispatchNode('second')
    expect(
      objectiveParallelSlotState(
        world,
        ledger([attempt(second, { dispatchId: 'dispatch-second' })]),
        'revision-1'
      )
    ).toEqual({ effectiveMaxConcurrency: 3, runningCount: 2, availableSlots: 1 })
  })

  it('drains a lowered cap without stopping already occupied slots', () => {
    const world = snapshot(projection(), {
      parallel: {
        effectiveMaxConcurrency: 1,
        runningCount: 2,
        dispatches: [dispatchRecord('first'), dispatchRecord('second')]
      }
    }).world
    expect(objectiveParallelSlotState(world, ledger(), 'revision-1')).toEqual({
      effectiveMaxConcurrency: 1,
      runningCount: 2,
      availableSlots: 0
    })
  })
})
