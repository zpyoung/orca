import { describe, expect, it } from 'vitest'
import {
  FakePipelineRunDb,
  definitionOf,
  node,
  nodeRow,
  runRow
} from './pipeline-driver-test-support'
import {
  allNodesSucceeded,
  applyNodeOutcome,
  buildPipelineNodeIndex,
  pickNextReadyNode
} from './pipeline-driver-node-graph'

describe('applyNodeOutcome', () => {
  it('is required to observe a write: the cached index does not update on its own', () => {
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([['a', nodeRow({ node_id: 'a', node_index: 0, task_id: 'task-a' })]])
    )
    const index = buildPipelineNodeIndex(pipelineDb.getNodes())

    pipelineDb.setNodeOutcome('run-1', 'a', { outcome: 'succeeded' })

    // proves the fake no longer hands back a live reference: a real store's write is invisible
    // to an index built before the write, until the caller re-reads or applies it explicitly
    expect(allNodesSucceeded(index)).toBe(false)

    applyNodeOutcome(index, 'a', 'succeeded')
    expect(allNodesSucceeded(index)).toBe(true)
  })

  it('keeps a succeeded node from being reselected once the cache is told about the write', () => {
    const nodeA = node({ id: 'a', index: 0 })
    const nodeB = node({ id: 'b', index: 1, needs: ['a'] })
    const pipelineDb = new FakePipelineRunDb(
      runRow(),
      new Map([
        ['a', nodeRow({ node_id: 'a', node_index: 0, task_id: 'task-a' })],
        ['b', nodeRow({ node_id: 'b', node_index: 1, task_id: 'task-b' })]
      ])
    )
    const index = buildPipelineNodeIndex(pipelineDb.getNodes())

    pipelineDb.setNodeOutcome('run-1', 'a', { outcome: 'succeeded' })
    applyNodeOutcome(index, 'a', 'succeeded')

    const next = pickNextReadyNode(definitionOf([nodeA, nodeB]), index)
    expect(next?.id).toBe('b')
  })
})
