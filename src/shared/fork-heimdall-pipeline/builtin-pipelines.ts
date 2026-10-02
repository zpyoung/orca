import type { PipelinePin } from './pipeline-pin'
import { parsePipelineText } from './pipeline-parse'
import { pipelineContentHash } from './pipeline-canonical-hash'

export const BUILTIN_PIPELINE_VERSION = 1
export const BUILTIN_OBJECTIVE_PIPELINE_TEXT = `version: 1
id: objective
name: Objective
nodes:
  - id: objective
    type: objective
    tier: standard
    landingBar: files-on-disk
`
export const BUILTIN_PR_SITTER_PIPELINE_TEXT = `version: 1
id: pr-sitter
name: PR sitter
nodes:
  - id: pr-sitter
    type: pr-sitter
`

export const BUILTIN_PIPELINE_TEXTS = {
  objective: BUILTIN_OBJECTIVE_PIPELINE_TEXT,
  'pr-sitter': BUILTIN_PR_SITTER_PIPELINE_TEXT
} as const
export type BuiltinPipelineId = keyof typeof BUILTIN_PIPELINE_TEXTS

export function builtinPipelinePin(id: BuiltinPipelineId): PipelinePin {
  const parsed = parsePipelineText(BUILTIN_PIPELINE_TEXTS[id])
  if (parsed.document === null) {
    throw new Error(
      `Built-in pipeline ${id} is invalid: ${parsed.errors.map((error) => error.message).join('; ')}`
    )
  }
  return {
    ref: `builtin:${id}`,
    scope: 'builtin',
    id,
    contentHash: pipelineContentHash(parsed.document),
    documentVersion: BUILTIN_PIPELINE_VERSION
  }
}
