import { describe, expect, it } from 'vitest'
import type { KernelAction, WatcherLedger } from '../../fork-heimdall/ledger-types'
import type { TaskList } from '../task-list'
import {
  attemptEntry,
  emptyLedger,
  nodeOutputs,
  pipelinePayload,
  world
} from '../interpreter-test-harness'
import type { PipelineMergeSourceFacts, PipelineWorld } from './index'
import { decidePipelineTick } from './decide'
import { pipelineNodeIdentity } from './node-instance'
import { derivePipelineRunState } from './run-state'

const ROUND_ONE: TaskList = [
  { id: 't1', title: 'First', spec: 'Do the first change' },
  { id: 't2', title: 'Second', spec: 'Do the second change' }
]
const ROUND_TWO: TaskList = [{ id: 't3', title: 'Third', spec: 'Redo the work' }]

const STEPS = `  - id: plan
    type: agent
    prompt: Plan the task list
    outputs:
      tasks:
        type: taskList
  - id: swarm
    type: swarm
    after: [plan]
    from: $plan.outputs.tasks
    worktree: shared
    child:
      harness: codex
      prompt: $task.spec
  - id: merge
    type: merge
    after: [swarm]
    from: swarm
`

const SEND_BACK_YAML = `version: 1
id: merge-epoch
name: Merge epoch
nodes:
${STEPS}  - id: verify
    type: check
    after: [merge]
    command: npm test
    retry: 1
    onFail:
      sendBackTo: plan
`

const LOOP_YAML = `version: 1
id: merge-loop
name: Merge loop
nodes:
${STEPS}  - id: review
    type: agent
    after: [merge]
    prompt: Review the merge
    outputs:
      verdict:
        type: verdict
  - id: iteration
    type: loop
    after: [review]
    body: [plan, swarm, merge, review]
    until: $review.outputs.verdict
    maxRounds: 3
`

function source(taskId: string): PipelineMergeSourceFacts {
  return {
    childInstanceId: `swarm[${taskId}]`,
    workspacePath: `/workspace/${taskId}`,
    sourceHead: `head-${taskId}`,
    committedChildSha: `commit-${taskId}`,
    workspaceDigest: `digest-${taskId}`,
    applicableBaseCommit: 'base-run',
    unmergedPaths: []
  }
}

function applied(epoch: number, taskId: string) {
  return {
    mergeId: 'merge',
    epoch,
    childInstanceId: `swarm[${taskId}]`,
    state: 'applied' as const,
    commitSha: `commit-${taskId}`,
    appliedCommitSha: `applied-epoch-${epoch}`,
    conflict: null
  }
}

function runWorld(
  yaml: string,
  expansions: { epoch: number; tasks: TaskList }[],
  extra: Partial<PipelineWorld['facts']> = {}
): PipelineWorld {
  const payload = pipelinePayload(yaml)
  const base = world({ payload })
  return world({
    payload,
    facts: {
      ...base.facts,
      outputs: expansions.map(({ epoch, tasks }) => nodeOutputs('plan', epoch, 0, { tasks })),
      swarmExpansions: expansions.map(({ epoch, tasks }) => ({
        swarmId: 'swarm',
        epoch,
        tasks,
        warnings: [],
        baseCommit: 'base-run'
      })),
      ...extra
    },
    mergeSources: Object.fromEntries(['t1', 't2', 't3'].map((id) => [`swarm[${id}]`, source(id)]))
  })
}

// settles every action as landed, failing only the ones `fails` names
function drive(
  runWorld: PipelineWorld,
  fails: (action: KernelAction) => boolean,
  stopAt: (action: KernelAction) => boolean
): { actions: KernelAction[]; ledger: WatcherLedger } {
  let ledger = emptyLedger()
  const actions: KernelAction[] = []
  for (let step = 0; step < 40; step += 1) {
    const action = decidePipelineTick(runWorld, ledger).action
    if (action === null) {
      break
    }
    actions.push(action)
    if (stopAt(action)) {
      break
    }
    const atMs = 1_000 + step * 10
    ledger = {
      ...ledger,
      entries: [
        ...ledger.entries,
        attemptEntry(action, 'attempted', atMs, { attemptId: `a-${step}` }),
        attemptEntry(action, 'settled', atMs + 5, {
          attemptId: `a-${step}`,
          effect: fails(action) ? 'not-landed' : 'landed'
        })
      ]
    }
  }
  return { actions, ledger }
}

describe('Merge progress is scoped to the merge epoch', () => {
  it('integrates re-emitted tasks after a send-back instead of reusing prior-epoch applied rows', () => {
    const world1 = runWorld(
      SEND_BACK_YAML,
      [
        { epoch: 0, tasks: ROUND_ONE },
        { epoch: 1, tasks: ROUND_ONE }
      ],
      { mergeProgress: [applied(0, 't1'), applied(0, 't2')] }
    )

    const { actions, ledger } = drive(
      world1,
      (action) => {
        const identity = pipelineNodeIdentity(action)
        return identity?.instanceId === 'verify' && identity.epoch === 0
      },
      (action) => action.kind === 'pipeline-merge-child'
    )

    const last = actions.at(-1)
    expect(last).toMatchObject({
      kind: 'pipeline-merge-child',
      pipelineNode: { nodeId: 'merge', epoch: 1 }
    })
    const state = derivePipelineRunState({
      payload: world1.payload,
      ledger,
      facts: world1.facts,
      nowMs: world1.nowMs
    })
    expect(state.nodes.get('merge')).toMatchObject({ epoch: 1, status: 'ready' })
  })

  it('emits the merge of a loop body on round two using that round expansion', () => {
    const world1 = runWorld(
      LOOP_YAML,
      [
        { epoch: 0, tasks: ROUND_ONE },
        { epoch: 1, tasks: ROUND_TWO }
      ],
      {
        outputs: [
          nodeOutputs('plan', 0, 0, { tasks: ROUND_ONE }),
          nodeOutputs('plan', 1, 0, { tasks: ROUND_TWO }),
          nodeOutputs('review', 0, 0, {
            verdict: { verdict: 'revise', objections: ['more'], reason: 'again' }
          })
        ],
        mergeProgress: [applied(0, 't1'), applied(0, 't2')]
      }
    )

    const { actions } = drive(
      world1,
      () => false,
      (action) =>
        action.kind === 'pipeline-merge-child' && pipelineNodeIdentity(action)?.epoch === 1
    )

    expect(actions.at(-1)).toMatchObject({
      kind: 'pipeline-merge-child',
      childInstanceId: 'swarm[t3]',
      pipelineNode: { nodeId: 'merge', epoch: 1 }
    })
  })

  it('reaches retries-exhausted when a non-conflict merge-child failure spends the budget', () => {
    const world1 = runWorld(SEND_BACK_YAML, [{ epoch: 0, tasks: ROUND_ONE }])

    const { actions, ledger } = drive(
      world1,
      (action) => action.kind === 'pipeline-merge-child',
      (action) => action.kind === 'pipeline-apply-choice'
    )

    expect(actions.at(-1)).toMatchObject({
      kind: 'pipeline-apply-choice',
      cause: 'retries-exhausted',
      pipelineNode: { nodeId: 'merge' }
    })
    const state = derivePipelineRunState({
      payload: world1.payload,
      ledger,
      facts: world1.facts,
      nowMs: world1.nowMs
    })
    expect(state.nodes.get('merge')?.status).toBe('failed')
  })
})
