import { describe, expect, it } from 'vitest'
import { PipelineDocumentSchema, PIPELINE_NODE_TYPES } from './document-schema'
import { parsePipelineText } from './pipeline-parse'
import { validatePipeline, type PipelineValidationError } from './pipeline-validate'

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

function document(nodes: unknown[], fields: Record<string, unknown> = {}) {
  return PipelineDocumentSchema.parse({ version: 1, id: 'work', name: 'Work', ...fields, nodes })
}

function pairs(errors: readonly PipelineValidationError[]) {
  return errors.map(({ nodeId, code }) => ({ nodeId, code }))
}

describe('validatePipeline', () => {
  it('validates the saved Bugfix graph and reports missing fields and identity mismatches', () => {
    const parsed = parsePipelineText(BUGFIX_YAML)
    if (parsed.document === null) {
      throw new Error('Bugfix fixture must parse')
    }
    expect(validatePipeline(parsed.document, { workspaceKind: 'git' })).toEqual([])
    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'repro', type: 'agent', prompt: 'Reproduce.' },
            { id: 'fix', type: 'agent', harness: 'claude', after: ['ghost'], prompt: 'Fix.' }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([
      { nodeId: 'repro', code: 'missing-field' },
      { nodeId: 'fix', code: 'dangling-edge' }
    ])
    expect(
      pairs(
        validatePipeline(document([{ id: 'land', type: 'land' }]), {
          workspaceKind: 'git',
          expectedId: 'other'
        })
      )
    ).toEqual([{ nodeId: null, code: 'id-mismatch' }])
  })

  it('reports duplicate ids and every node in an after-cycle', () => {
    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'same', type: 'agent', harness: 'claude', prompt: 'A.' },
            { id: 'same', type: 'check', command: 'pnpm test' }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'same', code: 'duplicate-node-id' }])
    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'a', type: 'check', command: 'a', after: ['b'] },
            { id: 'b', type: 'check', command: 'b', after: ['a'] }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([
      { nodeId: 'a', code: 'cycle' },
      { nodeId: 'b', code: 'cycle' }
    ])
  })

  it('checks output declarations, upstream references and decision conditions', () => {
    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'planner', type: 'agent', harness: 'claude', prompt: 'Plan.' },
            { id: 'decision', type: 'decision', after: ['planner'], on: '$planner.outputs.missing' }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'decision', code: 'invalid-output-ref' }])

    expect(
      pairs(
        validatePipeline(
          document([
            {
              id: 'planner',
              type: 'agent',
              harness: 'claude',
              prompt: 'Plan.',
              outputs: { plan: { type: 'text' } }
            },
            { id: 'writer', type: 'agent', harness: 'claude', prompt: 'Use $planner.outputs.plan' }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'writer', code: 'ref-not-upstream' }])

    expect(
      pairs(
        validatePipeline(
          document([
            {
              id: 'planner',
              type: 'agent',
              harness: 'claude',
              prompt: 'Plan.',
              outputs: { state: { type: 'enum', values: ['ready', 'blocked'] } }
            },
            { id: 'decision', type: 'decision', after: ['planner'], on: '$planner.outputs.state' },
            {
              id: 'ready',
              type: 'check',
              command: 'true',
              after: [{ node: 'decision', when: 'pending' }]
            }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'ready', code: 'decision-when-unknown' }])

    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'planner', type: 'agent', harness: 'claude', prompt: 'Plan.' },
            {
              id: 'ready',
              type: 'check',
              command: 'true',
              after: [{ node: 'planner', when: 'ready' }]
            }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'ready', code: 'when-without-decision' }])
  })

  it('uses own output keys and accepts explicitly declared prototype-named outputs', () => {
    const missing = document([
      { id: 'planner', type: 'agent', harness: 'claude', prompt: 'Plan.' },
      {
        id: 'writer',
        type: 'agent',
        harness: 'claude',
        after: ['planner'],
        prompt: 'Use $planner.outputs.constructor'
      }
    ])
    expect(pairs(validatePipeline(missing, { workspaceKind: 'git' }))).toEqual([
      { nodeId: 'writer', code: 'invalid-output-ref' }
    ])

    const declared = document([
      {
        id: 'planner',
        type: 'agent',
        harness: 'claude',
        prompt: 'Plan.',
        outputs: {
          constructor: { type: 'text' },
          toString: { type: 'text' }
        }
      },
      {
        id: 'writer',
        type: 'agent',
        harness: 'claude',
        after: ['planner'],
        prompt: 'Use $planner.outputs.constructor and $planner.outputs.toString'
      }
    ])
    expect(validatePipeline(declared, { workspaceKind: 'git' })).toEqual([])

    const missingDecisionOutput = document([
      { id: 'planner', type: 'agent', harness: 'claude', prompt: 'Plan.' },
      { id: 'decision', type: 'decision', after: ['planner'], on: '$planner.outputs.constructor' },
      {
        id: 'branch',
        type: 'check',
        command: 'true',
        after: [{ node: 'decision', when: 'approve' }]
      }
    ])
    expect(pairs(validatePipeline(missingDecisionOutput, { workspaceKind: 'git' }))).toEqual([
      { nodeId: 'decision', code: 'invalid-output-ref' }
    ])
  })

  it('rejects a decision on an output the runtime cannot branch on', () => {
    for (const type of ['json', 'file', 'taskList']) {
      const doc = document([
        {
          id: 'planner',
          type: 'agent',
          harness: 'claude',
          prompt: 'Plan.',
          outputs: { result: { type } }
        },
        { id: 'decision', type: 'decision', after: ['planner'], on: '$planner.outputs.result' }
      ])
      expect(pairs(validatePipeline(doc, { workspaceKind: 'git' }))).toEqual([
        { nodeId: 'decision', code: 'invalid-output-ref' }
      ])
    }
    const branchable = document([
      {
        id: 'planner',
        type: 'agent',
        harness: 'claude',
        prompt: 'Plan.',
        outputs: {
          a: { type: 'enum', values: ['x', 'y'] },
          b: { type: 'boolean' },
          c: { type: 'verdict' },
          d: { type: 'text' },
          e: { type: 'number' }
        }
      },
      ...['a', 'b', 'c', 'd', 'e'].map((name) => ({
        id: `decide-${name}`,
        type: 'decision',
        after: ['planner'],
        on: `$planner.outputs.${name}`
      }))
    ])
    expect(validatePipeline(branchable, { workspaceKind: 'git' })).toEqual([])
  })

  it('rejects references to swarm outputs because child outputs are keyed per task', () => {
    const doc = document([
      {
        id: 'planner',
        type: 'agent',
        harness: 'claude',
        prompt: 'Plan.',
        outputs: { tasks: { type: 'taskList' } }
      },
      {
        id: 'fanout',
        type: 'swarm',
        after: ['planner'],
        from: '$planner.outputs.tasks',
        child: {
          harness: 'claude',
          prompt: '$task.spec',
          outputs: { summary: { type: 'text' } }
        }
      },
      {
        id: 'after',
        type: 'agent',
        harness: 'claude',
        after: ['fanout'],
        prompt: 'Summarize $fanout.outputs.summary'
      }
    ])
    expect(pairs(validatePipeline(doc, { workspaceKind: 'git' }))).toEqual([
      { nodeId: 'after', code: 'invalid-output-ref' }
    ])
  })

  it('validates output references in swarm child prompts', () => {
    const unknown = document([
      {
        id: 'planner',
        type: 'agent',
        harness: 'claude',
        prompt: 'Plan.',
        outputs: { tasks: { type: 'taskList' } }
      },
      {
        id: 'swarm',
        type: 'swarm',
        after: ['planner'],
        from: '$planner.outputs.tasks',
        child: { harness: 'claude', prompt: 'Implement $ghost.outputs.plan for $task.spec' }
      }
    ])
    expect(pairs(validatePipeline(unknown, { workspaceKind: 'git' }))).toEqual([
      { nodeId: 'swarm', code: 'dangling-edge' }
    ])

    const unrelated = document([
      {
        id: 'planner',
        type: 'agent',
        harness: 'claude',
        prompt: 'Plan.',
        outputs: { tasks: { type: 'taskList' } }
      },
      {
        id: 'other',
        type: 'agent',
        harness: 'claude',
        prompt: 'Other work.',
        outputs: { plan: { type: 'text' } }
      },
      {
        id: 'swarm',
        type: 'swarm',
        after: ['planner'],
        from: '$planner.outputs.tasks',
        child: { harness: 'claude', prompt: 'Implement $other.outputs.plan for $task.spec' }
      }
    ])
    expect(pairs(validatePipeline(unrelated, { workspaceKind: 'git' }))).toEqual([
      { nodeId: 'swarm', code: 'ref-not-upstream' }
    ])
  })

  it('checks loop body ordering and verdict conditions', () => {
    expect(
      pairs(
        validatePipeline(
          document([
            {
              id: 'first',
              type: 'agent',
              harness: 'claude',
              prompt: 'First.',
              outputs: { verdict: { type: 'verdict' } }
            },
            { id: 'second', type: 'agent', harness: 'claude', prompt: 'Second.' },
            {
              id: 'loop',
              type: 'loop',
              body: ['first', 'second'],
              until: '$first.outputs.verdict',
              maxRounds: 2
            }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'loop', code: 'loop-body-invalid' }])

    expect(
      pairs(
        validatePipeline(
          document([
            {
              id: 'first',
              type: 'agent',
              harness: 'claude',
              prompt: 'First.',
              outputs: { verdict: { type: 'text' } }
            },
            {
              id: 'loop',
              type: 'loop',
              body: ['first'],
              until: '$first.outputs.verdict',
              maxRounds: 2
            }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'loop', code: 'loop-until-invalid' }])
  })

  it('enforces folder workspace capabilities for git-only nodes and owned swarm worktrees', () => {
    const bugfix = parsePipelineText(BUGFIX_YAML).document
    if (bugfix === null) {
      throw new Error('Bugfix fixture must parse')
    }
    expect(pairs(validatePipeline(bugfix, { workspaceKind: 'folder' }))).toEqual([
      { nodeId: 'land', code: 'git-only-node-in-folder' }
    ])
    expect(
      pairs(
        validatePipeline(
          document([
            {
              id: 'planner',
              type: 'agent',
              harness: 'claude',
              prompt: 'Plan.',
              outputs: { tasks: { type: 'taskList' } }
            },
            {
              id: 'swarm',
              type: 'swarm',
              after: ['planner'],
              from: '$planner.outputs.tasks',
              worktree: 'shared',
              child: { harness: 'claude', prompt: '$task.spec' }
            }
          ]),
          { workspaceKind: 'folder' }
        )
      )
    ).toEqual([])
    const ownedSwarm = document([
      {
        id: 'planner',
        type: 'agent',
        harness: 'claude',
        prompt: 'Plan.',
        outputs: { tasks: { type: 'taskList' } }
      },
      {
        id: 'swarm',
        type: 'swarm',
        after: ['planner'],
        from: '$planner.outputs.tasks',
        child: { harness: 'claude', prompt: '$task.spec' }
      }
    ])
    expect(pairs(validatePipeline(ownedSwarm, { workspaceKind: 'folder' }))).toEqual([
      { nodeId: 'swarm', code: 'own-worktree-in-folder' }
    ])
  })

  it('enforces composite placement, sitter and Land cardinality, and merge sources', () => {
    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'objective', type: 'objective', tier: 'standard', landingBar: 'files-on-disk' },
            { id: 'check', type: 'check', command: 'pnpm test' }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'objective', code: 'objective-not-sole-node' }])

    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'land', type: 'land' },
            { id: 'sitter-a', type: 'pr-sitter', after: ['land'] },
            { id: 'sitter-b', type: 'pr-sitter', after: ['land'] }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'sitter-b', code: 'multiple-pr-sitter' }])

    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'check', type: 'check', command: 'pnpm test' },
            { id: 'sitter', type: 'pr-sitter', after: ['check'] }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'sitter', code: 'pr-sitter-without-land' }])

    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'land-a', type: 'land' },
            { id: 'land-b', type: 'land' }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'land-b', code: 'multiple-land' }])

    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'agent', type: 'agent', harness: 'claude', prompt: 'Work.' },
            { id: 'merge', type: 'merge', from: 'agent' }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'merge', code: 'merge-source-not-swarm' }])
  })

  it('checks send-back ancestry and rejects internal or unknown capability requests', () => {
    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'planner', type: 'agent', harness: 'claude', prompt: 'Plan.' },
            { id: 'gate', type: 'gate', label: 'Review', sendBackTo: 'planner' }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'gate', code: 'send-back-not-ancestor' }])
    expect(
      pairs(
        validatePipeline(
          document([{ id: 'check', type: 'check', command: 'pnpm test' }], {
            capabilities: { mystery: 'on', gate: 'on' }
          }),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([
      { nodeId: null, code: 'capability-unknown' },
      { nodeId: null, code: 'capability-unknown' }
    ])
  })

  it('reports an exact single host compatibility message ordered by node type', () => {
    const pipeline = document([
      {
        id: 'planner',
        type: 'agent',
        harness: 'claude',
        prompt: 'Plan.',
        outputs: { tasks: { type: 'taskList' } }
      },
      {
        id: 'swarm',
        type: 'swarm',
        after: ['planner'],
        from: '$planner.outputs.tasks',
        child: { harness: 'claude', prompt: '$task.spec' }
      },
      { id: 'merge', type: 'merge', after: ['swarm'], from: 'swarm' }
    ])
    const supported = new Set(
      PIPELINE_NODE_TYPES.filter((type) => type !== 'swarm' && type !== 'merge')
    )
    expect(
      validatePipeline(pipeline, {
        workspaceKind: 'git',
        hostNodeTypes: supported,
        hostLabel: 'buildbox'
      })
    ).toEqual([
      expect.objectContaining({
        nodeId: null,
        code: 'node-type-unsupported-by-host',
        message: 'Update Orca on buildbox to run this pipeline (needs: Swarm, Merge)'
      })
    ])
    const onlySwarmMissing = new Set(PIPELINE_NODE_TYPES.filter((type) => type !== 'swarm'))
    expect(
      validatePipeline(pipeline, { workspaceKind: 'git', hostNodeTypes: onlySwarmMissing })[0]
        ?.message
    ).toBe('Update Orca on this host to run this pipeline (needs: Swarm)')
  })

  it('rejects script references in commands and denied environment names, and is deterministic', () => {
    expect(
      pairs(
        validatePipeline(
          document([
            { id: 'script', type: 'script', command: 'echo $run.inputs.task', capability: 'script' }
          ]),
          { workspaceKind: 'git' }
        )
      )
    ).toEqual([{ nodeId: 'script', code: 'ref-in-script-command' }])
    const denied = document([
      {
        id: 'script',
        type: 'script',
        command: 'echo ok',
        capability: 'script',
        inputs: { PATH: '$run.inputs.task' }
      }
    ])
    expect(pairs(validatePipeline(denied, { workspaceKind: 'git' }))).toEqual([
      { nodeId: 'script', code: 'script-env-denied' }
    ])
    const first = validatePipeline(denied, { workspaceKind: 'git' })
    expect(validatePipeline(denied, { workspaceKind: 'git' })).toEqual(first)
  })
})
