import { describe, expect, it } from 'vitest'
import type { WatcherLedger } from '../../fork-heimdall/ledger-types'
import type { PipelineWorld } from './index'
import type { TaskList, TaskListWarning } from '../task-list'
import { buildPipelineAction } from './action-envelope'
import { decidePipelineTick } from './decide'
import { derivePipelineRunState } from './run-state'
import {
  attemptEntry,
  emptyLedger,
  nodeOutputs,
  pipelinePayload,
  world
} from '../interpreter-test-harness'

const TASKS: TaskList = [
  { id: 't1', title: 'First independent task', spec: 'Implement the first change' },
  { id: 't2', title: 'Prerequisite task', spec: 'Prepare the second change' },
  { id: 't3', title: 'Dependent task', spec: 'Finish after t2', deps: ['t2'] },
  { id: 't4', title: 'Other independent task', spec: 'Implement another change' }
]

const OVERLAP_WARNING: TaskListWarning = {
  code: 'territory-overlap',
  taskIds: ['t1', 't4'],
  paths: ['src/shared/**']
}

const SWARM_YAML = `version: 1
id: swarm-run
name: Swarm run
nodes:
  - id: plan
    type: agent
    prompt: Plan the task list
    outputs:
      tasks:
        type: taskList
  - id: swarm
    type: swarm
    after: [plan]
    from: $plan.outputs.tasks
    maxParallel: 2
    worktree: shared
    child:
      harness: codex
      prompt: $task.spec
`

function swarmWorld(): PipelineWorld {
  const payload = pipelinePayload(SWARM_YAML)
  const initialWorld = world({ payload })
  const facts = {
    ...initialWorld.facts,
    outputs: [nodeOutputs('plan', 0, 0, { tasks: TASKS })],
    swarmExpansions: [
      {
        swarmId: 'swarm',
        epoch: 0,
        tasks: TASKS,
        warnings: [OVERLAP_WARNING],
        baseCommit: 'base-commit'
      }
    ]
  }
  return world({ payload, facts })
}

function planAction(runWorld: PipelineWorld) {
  return buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'external',
    pin: runWorld.payload.pin,
    instanceId: 'plan',
    nodeId: 'plan',
    epoch: 0,
    attempt: 0
  })
}

function childAction(runWorld: PipelineWorld, taskId: string) {
  return buildPipelineAction({
    kind: 'pipeline-dispatch-agent',
    capability: 'agent',
    visibility: 'external',
    pin: runWorld.payload.pin,
    instanceId: `swarm[${taskId}]`,
    nodeId: 'swarm',
    epoch: 0,
    attempt: 0
  })
}

function stateFor(runWorld: PipelineWorld, ledger: WatcherLedger) {
  return derivePipelineRunState({
    payload: runWorld.payload,
    facts: runWorld.facts,
    ledger,
    nowMs: runWorld.nowMs
  })
}

describe('Swarm child scheduling', () => {
  it('waits for dependencies, respects maxParallel, and carries expansion warnings', () => {
    const runWorld = swarmWorld()
    const sourceLedger = emptyLedger([
      attemptEntry(planAction(runWorld), 'settled', 1_000, { effect: 'landed' })
    ])

    const initial = stateFor(runWorld, sourceLedger)
    expect(initial.nodes.get('swarm[t1]')?.status).toBe('ready')
    expect(initial.nodes.get('swarm[t2]')?.status).toBe('ready')
    expect(initial.nodes.get('swarm[t3]')?.status).toBe('pending')
    expect(initial.nodes.get('swarm[t4]')?.status).toBe('pending')
    expect(initial.nodes.get('swarm')?.warnings).toEqual([OVERLAP_WARNING])

    const firstDispatch = decidePipelineTick(runWorld, sourceLedger).action
    expect(firstDispatch).toMatchObject({
      kind: 'pipeline-dispatch-agent',
      pipelineNode: { instanceId: 'swarm[t1]' }
    })

    const withFirstRunning = emptyLedger([
      ...sourceLedger.entries,
      attemptEntry(childAction(runWorld, 't1'), 'running', 2_000, { dispatchId: 'dispatch-t1' })
    ])
    const oneSlotLeft = stateFor(runWorld, withFirstRunning)
    expect(oneSlotLeft.nodes.get('swarm[t1]')?.status).toBe('running')
    expect(oneSlotLeft.nodes.get('swarm[t2]')?.status).toBe('ready')
    expect(oneSlotLeft.nodes.get('swarm[t3]')?.status).toBe('pending')
    expect(oneSlotLeft.nodes.get('swarm[t4]')?.status).toBe('pending')
    expect(decidePipelineTick(runWorld, withFirstRunning).action?.pipelineNode).toMatchObject({
      instanceId: 'swarm[t2]'
    })

    const withDependencyLanded = emptyLedger([
      ...withFirstRunning.entries,
      attemptEntry(childAction(runWorld, 't2'), 'settled', 3_000, { effect: 'landed' })
    ])
    const dependencyResolved = stateFor(runWorld, withDependencyLanded)
    expect(dependencyResolved.nodes.get('swarm[t3]')?.status).toBe('ready')
    expect(dependencyResolved.nodes.get('swarm[t4]')?.status).toBe('pending')
    expect(decidePipelineTick(runWorld, withDependencyLanded).action?.pipelineNode).toMatchObject({
      instanceId: 'swarm[t3]'
    })
  })
})
