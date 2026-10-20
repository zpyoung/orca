import { describe, expect, it } from 'vitest'
import { PipelineDocumentSchema, type PipelineNode } from './document-schema'
import { defaultGrants, PIPELINE_CAPABILITY_KEYS, requestedCapabilities } from './capability-grants'

describe('pipeline capability requests and grants', () => {
  it('requests node needs and clamps only push and merge defaults', () => {
    const document = PipelineDocumentSchema.parse({
      version: 1,
      id: 'work',
      name: 'Work',
      capabilities: { merge: 'on', push: 'on', agent: 'on' },
      nodes: [{ id: 'land', type: 'land' }]
    })
    expect(PIPELINE_CAPABILITY_KEYS).toEqual([
      'agent',
      'check',
      'script',
      'integrate',
      'push',
      'land',
      'updateBranch',
      'resolveConflicts',
      'fixChecks',
      'merge',
      'gate',
      'pipeline'
    ])
    expect(defaultGrants(requestedCapabilities(document))).toMatchObject({
      merge: 'gated',
      push: 'gated',
      agent: 'on'
    })
    expect(defaultGrants({ push: 'off' }).push).toBe('off')
    expect(Object.hasOwn(defaultGrants(requestedCapabilities(document)), 'gate')).toBe(false)
    expect(Object.hasOwn(defaultGrants(requestedCapabilities(document)), 'pipeline')).toBe(false)
    const bugfix = PipelineDocumentSchema.parse({
      version: 1,
      id: 'bugfix',
      name: 'Bugfix (fast)',
      defaults: { harness: 'claude' },
      nodes: [
        {
          id: 'repro',
          type: 'agent',
          prompt: 'Reproduce: $run.inputs.task',
          outputs: { summary: { type: 'text' } }
        },
        { id: 'fix', type: 'agent', after: ['repro'], prompt: 'Fix $repro.outputs.summary' },
        { id: 'check', type: 'check', after: ['fix'], command: 'pnpm test' },
        { id: 'land', type: 'land', after: ['check'] }
      ]
    })
    expect(requestedCapabilities(bugfix)).toEqual({
      agent: 'gated',
      check: 'gated',
      push: 'gated',
      land: 'gated'
    })
  })

  it('fills implicit needs for every node kind without granting engine-internal keys', () => {
    const needs: Readonly<Record<PipelineNode['type'], string[]>> = {
      agent: ['agent'],
      check: ['check'],
      script: ['push'],
      decision: [],
      loop: [],
      swarm: ['agent'],
      merge: ['integrate', 'agent'],
      gate: [],
      land: ['push', 'land'],
      objective: [],
      'pr-sitter': ['updateBranch', 'resolveConflicts', 'fixChecks', 'merge']
    }
    const examples = [
      { type: 'agent', node: { id: 'agent', type: 'agent', harness: 'claude', prompt: 'Work.' } },
      { type: 'check', node: { id: 'check', type: 'check', command: 'pnpm test' } },
      {
        type: 'script',
        node: { id: 'script', type: 'script', command: 'echo ok', capability: 'push' }
      },
      { type: 'decision', node: { id: 'decision', type: 'decision', on: '$agent.outputs.result' } },
      {
        type: 'loop',
        node: {
          id: 'loop',
          type: 'loop',
          body: ['agent'],
          until: '$agent.outputs.verdict',
          maxRounds: 1
        }
      },
      {
        type: 'swarm',
        node: {
          id: 'swarm',
          type: 'swarm',
          from: '$agent.outputs.tasks',
          child: { harness: 'claude', prompt: '$task.spec' }
        }
      },
      { type: 'merge', node: { id: 'merge', type: 'merge', from: 'swarm' } },
      { type: 'gate', node: { id: 'gate', type: 'gate', label: 'Review' } },
      { type: 'land', node: { id: 'land', type: 'land' } },
      {
        type: 'objective',
        node: { id: 'objective', type: 'objective', tier: 'standard', landingBar: 'files-on-disk' }
      },
      { type: 'pr-sitter', node: { id: 'sitter', type: 'pr-sitter' } }
    ] as const
    for (const example of examples) {
      const document = PipelineDocumentSchema.parse({
        version: 1,
        id: 'work',
        name: 'Work',
        nodes: [example.node]
      })
      expect(Object.keys(requestedCapabilities(document)).sort()).toEqual(
        needs[example.type].sort()
      )
    }
    const script = PipelineDocumentSchema.parse({
      version: 1,
      id: 'work',
      name: 'Work',
      nodes: [{ id: 'script', type: 'script', command: 'echo ok', capability: 'script' }]
    })
    expect(requestedCapabilities(script)).toEqual({ script: 'gated' })
  })
})
