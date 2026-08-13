import { describe, expect, it } from 'vitest'
import {
  computePipelineCanvasLayout,
  deriveSequentialPipelineLayoutNodes,
  type PipelineLayoutNode
} from './pipeline-canvas-layout'

function positionOf(
  positions: ReturnType<typeof computePipelineCanvasLayout>,
  id: string
): { column: number; row: number } {
  const found = positions.find((p) => p.id === id)
  if (!found) {
    throw new Error(`no position for ${id}`)
  }
  return { column: found.column, row: found.row }
}

describe('computePipelineCanvasLayout', () => {
  it('places a linear chain in strictly increasing columns, one per row', () => {
    const nodes: PipelineLayoutNode[] = [
      { id: 'repro', needs: [] },
      { id: 'fix', needs: ['repro'] },
      { id: 'test', needs: ['fix'] },
      { id: 'pr', needs: ['test'] }
    ]
    const positions = computePipelineCanvasLayout(nodes)
    expect(positionOf(positions, 'repro')).toEqual({ column: 0, row: 0 })
    expect(positionOf(positions, 'fix')).toEqual({ column: 1, row: 0 })
    expect(positionOf(positions, 'test')).toEqual({ column: 2, row: 0 })
    expect(positionOf(positions, 'pr')).toEqual({ column: 3, row: 0 })
  })

  it('columns by longest-path depth from the roots, not shortest path', () => {
    // c depends on both a (depth 0) and b (depth 1, since b depends on a) — c's
    // column must follow the longer of the two incoming paths.
    const nodes: PipelineLayoutNode[] = [
      { id: 'a', needs: [] },
      { id: 'b', needs: ['a'] },
      { id: 'c', needs: ['a', 'b'] }
    ]
    const positions = computePipelineCanvasLayout(nodes)
    expect(positionOf(positions, 'a').column).toBe(0)
    expect(positionOf(positions, 'b').column).toBe(1)
    expect(positionOf(positions, 'c').column).toBe(2)
  })

  it('orders siblings within a column by the input list order', () => {
    const nodes: PipelineLayoutNode[] = [
      { id: 'root', needs: [] },
      { id: 'second-child', needs: ['root'] },
      { id: 'first-child', needs: ['root'] }
    ]
    const positions = computePipelineCanvasLayout(nodes)
    expect(positionOf(positions, 'root')).toEqual({ column: 0, row: 0 })
    // 'second-child' precedes 'first-child' in the input list, so it keeps row 0.
    expect(positionOf(positions, 'second-child')).toEqual({ column: 1, row: 0 })
    expect(positionOf(positions, 'first-child')).toEqual({ column: 1, row: 1 })
  })

  it('is deterministic across repeated calls with the same topology', () => {
    const nodes: PipelineLayoutNode[] = [
      { id: 'repro', needs: [] },
      { id: 'fix', needs: ['repro'] },
      { id: 'test', needs: ['fix'] },
      { id: 'pr', needs: ['test'] }
    ]
    const first = computePipelineCanvasLayout(nodes)
    const second = computePipelineCanvasLayout(nodes.map((n) => ({ ...n })))
    expect(second).toEqual(first)
  })

  it('treats a node naming an unknown dependency id as a root', () => {
    const nodes: PipelineLayoutNode[] = [{ id: 'orphan', needs: ['does-not-exist'] }]
    const positions = computePipelineCanvasLayout(nodes)
    expect(positionOf(positions, 'orphan')).toEqual({ column: 0, row: 0 })
  })

  it('never loops forever on a cyclic input', () => {
    const nodes: PipelineLayoutNode[] = [
      { id: 'x', needs: ['y'] },
      { id: 'y', needs: ['x'] }
    ]
    const positions = computePipelineCanvasLayout(nodes)
    expect(positions).toHaveLength(2)
  })

  it('returns an empty layout for an empty node list', () => {
    expect(computePipelineCanvasLayout([])).toEqual([])
  })
})

describe('deriveSequentialPipelineLayoutNodes', () => {
  it('chains each node to the one before it in list order', () => {
    const nodes = deriveSequentialPipelineLayoutNodes(['repro', 'fix', 'test', 'pr'])
    expect(nodes).toEqual([
      { id: 'repro', needs: [] },
      { id: 'fix', needs: ['repro'] },
      { id: 'test', needs: ['fix'] },
      { id: 'pr', needs: ['test'] }
    ])
  })

  it('produces a layout that renders the chain across increasing columns', () => {
    const positions = computePipelineCanvasLayout(
      deriveSequentialPipelineLayoutNodes(['repro', 'fix', 'test', 'pr'])
    )
    expect(positions.map((p) => p.column)).toEqual([0, 1, 2, 3])
  })
})
