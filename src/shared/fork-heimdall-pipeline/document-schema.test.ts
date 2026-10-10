import { describe, expect, it } from 'vitest'
import { PipelineDocumentSchema, PIPELINE_NODE_TYPES } from './document-schema'

const SCHEMA_DEFAULTS_DOCUMENT = {
  version: 1,
  id: 'bugfix',
  name: 'Bugfix (fast)',
  defaults: { harness: 'claude' },
  inputs: { task: { type: 'text', required: true }, priority: { type: 'number' } },
  nodes: [
    { id: 'repro', type: 'agent', prompt: 'Reproduce the issue.' },
    { id: 'check', type: 'check', command: 'pnpm test' },
    { id: 'gate', type: 'gate', label: 'Review the fix' },
    { id: 'land', type: 'land' },
    {
      id: 'swarm',
      type: 'swarm',
      from: '$repro.outputs.tasks',
      child: { harness: 'claude', prompt: 'Implement $task.spec' }
    },
    { id: 'sitter', type: 'pr-sitter' }
  ]
}

describe('pipeline document schema', () => {
  it('exposes the stable node order and applies documented defaults', () => {
    expect(PIPELINE_NODE_TYPES).toEqual([
      'agent',
      'check',
      'script',
      'decision',
      'loop',
      'swarm',
      'merge',
      'gate',
      'land',
      'objective',
      'pr-sitter'
    ])
    const document = PipelineDocumentSchema.parse(SCHEMA_DEFAULTS_DOCUMENT)
    expect(document.nodes.find((node) => node.id === 'check')).toMatchObject({
      timeoutSeconds: 1800
    })
    expect(document.nodes.find((node) => node.id === 'gate')).toMatchObject({ notify: true })
    expect(document.nodes.find((node) => node.id === 'land')).toMatchObject({ draft: false })
    expect(document.nodes.find((node) => node.id === 'swarm')).toMatchObject({
      maxParallel: 5,
      worktree: 'own'
    })
    expect(document.nodes.find((node) => node.id === 'sitter')).toMatchObject({ repeatFixLimit: 3 })
    expect(document.inputs.priority).toEqual({ type: 'number', required: false })
  })

  it('rejects unknown keys, oversized enums and node lists, and non-canonical ids', () => {
    expect(
      PipelineDocumentSchema.safeParse({ ...SCHEMA_DEFAULTS_DOCUMENT, extra: true }).success
    ).toBe(false)
    const oversizedEnum = {
      ...SCHEMA_DEFAULTS_DOCUMENT,
      nodes: [
        {
          id: 'repro',
          type: 'agent',
          prompt: 'Reproduce.',
          outputs: {
            state: { type: 'enum', values: Array.from({ length: 17 }, (_, index) => `${index}`) }
          }
        }
      ]
    }
    expect(PipelineDocumentSchema.safeParse(oversizedEnum).success).toBe(false)
    const oversizedNodes = {
      ...SCHEMA_DEFAULTS_DOCUMENT,
      nodes: Array.from({ length: 65 }, (_, index) => ({
        id: `node-${index}`,
        type: 'agent',
        harness: 'claude',
        prompt: 'Work.'
      }))
    }
    expect(PipelineDocumentSchema.safeParse(oversizedNodes).success).toBe(false)
    expect(
      PipelineDocumentSchema.safeParse({ ...SCHEMA_DEFAULTS_DOCUMENT, id: 'Bugfix' }).success
    ).toBe(false)
  })
})
