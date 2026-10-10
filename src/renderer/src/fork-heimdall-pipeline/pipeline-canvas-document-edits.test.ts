import { describe, expect, it } from 'vitest'
import {
  CheckNodeSchema,
  type PipelineCheckNode,
  type PipelineDocument,
  type PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineLayout } from '../../../shared/fork-heimdall-pipeline/layout-schema'
import {
  connectPipelineNodes,
  diffPipelineDocument,
  disconnectPipelineNodes,
  editPipelineNodeDocument,
  removePipelineNodeDocument
} from './pipeline-canvas-document-edits'

const layout: PipelineLayout = {
  version: 1,
  nodes: {
    agent: { x: 0, y: 0 },
    check: { x: 280, y: 0 }
  }
}

function documentWith(nodes: PipelineNode[]): PipelineDocument {
  return {
    version: 1,
    id: 'bugfix',
    name: 'Bugfix',
    inputs: { task: { type: 'text', required: true } },
    nodes
  }
}

type CheckNodeInput = {
  id: string
  command: string
  after?: PipelineCheckNode['after']
  onFail?: PipelineCheckNode['onFail']
  label?: string
}

function checkNode(input: CheckNodeInput): PipelineCheckNode {
  return CheckNodeSchema.parse({ type: 'check', ...input })
}

describe('pipeline canvas document edits', () => {
  it('renames node references and carries its saved point to the new id', () => {
    const document = documentWith([
      { id: 'agent', type: 'agent', prompt: 'Read $agent.outputs.plan' },
      checkNode({
        id: 'check',
        command: 'npm test',
        after: ['agent'],
        onFail: { sendBackTo: 'agent' }
      }),
      { id: 'decision', type: 'decision', on: '$agent.outputs.plan' },
      { id: 'gate', type: 'gate', label: 'Review', notify: true, sendBackTo: 'agent' },
      { id: 'merge', type: 'merge', from: 'agent' }
    ])

    const edited = editPipelineNodeDocument(document, layout, 'agent', (node) => ({
      ...node,
      id: 'repro'
    }))

    expect(edited?.document.nodes).toContainEqual(
      expect.objectContaining({ id: 'repro', type: 'agent' })
    )
    expect(edited?.document.nodes.find((node) => node.id === 'check')).toMatchObject({
      after: ['repro'],
      onFail: { sendBackTo: 'repro' }
    })
    expect(edited?.document.nodes.find((node) => node.id === 'decision')).toMatchObject({
      on: '$repro.outputs.plan'
    })
    expect(edited?.document.nodes.find((node) => node.id === 'gate')).toMatchObject({
      sendBackTo: 'repro'
    })
    expect(edited?.document.nodes.find((node) => node.id === 'merge')).toMatchObject({
      from: 'repro'
    })
    expect(edited?.layout.nodes).toMatchObject({ repro: { x: 0, y: 0 } })
    expect(edited?.layout.nodes.agent).toBeUndefined()
  })

  it('connects and disconnects a target dependency without changing other fields', () => {
    const document = documentWith([
      { id: 'agent', type: 'agent', prompt: 'Plan' },
      checkNode({ id: 'check', command: 'npm test', label: 'Checks' })
    ])
    const connected = connectPipelineNodes(document, 'agent', 'check', 'success')
    expect(connected?.nodes.find((node) => node.id === 'check')).toMatchObject({
      label: 'Checks',
      after: [{ node: 'agent', when: 'success' }]
    })
    expect(connectPipelineNodes(connected ?? document, 'agent', 'check')).toBeNull()

    const disconnected = connected && disconnectPipelineNodes(connected, 'agent', 'check')
    expect(disconnected?.nodes.find((node) => node.id === 'check')).toMatchObject({
      label: 'Checks',
      after: undefined
    })
  })

  it('removes an edge to a deleted node while pruning its layout point', () => {
    const document = documentWith([
      { id: 'agent', type: 'agent', prompt: 'Plan' },
      checkNode({ id: 'check', command: 'npm test', after: ['agent'] })
    ])
    const removed = removePipelineNodeDocument(document, layout, 'agent')

    expect(removed?.document.nodes).toHaveLength(1)
    const check = removed?.document.nodes[0]
    expect(check).toMatchObject({
      id: 'check',
      type: 'check',
      command: 'npm test'
    })
    expect(check?.after ?? []).toHaveLength(0)
    expect(removed?.layout.nodes.agent).toBeUndefined()
    expect(removed?.layout.nodes.check).toEqual({ x: 280, y: 0 })
  })

  it('only schedules the changed node and top-level name for a minimal write', () => {
    const saved = documentWith([
      { id: 'agent', type: 'agent', prompt: 'Plan' },
      checkNode({ id: 'check', command: 'npm test' })
    ])
    const draft: PipelineDocument = {
      ...saved,
      name: 'Bugfix fast',
      nodes: [
        { id: 'agent', type: 'agent', prompt: 'Fix the issue' },
        checkNode({ id: 'check', command: 'npm test' })
      ]
    }
    expect(diffPipelineDocument(saved, draft)).toEqual([
      { kind: 'set-top', key: 'name', value: 'Bugfix fast' },
      { kind: 'set-node', node: { id: 'agent', type: 'agent', prompt: 'Fix the issue' } }
    ])
  })
})
