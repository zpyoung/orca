import { describe, expect, it } from 'vitest'
import { ObjectiveEnrollmentPayloadSchema } from '../fork-heimdall-objective/contract-types'
import {
  BUILTIN_OBJECTIVE_PIPELINE_TEXT,
  BUILTIN_PR_SITTER_PIPELINE_TEXT
} from './builtin-pipelines'
import {
  objectiveKindPayloadFromDocument,
  PipelineRoutingError,
  routeEnrollmentKind,
  sitterKindPayloadFromDocument
} from './enrollment-routing'
import { parsePipelineText } from './pipeline-parse'
import type { PipelineDocument } from './document-schema'

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

function requireDocument(text: string): PipelineDocument {
  const result = parsePipelineText(text)
  if (result.document === null) {
    throw new Error(result.errors.map((error) => error.message).join('; '))
  }
  return result.document
}

describe('pipeline enrollment routing', () => {
  it('routes built-ins, sole composites and ordinary graphs to their stored kinds', () => {
    expect(routeEnrollmentKind(requireDocument(BUILTIN_OBJECTIVE_PIPELINE_TEXT))).toBe('objective')
    expect(routeEnrollmentKind(requireDocument(BUILTIN_PR_SITTER_PIPELINE_TEXT))).toBe(
      'hosted-review'
    )
    expect(routeEnrollmentKind(requireDocument(BUGFIX_YAML))).toBe('pipeline')
  })

  it('builds objective and sitter payloads from their sole composite nodes', () => {
    const objectiveDocument = requireDocument(`version: 1
id: objective
name: Objective
nodes:
  - id: objective
    type: objective
    tier: standard
    landingBar: files-on-disk
    checks:
      - name: lint
        command: pnpm lint
        timeoutSeconds: 600
`)
    const objectivePayload = objectiveKindPayloadFromDocument(objectiveDocument, {
      objectiveText: 'Implement the objective',
      workspaceKind: 'git'
    })
    expect(objectivePayload.gates).toEqual([
      { name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 }
    ])
    expect(objectivePayload.writeTerritory).toEqual(['**'])
    expect(ObjectiveEnrollmentPayloadSchema.safeParse(objectivePayload).success).toBe(true)

    const sitterDocument = requireDocument(BUILTIN_PR_SITTER_PIPELINE_TEXT)
    expect(sitterKindPayloadFromDocument(sitterDocument)).toEqual({
      branchUpdateMode: 'merge-base-update',
      mergeMethod: null,
      mergeCheckScope: 'all',
      repeatFixLimit: 3
    })
    expect(() =>
      objectiveKindPayloadFromDocument(requireDocument(BUGFIX_YAML), {
        objectiveText: 'Implement the objective',
        workspaceKind: 'git'
      })
    ).toThrow(PipelineRoutingError)
  })
})
