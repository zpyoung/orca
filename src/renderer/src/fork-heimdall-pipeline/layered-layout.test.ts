import { describe, expect, it } from 'vitest'
import {
  CheckNodeSchema,
  type PipelineCheckNode,
  type PipelineDocument,
  type PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import { layeredLayout } from './layered-layout'

function documentWith(nodes: PipelineNode[]): PipelineDocument {
  return {
    version: 1,
    id: 'bugfix',
    name: 'Bugfix',
    inputs: { task: { type: 'text', required: true } },
    nodes
  }
}

function agent(id: string, after?: PipelineNode['after']): PipelineNode {
  return { id, type: 'agent', prompt: '', ...(after === undefined ? {} : { after }) }
}

function check(id: string, command: string, after?: PipelineCheckNode['after']): PipelineCheckNode {
  return CheckNodeSchema.parse({
    id,
    type: 'check',
    command,
    ...(after === undefined ? {} : { after })
  })
}

describe('layeredLayout', () => {
  it('places the Bugfix chain in successive rows of one column', () => {
    const result = layeredLayout(
      documentWith([
        agent('repro'),
        agent('fix', ['repro']),
        check('check', 'npm test', ['fix']),
        { id: 'land', type: 'land', draft: false, after: ['check'] }
      ])
    )

    expect(result.nodes).toEqual({
      repro: { x: 0, y: 0 },
      fix: { x: 0, y: 160 },
      check: { x: 0, y: 320 },
      land: { x: 0, y: 480 }
    })
  })

  it('orders a diamond by predecessor position and gives its join the first column', () => {
    const result = layeredLayout(
      documentWith([agent('a'), agent('b', ['a']), agent('c', ['a']), agent('d', ['b', 'c'])])
    )

    expect(result.nodes).toEqual({
      a: { x: 0, y: 0 },
      b: { x: 0, y: 160 },
      c: { x: 280, y: 160 },
      d: { x: 0, y: 320 }
    })
  })

  it('keeps valid saved points, drops stale ids, and lays out new nodes', () => {
    const result = layeredLayout(documentWith([agent('a'), agent('b', ['a'])]), {
      version: 1,
      nodes: {
        a: { x: 44, y: 88 },
        deleted: { x: 900, y: 900 }
      },
      viewport: { x: 10, y: 20, zoom: 1.25 }
    })

    expect(result).toEqual({
      version: 1,
      nodes: { a: { x: 44, y: 88 }, b: { x: 0, y: 160 } },
      viewport: { x: 10, y: 20, zoom: 1.25 }
    })
  })
})
