import { describe, expect, it } from 'vitest'
import { parsePipelineText } from './pipeline-parse'

const BUGFIX_YAML = `version: 1
id: bugfix
name: Bugfix (fast)
defaults:
  harness: claude
nodes:
  - id: repro
    type: agent
    prompt: 'Reproduce: $run.inputs.task'
    outputs:
      summary:
        type: text
  - id: fix
    type: agent
    after: [repro]
    prompt: 'Fix it. Repro notes: $repro.outputs.summary'
  - id: check
    type: check
    after: [fix]
    command: pnpm test
  - id: land
    type: land
    after: [check]
`

describe('parsePipelineText', () => {
  it('parses Bugfix and maps source ranges to complete node blocks', () => {
    const result = parsePipelineText(BUGFIX_YAML)
    expect(result.document).not.toBeNull()
    expect(result.errors).toEqual([])
    const range = result.sourceMap.get('fix')
    expect(range).toBeDefined()
    expect(range?.start).toBeLessThan(range?.end ?? 0)
    expect(BUGFIX_YAML.slice(range?.start, range?.end)).toContain('id: fix')
  })

  it('reports YAML syntax errors, duplicate keys, size limits, versions, unknown types and schema issues', () => {
    const syntax = parsePipelineText('nodes: [')
    expect(syntax.document).toBeNull()
    expect(syntax.sourceDocument).toBeUndefined()

    const duplicate = parsePipelineText(
      'version: 1\nid: bugfix\nname: First\nname: Second\nnodes: []'
    )
    expect(duplicate.errors[0]?.code).toBe('yaml-parse')

    const oversized = parsePipelineText('x'.repeat(262_145))
    expect(oversized.errors[0]?.code).toBe('yaml-parse')

    const unsupported = parsePipelineText('version: 2\nid: bugfix\nname: Bugfix\nnodes: []')
    expect(unsupported.document).toBeNull()
    expect(unsupported.errors).toEqual([
      expect.objectContaining({ nodeId: null, code: 'schema-version-unsupported' })
    ])

    const unknown = parsePipelineText(
      'version: 1\nid: bugfix\nname: Bugfix\nnodes:\n  - id: warp\n    type: teleport'
    )
    expect(unknown.document).toBeNull()
    expect(unknown.errors).toEqual([
      expect.objectContaining({ nodeId: 'warp', code: 'unknown-node-type' })
    ])

    const schema = parsePipelineText('version: 1\nid: bad\nname: Missing node\nnodes: []')
    expect(schema.errors[0]?.code).toBe('schema')
  })

  it('preserves decoded YAML for an unfinished schema-invalid draft without applying defaults', () => {
    const result = parsePipelineText(`version: 1
id: unfinished
name: Unfinished
nodes:
  - id: draft
    type: agent
    label: Add prompt later
    harness: claude
`)
    expect(result.document).toBeNull()
    expect(result.errors).toContainEqual(
      expect.objectContaining({ nodeId: 'draft', code: 'schema' })
    )
    expect(result.sourceDocument).toEqual({
      version: 1,
      id: 'unfinished',
      name: 'Unfinished',
      nodes: [{ id: 'draft', type: 'agent', label: 'Add prompt later', harness: 'claude' }]
    })
  })
})
