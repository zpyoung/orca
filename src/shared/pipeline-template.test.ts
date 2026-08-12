import { describe, expect, it } from 'vitest'
import { parsePipelineTemplate, resolvePipelineDefinition } from './pipeline-template'
import { BUGFIX_FAST_STARTER_TEMPLATE } from './pipeline-template-starter'
import type { ParsedPipelineTemplate, PipelineTemplateError } from './pipeline-template'

const VALID_TEMPLATE = `
version: 1
name: test-template
description: A test template.
defaults:
  harness: claude
  onFailure:
    retries: 1
  limits:
    maxMinutes: 5
nodes:
  - id: a
    title: A
    prompt: Do the first thing.
  - id: b
    needs: [a]
    prompt: Do the second thing using {{input}}.
`

function expectError(content: string): PipelineTemplateError {
  const result = parsePipelineTemplate(content, 'test.yaml')
  if (result.ok) {
    throw new Error('expected parse failure, got ok:true')
  }
  return result.error
}

function expectTemplate(content: string): ParsedPipelineTemplate {
  const result = parsePipelineTemplate(content, 'test.yaml')
  if (!result.ok) {
    throw new Error(`expected parse success, got error: ${JSON.stringify(result.error)}`)
  }
  return result.template
}

describe('parsePipelineTemplate: baseline', () => {
  it('accepts a well-formed template', () => {
    const template = expectTemplate(VALID_TEMPLATE)
    expect(template.version).toBe(1)
    expect(template.name).toBe('test-template')
    expect(template.needsNewerOrca).toBe(false)
    expect(template.nodes.map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('defaults name to the file basename without extension when name is absent', () => {
    const content = VALID_TEMPLATE.replace('name: test-template\n', '')
    const template = expectTemplate(content)
    expect(template.name).toBe('test')
  })

  it('never throws on malformed input', () => {
    expect(() => parsePipelineTemplate('{{{ not yaml [', 'test.yaml')).not.toThrow()
    expect(() => parsePipelineTemplate('', 'test.yaml')).not.toThrow()
  })
})

describe('parsePipelineTemplate: T11 rule order and determinism', () => {
  it('reports the first rule when multiple rules are broken (rule 2 before rule 6)', () => {
    const content = VALID_TEMPLATE.replace('version: 1', 'version: 0').replace('id: a', 'id: NOT-VALID')
    const error = expectError(content)
    expect(error.rule).toBe(2)
    expect(error.field).toBe('version')
  })

  it('reports the first rule when multiple rules are broken (rule 6 before rule 7)', () => {
    const content = VALID_TEMPLATE.replace('id: a', 'id: NOT-VALID').replace('harness: claude', 'harness: 5')
    const error = expectError(content)
    expect(error.rule).toBe(6)
  })

  it('reports the first rule when multiple rules are broken (rule 7 before rule 8)', () => {
    const content = VALID_TEMPLATE.replace('harness: claude', '').replace('needs: [a]', 'needs: [unknown-node]')
    const error = expectError(content)
    expect(error.rule).toBe(7)
  })

  it('is deterministic: the same broken template always yields the same error', () => {
    const content = VALID_TEMPLATE.replace('id: b', 'id: a')
    const first = expectError(content)
    const second = expectError(content)
    expect(second).toEqual(first)
  })

  it('reports the earlier node in list order within a rule', () => {
    const content = `
version: 1
nodes:
  - id: first
    prompt: ""
  - id: second
    prompt: ""
`
    const error = expectError(content)
    expect(error.rule).toBe(6)
    expect(error.nodeId).toBe('first')
  })
})

describe('parsePipelineTemplate: T11 rule 1 (YAML parse / root shape)', () => {
  it('fails on YAML that does not parse', () => {
    expect(expectError('version: 1\nversion: 2\nnodes: []\n').rule).toBe(1)
  })

  it('fails when the document root is not a map', () => {
    expect(expectError('- just\n- a\n- list\n').rule).toBe(1)
  })
})

describe('parsePipelineTemplate: T11 rule 2 (version)', () => {
  it('fails when version is missing', () => {
    const content = VALID_TEMPLATE.replace('version: 1\n', '')
    const error = expectError(content)
    expect(error.rule).toBe(2)
    expect(error.field).toBe('version')
  })

  it.each([['"1"'], ['0'], ['-1'], ['1.5']])('fails when version is %s', (value) => {
    const content = VALID_TEMPLATE.replace('version: 1', `version: ${value}`)
    expect(expectError(content).rule).toBe(2)
  })

  it('accepts a version greater than supported and sets needsNewerOrca instead of failing', () => {
    const content = VALID_TEMPLATE.replace('version: 1', 'version: 2')
    const template = expectTemplate(content)
    expect(template.version).toBe(2)
    expect(template.needsNewerOrca).toBe(true)
  })
})

describe('parsePipelineTemplate: T11 rule 3 (name / description)', () => {
  it('fails when name is present but not a string', () => {
    const content = VALID_TEMPLATE.replace('name: test-template', 'name: [1, 2]')
    const error = expectError(content)
    expect(error.rule).toBe(3)
    expect(error.field).toBe('name')
  })

  it('fails when description is present but not a string', () => {
    const content = VALID_TEMPLATE.replace('description: A test template.', 'description: [1, 2]')
    const error = expectError(content)
    expect(error.rule).toBe(3)
    expect(error.field).toBe('description')
  })
})

describe('parsePipelineTemplate: T11 rule 4 (defaults shape)', () => {
  it('fails when defaults is present but not a map', () => {
    const content = 'version: 1\ndefaults: [1, 2]\nnodes:\n  - id: a\n    prompt: hi\n    harness: claude\n'
    const error = expectError(content)
    expect(error.rule).toBe(4)
    expect(error.field).toBe('defaults')
  })

  it('fails when defaults.limits is present but not a map', () => {
    const content = VALID_TEMPLATE.replace('limits:\n    maxMinutes: 5', 'limits: nope')
    const error = expectError(content)
    expect(error.rule).toBe(4)
    expect(error.field).toBe('defaults.limits')
  })

  it('fails when defaults.onFailure is present but not a map', () => {
    const content = VALID_TEMPLATE.replace('onFailure:\n    retries: 1', 'onFailure: nope')
    const error = expectError(content)
    expect(error.rule).toBe(4)
    expect(error.field).toBe('defaults.onFailure')
  })
})

describe('parsePipelineTemplate: T11 rule 5 (nodes)', () => {
  it('fails when nodes is missing', () => {
    const content = 'version: 1\nname: test\n'
    expect(expectError(content).rule).toBe(5)
  })

  it('fails when nodes is not a list', () => {
    const content = 'version: 1\nnodes: {}\n'
    expect(expectError(content).rule).toBe(5)
  })

  it('fails when nodes is empty', () => {
    const content = 'version: 1\nnodes: []\n'
    expect(expectError(content).rule).toBe(5)
  })
})

describe('parsePipelineTemplate: T11 rule 6 (per-node structure)', () => {
  const base = (nodesYaml: string): string => `version: 1\nnodes:\n${nodesYaml}`

  it('fails when a node is not a map', () => {
    const error = expectError(base('  - "just a string"\n'))
    expect(error.rule).toBe(6)
  })

  it('fails when id is missing', () => {
    const error = expectError(base('  - prompt: hi\n    harness: claude\n'))
    expect(error.rule).toBe(6)
    expect(error.field).toBe('id')
  })

  it('fails when id does not match the id pattern', () => {
    const error = expectError(base('  - id: NOT-VALID\n    prompt: hi\n    harness: claude\n'))
    expect(error.rule).toBe(6)
    expect(error.field).toBe('id')
  })

  it('fails on a duplicate id', () => {
    const error = expectError(
      base('  - id: a\n    prompt: hi\n    harness: claude\n  - id: a\n    prompt: hi\n    harness: claude\n')
    )
    expect(error.rule).toBe(6)
    expect(error.nodeId).toBe('a')
    expect(error.message).toContain('Duplicate')
  })

  it('fails when title is present but not a string', () => {
    const error = expectError(base('  - id: a\n    title: [1]\n    prompt: hi\n    harness: claude\n'))
    expect(error.rule).toBe(6)
    expect(error.field).toBe('title')
  })

  it('fails when prompt is missing', () => {
    const error = expectError(base('  - id: a\n    harness: claude\n'))
    expect(error.rule).toBe(6)
    expect(error.field).toBe('prompt')
  })

  it('fails when prompt is empty', () => {
    const error = expectError(base('  - id: a\n    prompt: "   "\n    harness: claude\n'))
    expect(error.rule).toBe(6)
    expect(error.field).toBe('prompt')
  })

  it('fails when needs is present but not a list of strings', () => {
    const error = expectError(base('  - id: a\n    prompt: hi\n    harness: claude\n    needs: [1, 2]\n'))
    expect(error.rule).toBe(6)
    expect(error.field).toBe('needs')
  })

  it('fails when a node limits is present but not a map', () => {
    const error = expectError(base('  - id: a\n    prompt: hi\n    harness: claude\n    limits: nope\n'))
    expect(error.rule).toBe(6)
    expect(error.field).toBe('limits')
  })

  it('fails when a node onFailure is present but not a map', () => {
    const error = expectError(base('  - id: a\n    prompt: hi\n    harness: claude\n    onFailure: nope\n'))
    expect(error.rule).toBe(6)
    expect(error.field).toBe('onFailure')
  })
})

describe('parsePipelineTemplate: T11 rule 7 (value rules)', () => {
  it('fails when defaults.harness is present but not a non-empty string', () => {
    const content = VALID_TEMPLATE.replace('harness: claude', 'harness: ""')
    const error = expectError(content)
    expect(error.rule).toBe(7)
    expect(error.field).toBe('defaults.harness')
  })

  it('fails when a node has no effective harness after merge', () => {
    const content = VALID_TEMPLATE.replace('  harness: claude\n', '')
    const error = expectError(content)
    expect(error.rule).toBe(7)
    expect(error.field).toBe('harness')
    expect(error.nodeId).toBe('a')
  })

  it("a node's own harness satisfies the effective-harness requirement without defaults", () => {
    const content = `
version: 1
nodes:
  - id: a
    prompt: hi
    harness: claude
`
    expect(expectTemplate(content).needsNewerOrca).toBe(false)
  })

  it('fails when model is present but not a string', () => {
    const content = VALID_TEMPLATE.replace('id: a\n    title: A', 'id: a\n    title: A\n    model: [1]')
    const error = expectError(content)
    expect(error.rule).toBe(7)
    expect(error.field).toBe('model')
  })

  it('fails when effort is present but not a string', () => {
    const content = VALID_TEMPLATE.replace('id: a\n    title: A', 'id: a\n    title: A\n    effort: [1]')
    const error = expectError(content)
    expect(error.rule).toBe(7)
    expect(error.field).toBe('effort')
  })

  it('fails when effort is set without an effective model', () => {
    const content = VALID_TEMPLATE.replace('id: a\n    title: A', 'id: a\n    title: A\n    effort: high')
    const error = expectError(content)
    expect(error.rule).toBe(7)
    expect(error.field).toBe('effort')
    expect(error.nodeId).toBe('a')
  })

  it('effort with a defaults-supplied model does not fail', () => {
    const content = VALID_TEMPLATE.replace('harness: claude\n', 'harness: claude\n  model: sonnet\n').replace(
      'id: a\n    title: A',
      'id: a\n    title: A\n    effort: high'
    )
    expect(expectTemplate(content)).toBeTruthy()
  })

  it.each([['1.5'], ['-1'], ['11']])('fails when onFailure.retries is %s', (value) => {
    const content = VALID_TEMPLATE.replace('retries: 1', `retries: ${value}`)
    const error = expectError(content)
    expect(error.rule).toBe(7)
    expect(error.field).toBe('defaults.onFailure.retries')
  })

  it.each([['0'], ['-5'], ['"not a number"']])('fails when limits.maxMinutes is %s', (value) => {
    const content = VALID_TEMPLATE.replace('maxMinutes: 5', `maxMinutes: ${value}`)
    const error = expectError(content)
    expect(error.rule).toBe(7)
    expect(error.field).toBe('defaults.limits.maxMinutes')
  })
})

describe('parsePipelineTemplate: T11 rule 8 (needs references)', () => {
  it('fails when needs names an unknown id', () => {
    const content = VALID_TEMPLATE.replace('needs: [a]', 'needs: [unknown-node]')
    const error = expectError(content)
    expect(error.rule).toBe(8)
    expect(error.nodeId).toBe('b')
  })

  it('fails when a node names itself in needs', () => {
    const content = VALID_TEMPLATE.replace('needs: [a]', 'needs: [b]')
    const error = expectError(content)
    expect(error.rule).toBe(8)
    expect(error.nodeId).toBe('b')
  })
})

describe('parsePipelineTemplate: T11 rule 9 (dependency cycle)', () => {
  it('fails on a two-node cycle', () => {
    const content = `
version: 1
nodes:
  - id: a
    prompt: hi
    harness: claude
    needs: [b]
  - id: b
    prompt: hi
    harness: claude
    needs: [a]
`
    expect(expectError(content).rule).toBe(9)
  })

  it('fails on a longer cycle reached through an intermediate node', () => {
    const content = `
version: 1
nodes:
  - id: a
    prompt: hi
    harness: claude
    needs: [c]
  - id: b
    prompt: hi
    harness: claude
    needs: [a]
  - id: c
    prompt: hi
    harness: claude
    needs: [b]
`
    expect(expectError(content).rule).toBe(9)
  })
})

describe('parsePipelineTemplate: T12 unknown keys never fail resolution', () => {
  it('sets needsNewerOrca for an unrecognized top-level key without failing', () => {
    const content = `${VALID_TEMPLATE}\nfutureTopLevelKey: true\n`
    const template = expectTemplate(content)
    expect(template.needsNewerOrca).toBe(true)
  })

  it('sets needsNewerOrca for an unrecognized key inside defaults', () => {
    const content = VALID_TEMPLATE.replace('harness: claude', 'harness: claude\n  futureKey: true')
    expect(expectTemplate(content).needsNewerOrca).toBe(true)
  })

  it('sets needsNewerOrca for an unrecognized key on a node', () => {
    const content = VALID_TEMPLATE.replace('id: a\n    title: A', 'id: a\n    title: A\n    futureKey: true')
    expect(expectTemplate(content).needsNewerOrca).toBe(true)
  })

  it('sets needsNewerOrca for an unrecognized key inside a node limits map', () => {
    const content = VALID_TEMPLATE.replace(
      'id: a\n    title: A',
      'id: a\n    title: A\n    limits:\n      futureKey: true'
    )
    expect(expectTemplate(content).needsNewerOrca).toBe(true)
  })

  it('sets needsNewerOrca for an unrecognized key inside a node onFailure map', () => {
    const content = VALID_TEMPLATE.replace(
      'id: a\n    title: A',
      'id: a\n    title: A\n    onFailure:\n      futureKey: true'
    )
    expect(expectTemplate(content).needsNewerOrca).toBe(true)
  })

  it('sets needsNewerOrca for an unrecognized key inside defaults.limits / defaults.onFailure', () => {
    const limitsContent = VALID_TEMPLATE.replace('maxMinutes: 5', 'maxMinutes: 5\n    futureKey: true')
    expect(expectTemplate(limitsContent).needsNewerOrca).toBe(true)

    const onFailureContent = VALID_TEMPLATE.replace('retries: 1', 'retries: 1\n    futureKey: true')
    expect(expectTemplate(onFailureContent).needsNewerOrca).toBe(true)
  })

  it('does not set needsNewerOrca when no unrecognized key exists anywhere', () => {
    expect(expectTemplate(VALID_TEMPLATE).needsNewerOrca).toBe(false)
  })
})

describe('resolvePipelineDefinition', () => {
  it('merges defaults field-by-field with the node winning', () => {
    const content = `
version: 1
defaults:
  harness: claude
  model: sonnet
  effort: medium
nodes:
  - id: a
    prompt: hi
  - id: b
    harness: codex
    model: opus
    needs: [a]
    prompt: hi again
`
    const definition = resolvePipelineDefinition(expectTemplate(content), 'the input')
    const [a, b] = definition.nodes
    expect(a.harness).toBe('claude')
    expect(a.model).toBe('sonnet')
    expect(a.effort).toBe('medium')
    expect(b.harness).toBe('codex')
    expect(b.model).toBe('opus')
    expect(b.effort).toBe('medium')
  })

  it('defaults title to id, onFailure.retries to 0, and needs to []', () => {
    const content = 'version: 1\nnodes:\n  - id: a\n    prompt: hi\n    harness: claude\n'
    const definition = resolvePipelineDefinition(expectTemplate(content), '')
    expect(definition.nodes[0]).toMatchObject({ title: 'a', needs: [], onFailure: { retries: 0 } })
  })

  it('preserves nodes list order as index', () => {
    const content = `
version: 1
nodes:
  - id: third
    prompt: hi
    harness: claude
  - id: first
    prompt: hi
    harness: claude
  - id: second
    prompt: hi
    harness: claude
`
    const definition = resolvePipelineDefinition(expectTemplate(content), '')
    expect(definition.nodes.map((n) => [n.id, n.index])).toEqual([
      ['third', 0],
      ['first', 1],
      ['second', 2]
    ])
  })

  it('replaces every literal {{input}} occurrence in prompts', () => {
    const content =
      'version: 1\nnodes:\n  - id: a\n    harness: claude\n    prompt: "{{input}} and again {{input}}"\n'
    const definition = resolvePipelineDefinition(expectTemplate(content), 'BUG-123')
    expect(definition.nodes[0].prompt).toBe('BUG-123 and again BUG-123')
  })

  it('leaves onFailure.retries and limits.maxMinutes unset when neither node nor defaults set them', () => {
    const content = 'version: 1\nnodes:\n  - id: a\n    prompt: hi\n    harness: claude\n'
    const definition = resolvePipelineDefinition(expectTemplate(content), '')
    expect(definition.nodes[0].limits).toBeUndefined()
  })
})

describe('bugfix-fast starter template', () => {
  it('round-trips through parsePipelineTemplate with zero errors and needsNewerOrca: false', () => {
    const result = parsePipelineTemplate(BUGFIX_FAST_STARTER_TEMPLATE, 'bugfix-fast.yaml')
    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.template.needsNewerOrca).toBe(false)
    expect(result.template.name).toBe('bugfix-fast')
    expect(result.template.nodes.map((n) => n.id)).toEqual(['repro', 'fix', 'test', 'pr'])
  })

  it('resolves with every node carrying an effective harness and substituted input', () => {
    const template = expectTemplate(BUGFIX_FAST_STARTER_TEMPLATE)
    const definition = resolvePipelineDefinition(template, 'Buttons do not respond to clicks.')
    expect(definition.nodes.every((n) => n.harness === 'claude')).toBe(true)
    expect(definition.nodes[0].prompt).toContain('Buttons do not respond to clicks.')
    expect(definition.nodes[0].prompt).not.toContain('{{input}}')
    expect(definition.nodes.map((n) => n.needs)).toEqual([[], ['repro'], ['fix'], ['test']])
  })
})
