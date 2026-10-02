import { describe, expect, it } from 'vitest'
import {
  attemptEntry,
  emptyLedger,
  nodeOutputs,
  pipelinePayload,
  world
} from '../interpreter-test-harness'
import { buildPipelineAction, builtinOneNodeRunState } from './index'
import { derivePipelineRunState } from './run-state'

describe('derivePipelineRunState readiness', () => {
  it('makes the Bugfix repro root ready while its downstream fix remains pending', () => {
    const input = world()
    const state = derivePipelineRunState({
      payload: input.payload,
      ledger: emptyLedger(),
      facts: input.facts,
      nowMs: input.nowMs
    })

    expect(state.nodes.get('repro')?.status).toBe('ready')
    expect(state.nodes.get('fix')?.status).toBe('pending')
  })

  it('makes the next node ready only after the preceding node lands its outputs', () => {
    const payload = pipelinePayload(`version: 1
id: bugfix
name: Bugfix
nodes:
  - id: repro
    type: agent
    prompt: Reproduce the bug
    outputs:
      summary:
        type: text
  - id: fix
    type: agent
    after: [repro]
    prompt: Fix the bug
`)
    const input = world({ payload })
    const action = buildPipelineAction({
      kind: 'pipeline-dispatch-agent',
      capability: 'agent',
      visibility: 'external',
      pin: payload.pin,
      instanceId: 'repro',
      nodeId: 'repro',
      epoch: 0,
      attempt: 0
    })
    const facts = {
      ...input.facts,
      outputs: [nodeOutputs('repro', 0, 0, { summary: 'The bug is reproducible.' })]
    }
    const runningState = derivePipelineRunState({
      payload: input.payload,
      ledger: emptyLedger([
        attemptEntry(action, 'running', input.nowMs, { dispatchId: 'dispatch:repro' })
      ]),
      facts,
      nowMs: input.nowMs
    })

    expect(runningState.nodes.get('repro')?.status).toBe('running')
    expect(runningState.nodes.get('fix')?.status).toBe('pending')

    const landedState = derivePipelineRunState({
      payload: input.payload,
      ledger: emptyLedger([
        attemptEntry(action, 'settled', input.nowMs, {
          effect: 'landed',
          dispatchId: 'dispatch:repro'
        })
      ]),
      facts,
      nowMs: input.nowMs
    })

    expect(landedState.nodes.get('repro')).toMatchObject({
      status: 'done',
      outputs: { summary: 'The bug is reproducible.' }
    })
    expect(landedState.nodes.get('fix')?.status).toBe('ready')
  })

  it('holds a landed agent as running until its declared outputs are visible', () => {
    const payload = pipelinePayload(`version: 1
id: plan
name: Plan
nodes:
  - id: planner
    type: agent
    prompt: Plan the work
    outputs:
      plan:
        type: taskList
  - id: workers
    type: swarm
    after: [planner]
    from: $planner.outputs.plan
    child:
      harness: claude
      prompt: Do $task.title
`)
    const input = world({ payload })
    const action = buildPipelineAction({
      kind: 'pipeline-dispatch-agent',
      capability: 'agent',
      visibility: 'external',
      pin: payload.pin,
      instanceId: 'planner',
      nodeId: 'planner',
      epoch: 0,
      attempt: 0
    })
    const ledger = emptyLedger([
      attemptEntry(action, 'settled', input.nowMs, {
        effect: 'landed',
        dispatchId: 'dispatch:planner'
      })
    ])
    // the store snapshot can predate the output row the landed settlement was written after
    const stale = derivePipelineRunState({
      payload: input.payload,
      ledger,
      facts: input.facts,
      nowMs: input.nowMs
    })

    expect(stale.nodes.get('planner')?.status).toBe('running')
    expect(stale.nodes.get('workers')?.status).toBe('pending')

    const plan = [{ id: 'note-1', title: 'Note 1', spec: 'Write note 1' }]
    const fresh = derivePipelineRunState({
      payload: input.payload,
      ledger,
      facts: { ...input.facts, outputs: [nodeOutputs('planner', 0, 0, { plan })] },
      nowMs: input.nowMs
    })

    expect(fresh.nodes.get('planner')).toMatchObject({ status: 'done', outputs: { plan } })
    expect(fresh.nodes.get('workers')?.status).toBe('ready')
  })

  it('makes independent root nodes ready together without releasing their dependents', () => {
    const payload = pipelinePayload(`version: 1
id: parallel
name: Parallel roots
nodes:
  - id: first
    type: agent
    prompt: First root
  - id: second
    type: agent
    prompt: Second root
  - id: first-child
    type: agent
    after: [first]
    prompt: First child
  - id: second-child
    type: agent
    after: [second]
    prompt: Second child
`)
    const input = world({ payload })
    const state = derivePipelineRunState({
      payload: input.payload,
      ledger: emptyLedger(),
      facts: input.facts,
      nowMs: input.nowMs
    })

    expect(state.nodes.get('first')?.status).toBe('ready')
    expect(state.nodes.get('second')?.status).toBe('ready')
    expect(state.nodes.get('first-child')?.status).toBe('pending')
    expect(state.nodes.get('second-child')?.status).toBe('pending')
  })
})

describe('derivePipelineRunState land completion', () => {
  const payload = pipelinePayload(`version: 1
id: ship
name: Ship
nodes:
  - id: land
    type: land
`)

  function landAction(
    kind: 'pipeline-land-commit' | 'pipeline-land-push' | 'pipeline-land-open-review'
  ) {
    return buildPipelineAction({
      kind,
      capability: kind === 'pipeline-land-push' ? 'push' : 'land',
      visibility: kind === 'pipeline-land-commit' ? 'local' : 'external',
      pin: payload.pin,
      instanceId: 'land',
      nodeId: 'land',
      epoch: 0,
      attempt: 0,
      ...(kind === 'pipeline-land-commit' ? {} : { step: kind })
    })
  }

  it('keeps Land ready between its commit and push steps', () => {
    const input = world({ payload })
    const state = derivePipelineRunState({
      payload: input.payload,
      ledger: emptyLedger([
        attemptEntry(landAction('pipeline-land-commit'), 'settled', 1_000, { effect: 'landed' })
      ]),
      facts: input.facts,
      nowMs: input.nowMs
    })

    expect(state.nodes.get('land')?.status).toBe('ready')
    expect(state.terminal).toBeNull()
  })

  it('completes Land and the run once the review opens, exposing the review as outputs', () => {
    const input = world({ payload })
    const review = {
      prUrl: 'https://github.com/acme/app/pull/1',
      prNumber: 1,
      branch: 'feature',
      headSha: 'abc123',
      provider: 'github'
    }
    const state = derivePipelineRunState({
      payload: input.payload,
      ledger: emptyLedger([
        attemptEntry(landAction('pipeline-land-commit'), 'settled', 1_000, { effect: 'landed' }),
        attemptEntry(landAction('pipeline-land-push'), 'settled', 2_000, { effect: 'landed' }),
        attemptEntry(landAction('pipeline-land-open-review'), 'settled', 3_000, {
          effect: 'landed',
          result: review
        })
      ]),
      facts: input.facts,
      nowMs: input.nowMs
    })

    expect(state.nodes.get('land')).toMatchObject({ status: 'done', outputs: review })
    expect(state.terminal).toBe('complete')
  })
})

describe('builtinOneNodeRunState', () => {
  it('preserves Objective phase, progress, and revision in its one-node state', () => {
    const state = builtinOneNodeRunState('objective', 'review', { done: 2, total: 5 }, 3)

    expect(state.nodes.size).toBe(1)
    expect(state.nodes.get('objective')).toMatchObject({
      status: 'running',
      phase: 'review',
      progress: { done: 2, total: 5 },
      revision: 3
    })
  })
})
