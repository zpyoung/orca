import { describe, expect, it } from 'vitest'
import { parsePipelineText } from '../../../shared/fork-heimdall-pipeline/pipeline-parse'
import { recoverPipelineDraftDocument } from './pipeline-canvas-source-recovery'

const INCOMPLETE_PIPELINE = `version: 1
id: unfinished
name: Unfinished pipeline
inputs: {}
nodes:
  - id: prepare
    type: agent
    label: Add an agent prompt
    prompt: ''
  - id: check-empty
    type: check
    label: Add a validation command
    command: ''
    timeoutSeconds: 0
  - id: check-missing
    type: check
    label: Configure another check
  - id: repeat
    type: loop
    label: Define the loop
    body: []
    until: ''
`

describe('recoverPipelineDraftDocument', () => {
  it('preserves incomplete node identity and source values from the decoded YAML root', () => {
    const parsed = parsePipelineText(INCOMPLETE_PIPELINE)
    expect(parsed.document).toBeNull()
    expect(parsed.sourceDocument).toEqual({
      version: 1,
      id: 'unfinished',
      name: 'Unfinished pipeline',
      inputs: {},
      nodes: [
        { id: 'prepare', type: 'agent', label: 'Add an agent prompt', prompt: '' },
        {
          id: 'check-empty',
          type: 'check',
          label: 'Add a validation command',
          command: '',
          timeoutSeconds: 0
        },
        { id: 'check-missing', type: 'check', label: 'Configure another check' },
        { id: 'repeat', type: 'loop', label: 'Define the loop', body: [], until: '' }
      ]
    })

    const recovered = recoverPipelineDraftDocument(parsed.sourceDocument)
    expect(recovered).not.toBeNull()
    expect(recovered?.id).toBe('unfinished')
    expect(recovered?.name).toBe('Unfinished pipeline')
    expect(recovered?.nodes.map(({ id, type, label }) => ({ id, type, label }))).toEqual([
      { id: 'prepare', type: 'agent', label: 'Add an agent prompt' },
      { id: 'check-empty', type: 'check', label: 'Add a validation command' },
      { id: 'check-missing', type: 'check', label: 'Configure another check' },
      { id: 'repeat', type: 'loop', label: 'Define the loop' }
    ])
    expect(recovered?.nodes[0]).toMatchObject({ prompt: '' })
    expect(recovered?.nodes[0]).not.toHaveProperty('harness')
    expect(recovered?.nodes[1]).toMatchObject({ command: '', timeoutSeconds: 0 })
    expect(recovered?.nodes[2]).toMatchObject({ command: '' })
    expect(recovered?.nodes[3]).toMatchObject({ body: [], until: '' })
    expect(recovered).not.toHaveProperty('defaults')
  })

  it('preserves an explicitly empty top-level node list', () => {
    const parsed = parsePipelineText(`version: 1
id: empty
name: Empty pipeline
inputs: {}
nodes: []
`)
    expect(parsed.document).toBeNull()
    expect(parsed.sourceDocument).toEqual({
      version: 1,
      id: 'empty',
      name: 'Empty pipeline',
      inputs: {},
      nodes: []
    })

    expect(recoverPipelineDraftDocument(parsed.sourceDocument)).toMatchObject({
      id: 'empty',
      name: 'Empty pipeline',
      nodes: []
    })
  })

  it.each([
    {
      recoveryFailure: 'unknown node type',
      yaml: `version: 1\nid: malformed\nname: Malformed pipeline\ninputs: {}\nnodes:\n  - id: warp\n    type: teleport\n`
    },
    {
      recoveryFailure: 'unrepresentable known node',
      yaml: `version: 1\nid: malformed\nname: Malformed pipeline\ninputs: {}\nnodes:\n  - id: check\n    type: check\n    command: echo ok\n    plugin: custom\n`
    }
  ])('returns null for $recoveryFailure', ({ yaml }) => {
    const parsed = parsePipelineText(yaml)
    expect(parsed.document).toBeNull()
    expect(parsed.sourceDocument).toBeDefined()
    expect(recoverPipelineDraftDocument(parsed.sourceDocument)).toBeNull()
  })
})
