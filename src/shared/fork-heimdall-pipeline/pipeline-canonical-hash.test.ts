import { describe, expect, it } from 'vitest'
import { PipelineDocumentSchema, type PipelineDocument } from './document-schema'
import { canonicalPipelineJson, pipelineContentHash } from './pipeline-canonical-hash'
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

function parsedDocument(text: string): PipelineDocument {
  const parsed = parsePipelineText(text)
  if (parsed.document === null) {
    throw new Error(parsed.errors.map((error) => error.message).join('; '))
  }
  return parsed.document
}

describe('pipeline canonical hash', () => {
  it('ignores object key order and YAML comments but changes for semantic edits', () => {
    const left = PipelineDocumentSchema.parse({
      version: 1,
      id: 'bugfix',
      name: 'Bugfix',
      nodes: [{ id: 'land', type: 'land' }]
    })
    const right = PipelineDocumentSchema.parse({
      nodes: [{ type: 'land', id: 'land' }],
      name: 'Bugfix',
      id: 'bugfix',
      version: 1
    })
    expect(pipelineContentHash(left)).toBe(pipelineContentHash(right))

    const original = parsedDocument(BUGFIX_YAML)
    expect(pipelineContentHash(original)).toBe(
      pipelineContentHash(parsedDocument(`# comment\n${BUGFIX_YAML}`))
    )

    const changed = PipelineDocumentSchema.parse({
      ...original,
      nodes: original.nodes.map((node) =>
        node.id === 'check' && node.type === 'check' ? { ...node, command: 'pnpm lint' } : node
      )
    })
    expect(pipelineContentHash(original)).not.toBe(pipelineContentHash(changed))
    expect(pipelineContentHash(original)).toMatch(/^sha256:[0-9a-f]{64}$/u)
  })

  it('serializes a parsed document without whitespace outside JSON strings', () => {
    const canonical = canonicalPipelineJson(parsedDocument(BUGFIX_YAML))
    expect(canonical).toBe(JSON.stringify(JSON.parse(canonical)))
  })
})
