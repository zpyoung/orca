import { describe, expect, it } from 'vitest'
import { validatePipeline } from './pipeline-validate'
import {
  BUILTIN_OBJECTIVE_PIPELINE_TEXT,
  BUILTIN_PIPELINE_VERSION,
  BUILTIN_PR_SITTER_PIPELINE_TEXT,
  builtinPipelinePin
} from './builtin-pipelines'
import { parsePipelineText } from './pipeline-parse'
import { pipelineContentHash } from './pipeline-canonical-hash'

describe('built-in pipelines', () => {
  it('parses and validates both built-in documents', () => {
    const objective = parsePipelineText(BUILTIN_OBJECTIVE_PIPELINE_TEXT)
    const sitter = parsePipelineText(BUILTIN_PR_SITTER_PIPELINE_TEXT)
    expect(objective.errors).toEqual([])
    expect(sitter.errors).toEqual([])
    expect(objective.document).not.toBeNull()
    expect(sitter.document).not.toBeNull()
    if (objective.document === null || sitter.document === null) {
      throw new Error('Built-in documents must parse')
    }
    expect(validatePipeline(objective.document, { workspaceKind: 'git' })).toEqual([])
    expect(validatePipeline(sitter.document, { workspaceKind: 'git' })).toEqual([])
    expect(objective.document).toMatchObject({
      version: 1,
      id: 'objective',
      name: 'Objective',
      nodes: [{ id: 'objective', type: 'objective', tier: 'standard', landingBar: 'files-on-disk' }]
    })
    expect(sitter.document).toMatchObject({
      version: 1,
      id: 'pr-sitter',
      name: 'PR sitter',
      nodes: [{ id: 'pr-sitter', type: 'pr-sitter' }]
    })
  })

  it('pins the canonical built-in objective document at version one', () => {
    const parsed = parsePipelineText(BUILTIN_OBJECTIVE_PIPELINE_TEXT)
    if (parsed.document === null) {
      throw new Error('Built-in objective must parse')
    }
    expect(BUILTIN_PIPELINE_VERSION).toBe(1)
    expect(builtinPipelinePin('objective')).toEqual({
      ref: 'builtin:objective',
      scope: 'builtin',
      id: 'objective',
      contentHash: pipelineContentHash(parsed.document),
      documentVersion: 1
    })
  })
})
