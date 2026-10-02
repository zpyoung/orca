import { describe, expect, it } from 'vitest'
import { PipelineRunViewSchema } from './run-view-types'

describe('PipelineRunViewSchema', () => {
  it('preserves unknown node types and degrades future enums without inventing a waiting state', () => {
    const view = PipelineRunViewSchema.parse({
      watcherId: 'watcher-1',
      kind: 'future-kind',
      pin: {
        ref: 'bugfix',
        scope: 'future-scope',
        id: 'bugfix',
        contentHash: `sha256:${'a'.repeat(64)}`,
        documentVersion: 1,
        runNumber: null,
        label: 'Bugfix v1'
      },
      document: {
        version: 1,
        id: 'bugfix',
        name: 'Bugfix',
        nodes: [{ id: 'teleporter', type: 'teleport' }]
      },
      nodes: [
        {
          instanceId: 'teleporter',
          nodeId: 'teleporter',
          type: 'teleport',
          label: 'Teleporter',
          status: 'exploded',
          waitingFor: 'teleport',
          epoch: 0,
          attempt: 0,
          turns: 0
        }
      ],
      edges: [],
      asOfMs: 100
    })

    expect(view.document.nodes[0]?.type).toBe('teleport')
    expect(view.nodes[0]?.status).toBe('unknown')
    expect(view.kind).toBe('unknown')
    expect(view.pin.scope).toBe('unknown')
    expect(view.nodes[0]?.waitingFor).toBeUndefined()
  })
})
