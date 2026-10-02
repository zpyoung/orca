import { describe, expect, it } from 'vitest'
import { EnrollInputSchema, type EnrollInput } from '../../shared/fork-heimdall/watcher-types'
import {
  PIPELINE_NODE_TYPES,
  type NodeType
} from '../../shared/fork-heimdall-pipeline/document-schema'
import { HeimdallCommandCapabilityError } from './fleet-environment-transport'
import { BUILTIN_OBJECTIVE_PIPELINE_TEXT } from '../../shared/fork-heimdall-pipeline/builtin-pipelines'
import {
  enrollmentForPipelineCompatibility,
  HeimdallPipelineHostRefusalError
} from './fleet-remote-enrollment-capabilities'

const PIN = {
  ref: 'repo:swarm-demo',
  scope: 'repo',
  id: 'swarm-demo',
  contentHash: `sha256:${'a'.repeat(64)}`,
  documentVersion: 1
} as const

function objectiveInput(): EnrollInput {
  return {
    kind: 'objective',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {},
    pipelinePin: {
      ...PIN,
      ref: 'builtin:objective',
      scope: 'builtin',
      id: 'objective'
    }
  }
}
function repoObjectiveInputWithSource(): EnrollInput {
  return {
    ...objectiveInput(),
    pipelinePin: PIN,
    pipelineSource: { sourceText: BUILTIN_OBJECTIVE_PIPELINE_TEXT }
  }
}

function pipelineInput(): EnrollInput {
  return {
    kind: 'pipeline',
    repoId: 'repo-1',
    worktreeId: 'worktree-1',
    capabilities: {},
    budget: { wallClockActiveMs: null, turns: null },
    kindPayload: {
      schemaVersion: 1,
      pin: PIN,
      document: {
        version: 1,
        id: 'swarm-demo',
        name: 'Swarm demo',
        nodes: [
          {
            id: 'planner',
            type: 'agent',
            harness: 'claude',
            prompt: 'Plan the work.',
            outputs: { tasks: { type: 'taskList' } }
          },
          {
            id: 'swarm',
            type: 'swarm',
            after: ['planner'],
            from: '$planner.outputs.tasks',
            child: { harness: 'claude', prompt: '$task.spec' }
          }
        ]
      },
      sourceText: 'version: 1',
      runInputs: { task: 'Fix the issue' },
      workspaceKind: 'git'
    }
  }
}

const HOST_WITHOUT_SWARM = new Set<NodeType>(PIPELINE_NODE_TYPES.filter((type) => type !== 'swarm'))
const ALL_HOST_NODE_TYPES = new Set<NodeType>(PIPELINE_NODE_TYPES)

describe('remote pipeline enrollment compatibility', () => {
  it('refuses a pipeline when the host lacks the runtime capability', () => {
    let refusal: unknown
    try {
      enrollmentForPipelineCompatibility(pipelineInput(), {
        pipelineSupport: 'unsupported',
        pipelineNodeTypes: ALL_HOST_NODE_TYPES,
        hostLabel: 'buildbox'
      })
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(HeimdallCommandCapabilityError)
    expect(refusal).toHaveProperty(
      'message',
      'The owning runtime does not support Heimdall pipelines. Update the host and try again.'
    )
  })

  it('reports unsupported node types using the validator message and host display name', () => {
    let refusal: unknown
    try {
      enrollmentForPipelineCompatibility(pipelineInput(), {
        pipelineSupport: 'supported',
        pipelineNodeTypes: HOST_WITHOUT_SWARM,
        hostLabel: 'buildbox'
      })
    } catch (error) {
      refusal = error
    }

    expect(refusal).toBeInstanceOf(HeimdallPipelineHostRefusalError)
    expect(refusal).toHaveProperty(
      'message',
      'Update Orca on buildbox to run this pipeline (needs: Swarm)'
    )
  })
  it('requires runtime and node support for a repo-pinned built-in source', () => {
    const input = repoObjectiveInputWithSource()

    expect(() =>
      enrollmentForPipelineCompatibility(input, {
        pipelineSupport: 'unsupported',
        pipelineNodeTypes: ALL_HOST_NODE_TYPES
      })
    ).toThrow(HeimdallCommandCapabilityError)

    const hostWithoutObjective = new Set<NodeType>(
      PIPELINE_NODE_TYPES.filter((type) => type !== 'objective')
    )
    expect(() =>
      enrollmentForPipelineCompatibility(input, {
        pipelineSupport: 'supported',
        pipelineNodeTypes: hostWithoutObjective,
        hostLabel: 'buildbox'
      })
    ).toThrow('Update Orca on buildbox to run this pipeline (needs: Objective)')
  })

  it('refuses a repo or personal pin without its required source snapshot', () => {
    const input = { ...objectiveInput(), pipelinePin: PIN }

    expect(() =>
      enrollmentForPipelineCompatibility(input, {
        pipelineSupport: 'supported',
        pipelineNodeTypes: ALL_HOST_NODE_TYPES
      })
    ).toThrow('A source snapshot is required for a repo or personal pipeline pin.')
  })

  it('strips only the optional pin for a built-in enrollment sent to an old host', () => {
    const input = objectiveInput()
    const compatible = enrollmentForPipelineCompatibility(input, {
      pipelineSupport: 'unknown',
      pipelineNodeTypes: new Set<NodeType>()
    })

    expect(compatible).not.toHaveProperty('pipelinePin')
    expect(compatible.kindPayload).toEqual(input.kindPayload)
  })

  it('keeps the pin when the host advertises pipeline support', () => {
    const input = objectiveInput()

    expect(
      enrollmentForPipelineCompatibility(input, {
        pipelineSupport: 'supported',
        pipelineNodeTypes: new Set<NodeType>()
      })
    ).toBe(input)
  })

  it('accepts a valid input pin and rejects a malformed one', () => {
    const input = objectiveInput()

    expect(EnrollInputSchema.safeParse(input).success).toBe(true)
    expect(
      EnrollInputSchema.safeParse({
        ...input,
        pipelinePin: { ...PIN, contentHash: 'sha256:bad' }
      }).success
    ).toBe(false)
  })
  it('validates the optional pipeline source at its UTF-8 size limit', () => {
    const input = objectiveInput()
    const sourceAtLimit = 'x'.repeat(256 * 1024)

    expect(
      EnrollInputSchema.safeParse({
        ...input,
        pipelineSource: { sourceText: sourceAtLimit }
      }).success
    ).toBe(true)
    expect(
      EnrollInputSchema.safeParse({
        ...input,
        pipelineSource: { sourceText: `${sourceAtLimit}x` }
      }).success
    ).toBe(false)
  })
})
