import { describe, expect, it } from 'vitest'
import { BUILTIN_PR_SITTER_PIPELINE_TEXT } from '../builtin-pipelines'
import { attemptEntry, pipelinePayload, emptyLedger, world } from '../interpreter-test-harness'
import type { PipelineComposite } from './index'
import { derivePipelineRunState } from './run-state'
import { decidePipelineTick } from './decide'

describe('composite interpreter closures', () => {
  it('derives a terminal sitter stop as a done node with its lifecycle output', () => {
    const payload = pipelinePayload(BUILTIN_PR_SITTER_PIPELINE_TEXT)
    const composite: PipelineComposite = {
      snapshot: {
        freshness: 'live',
        contentIdentity: 'sitter:world',
        observedAtMs: 1_000,
        world: {}
      },
      phase: 'merging',
      decide: () => ({ action: null, reason: 'no further action', considered: [] }),
      evaluateStops: () => ({
        predicateId: 'closed',
        disposition: 'terminal',
        reason: 'merged'
      })
    }
    const runWorld = world({
      payload,
      composites: { 'pr-sitter': composite }
    })

    const state = derivePipelineRunState({
      payload,
      ledger: emptyLedger(),
      facts: runWorld.facts,
      nowMs: runWorld.nowMs,
      composites: runWorld.composites
    })

    expect(state.nodes.get('pr-sitter')).toMatchObject({
      status: 'done',
      outputs: { lifecycle: 'merged' }
    })
    expect(state.terminal).toBe('complete')
  })
  it('keeps a sitter read failure branch-local while a ready sibling runs', () => {
    const payload = pipelinePayload(`version: 1
id: sitter-read-failure
name: Sitter read failure
nodes:
  - id: a-sitter
    type: pr-sitter
  - id: z-worker
    type: agent
    prompt: Continue the independent branch
`)
    const runWorld = world({
      payload,
      compositeReadErrors: { 'a-sitter': 'Malformed sitter snapshot' }
    })
    const first = decidePipelineTick(runWorld, emptyLedger())
    expect(first).toMatchObject({
      action: { kind: 'pipeline-dispatch-agent', pipelineNode: { instanceId: 'z-worker' } }
    })
    if (!('action' in first) || first.action === null) {
      throw new Error('Expected the independent worker action')
    }
    const ledger = emptyLedger([attemptEntry(first.action, 'settled', 2_000, { effect: 'landed' })])

    expect(decidePipelineTick(runWorld, ledger)).toMatchObject({
      action: {
        kind: 'pipeline-apply-choice',
        cause: 'configuration',
        detail: 'Malformed sitter snapshot',
        options: ['retry', 'abort']
      }
    })
  })
})
