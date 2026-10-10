import { describe, expect, it } from 'vitest'
import {
  PipelineDocumentSchema,
  type PipelineDocument,
  type PipelineNode
} from '../document-schema'
import { parsePipelineText } from '../pipeline-parse'
import {
  PipelineEditTargetError,
  PipelineSourceUnparseableError,
  applyPipelineEdits,
  renderNewPipeline,
  renderPipelineLayout
} from './index'

const FIXTURE = `# writer header
version: 1
id: bugfix
name: Bugfix

nodes:
  - id: repro
    type: agent
    harness: claude # keep harness comment
    prompt: Reproduce the failure.

  - id: fix
    prompt: |
      Adjust the implementation.
      Keep the existing interface.
      Verify targeted behavior.
    type: agent # preserve type comment
    harness: claude # preserve harness inline comment

# keep me
  - id: check
    type: check
    command: pnpm test

  - id: land
    type: land
    after: [check]
`

function documentFrom(text = FIXTURE): PipelineDocument {
  const result = parsePipelineText(text)
  if (result.document === null) {
    throw new Error('Writer fixture must parse')
  }
  return result.document
}

function checkNode(
  document: PipelineDocument,
  id: string
): Extract<PipelineNode, { type: 'check' }> {
  const node = document.nodes.find(
    (candidate): candidate is Extract<PipelineNode, { type: 'check' }> =>
      candidate.id === id && candidate.type === 'check'
  )
  if (node === undefined) {
    throw new Error(`Expected check node ${id}`)
  }
  return node
}

function agentNode(
  document: PipelineDocument,
  id: string
): Extract<PipelineNode, { type: 'agent' }> {
  const node = document.nodes.find(
    (candidate): candidate is Extract<PipelineNode, { type: 'agent' }> =>
      candidate.id === id && candidate.type === 'agent'
  )
  if (node === undefined) {
    throw new Error(`Expected agent node ${id}`)
  }
  return node
}

function landNode(document: PipelineDocument, id: string): Extract<PipelineNode, { type: 'land' }> {
  const node = document.nodes.find(
    (candidate): candidate is Extract<PipelineNode, { type: 'land' }> =>
      candidate.id === id && candidate.type === 'land'
  )
  if (node === undefined) {
    throw new Error(`Expected land node ${id}`)
  }
  return node
}

function nodeRange(text: string, id: string) {
  const range = parsePipelineText(text).sourceMap.get(id)
  if (range === undefined) {
    throw new Error(`Missing node range for ${id}`)
  }
  return range
}

function withNode(document: PipelineDocument, node: PipelineNode): PipelineDocument {
  return PipelineDocumentSchema.parse({
    ...document,
    nodes: document.nodes.map((candidate) => (candidate.id === node.id ? node : candidate))
  })
}

function commentCount(text: string): number {
  return text.split(/\r?\n/u).filter((line) => line.includes('#')).length
}

function expectIntended(text: string, intended: PipelineDocument): void {
  expect(parsePipelineText(text).document).toEqual(intended)
}

describe('pipeline YAML writer', () => {
  it('splices a plain scalar while preserving all bytes and comments outside the node', () => {
    const originalRange = nodeRange(FIXTURE, 'check')
    const document = documentFrom()
    const check = checkNode(document, 'check')
    const intended = withNode(document, { ...check, command: 'pnpm test:unit' })

    const result = applyPipelineEdits(FIXTURE, [
      { kind: 'set-node', node: { ...check, command: 'pnpm test:unit' } }
    ])
    const resultRange = nodeRange(result.text, 'check')

    expect(result.text.slice(0, resultRange.start)).toBe(FIXTURE.slice(0, originalRange.start))
    expect(result.text.slice(resultRange.end)).toBe(FIXTURE.slice(originalRange.end))
    expect(commentCount(result.text)).toBe(commentCount(FIXTURE))
    expectIntended(result.text, intended)
  })

  it('re-renders only the changed node for structural edits and keeps surrounding comments', () => {
    const originalRange = nodeRange(FIXTURE, 'land')
    const document = documentFrom()
    const land = landNode(document, 'land')
    const updated = { ...land, draft: true }
    const intended = withNode(document, updated)

    const result = applyPipelineEdits(FIXTURE, [{ kind: 'set-node', node: updated }])
    const resultRange = nodeRange(result.text, 'land')

    expect(result.text.slice(0, resultRange.start)).toBe(FIXTURE.slice(0, originalRange.start))
    expect(result.text.slice(resultRange.end)).toBe(FIXTURE.slice(originalRange.end))
    expect(result.text.match(/# keep me/gu)).toHaveLength(1)
    expect(commentCount(result.text)).toBe(commentCount(FIXTURE))
    expectIntended(result.text, intended)
  })

  it('updates a block scalar with CST formatting and leaves the rest of its node untouched', () => {
    const originalRange = nodeRange(FIXTURE, 'fix')
    const document = documentFrom()
    const fix = agentNode(document, 'fix')
    const updated = {
      ...fix,
      prompt: 'First revised line.\nSecond revised line.\nFinal revised line.'
    }
    const intended = withNode(document, updated)

    const result = applyPipelineEdits(FIXTURE, [{ kind: 'set-node', node: updated }])
    const resultRange = nodeRange(result.text, 'fix')
    const oldPromptStart = FIXTURE.indexOf('    prompt: ', originalRange.start)
    const newPromptStart = result.text.indexOf('    prompt: ', resultRange.start)
    const promptKeyLength = '    prompt: '.length
    const oldNextField = FIXTURE.indexOf('    type: agent', oldPromptStart + promptKeyLength)
    const newNextField = result.text.indexOf('    type: agent', newPromptStart + promptKeyLength)
    expect(FIXTURE.slice(originalRange.start, oldPromptStart + promptKeyLength)).toBe(
      result.text.slice(resultRange.start, newPromptStart + promptKeyLength)
    )
    expect(FIXTURE.slice(oldNextField, originalRange.end)).toBe(
      result.text.slice(newNextField, resultRange.end)
    )
    expect(commentCount(result.text)).toBe(commentCount(FIXTURE))

    expect(result.text.slice(0, resultRange.start)).toBe(FIXTURE.slice(0, originalRange.start))
    expect(result.text.slice(resultRange.end)).toBe(FIXTURE.slice(originalRange.end))
    expectIntended(result.text, intended)
  })

  it('deletes a middle node and exactly one adjacent blank line when both sides are separated', () => {
    const document = documentFrom()
    const intended = PipelineDocumentSchema.parse({
      ...document,
      nodes: document.nodes.filter((node) => node.id !== 'check')
    })
    const result = applyPipelineEdits(FIXTURE, [{ kind: 'delete-node', nodeId: 'check' }])

    expect(result.text).toContain('# keep me\n\n  - id: land')
    expect(commentCount(result.text)).toBe(commentCount(FIXTURE))
    expect(result.text.match(/# keep me/gu)).toHaveLength(1)
    expectIntended(result.text, intended)
  })

  it('deletes first and last nodes without changing remaining node bytes', () => {
    const first = applyPipelineEdits(FIXTURE, [{ kind: 'delete-node', nodeId: 'repro' }])
    const firstDocument = documentFrom(first.text)
    expect(firstDocument.nodes.map((node) => node.id)).toEqual(['fix', 'check', 'land'])
    for (const id of ['fix', 'check', 'land']) {
      const oldRange = nodeRange(FIXTURE, id)
      const newRange = nodeRange(first.text, id)
      expect(first.text.slice(newRange.start, newRange.end)).toBe(
        FIXTURE.slice(oldRange.start, oldRange.end)
      )
    }

    const withoutFinalNewline = FIXTURE.slice(0, -1)
    const last = applyPipelineEdits(withoutFinalNewline, [{ kind: 'delete-node', nodeId: 'land' }])
    const lastDocument = documentFrom(last.text)
    expect(lastDocument.nodes.map((node) => node.id)).toEqual(['repro', 'fix', 'check'])
    const oldCheckRange = nodeRange(withoutFinalNewline, 'check')
    const newCheckRange = nodeRange(last.text, 'check')
    const lastNodeStart =
      withoutFinalNewline.lastIndexOf('\n', withoutFinalNewline.indexOf('  - id: land')) + 1
    expect(last.text.slice(newCheckRange.end)).toBe(
      withoutFinalNewline.slice(oldCheckRange.end, lastNodeStart)
    )
    for (const id of ['repro', 'fix', 'check']) {
      const oldRange = nodeRange(withoutFinalNewline, id)
      const newRange = nodeRange(last.text, id)
      expect(last.text.slice(newRange.start, newRange.end)).toBe(
        withoutFinalNewline.slice(oldRange.start, oldRange.end)
      )
    }
  })

  it('appends with one blank line only when the existing node list uses blank-line separators', () => {
    const document = documentFrom()
    const check = checkNode(document, 'check')
    const appended = { ...check, id: 'extra', command: 'pnpm lint' }
    const result = applyPipelineEdits(FIXTURE, [{ kind: 'append-node', node: appended }])
    const intended = PipelineDocumentSchema.parse({
      ...document,
      nodes: [...document.nodes, appended]
    })
    expect(commentCount(result.text)).toBe(commentCount(FIXTURE))
    expect(result.text).toContain('after: [check]\n\n  - id: extra')
    expectIntended(result.text, intended)

    const compact = FIXTURE.replace(/\n[ \t]*\n/gu, '\n')
    const compactDocument = documentFrom(compact)
    const compactCheck = checkNode(compactDocument, 'check')
    const compactAppend = { ...compactCheck, id: 'extra', command: 'pnpm lint' }
    const compactResult = applyPipelineEdits(compact, [
      { kind: 'append-node', node: compactAppend }
    ])
    expect(compactResult.text).toContain('after: [check]\n  - id: extra')
    expectIntended(
      compactResult.text,
      PipelineDocumentSchema.parse({
        ...compactDocument,
        nodes: [...compactDocument.nodes, compactAppend]
      })
    )
  })

  it('preserves CRLF and the source final-newline choice', () => {
    const crlf = FIXTURE.replace(/\n/gu, '\r\n')
    const document = documentFrom(crlf)
    const check = checkNode(document, 'check')
    const crlfResult = applyPipelineEdits(crlf, [
      { kind: 'set-node', node: { ...check, command: 'pnpm test:unit' } }
    ])
    expect(crlfResult.text).toContain('\r\n')
    expect(crlfResult.text.replace(/\r\n/gu, '')).not.toContain('\n')
    expect(crlfResult.text.endsWith('\r\n')).toBe(true)

    const noFinalNewline = FIXTURE.slice(0, -1)
    const noFinalDocument = documentFrom(noFinalNewline)
    const result = applyPipelineEdits(noFinalNewline, [
      { kind: 'set-top', key: 'id', value: 'bugfix-copy' }
    ])
    expect(result.text.endsWith('\n')).toBe(false)
    expectIntended(
      result.text,
      PipelineDocumentSchema.parse({ ...noFinalDocument, id: 'bugfix-copy' })
    )
  })

  it('changes only the requested top-level name and id scalar lines', () => {
    const name = applyPipelineEdits(FIXTURE, [
      { kind: 'set-top', key: 'name', value: 'Bugfix (fast)' }
    ])
    expect(name.text.replace('name: Bugfix (fast)', 'name: Bugfix')).toBe(FIXTURE)

    const id = applyPipelineEdits(FIXTURE, [{ kind: 'set-top', key: 'id', value: 'bugfix-copy' }])
    expect(id.text.replace('id: bugfix-copy', 'id: bugfix')).toBe(FIXTURE)
  })

  it('splices a structural top-level input value without changing surrounding file bytes', () => {
    const source = FIXTURE.replace(
      'name: Bugfix\n\nnodes:',
      'name: Bugfix\ninputs:\n  task:\n    type: text\n    required: true\n\nnodes:'
    )
    const document = documentFrom(source)
    const inputs = {
      task: { type: 'text' as const, label: 'Task details', required: true },
      mode: { type: 'text' as const, required: false }
    }
    const intended = PipelineDocumentSchema.parse({ ...document, inputs })
    const result = applyPipelineEdits(source, [{ kind: 'set-top', key: 'inputs', value: inputs }])
    const prefix = source.slice(0, source.indexOf('inputs:'))
    const suffixStart = source.indexOf('\n\nnodes:')

    expect(result.text.slice(0, result.text.indexOf('inputs:'))).toBe(prefix)
    expect(result.text.slice(result.text.indexOf('\n\nnodes:'))).toBe(source.slice(suffixStart))
    expect(commentCount(result.text)).toBe(commentCount(source))
    expectIntended(result.text, intended)
  })

  it('inserts an explicit input map before nodes while preserving later source bytes', () => {
    const document = documentFrom()
    const inputs = {
      task: { type: 'text' as const, label: 'Task details', required: true },
      mode: { type: 'text' as const, required: false }
    }
    const intended = PipelineDocumentSchema.parse({ ...document, inputs })
    const result = applyPipelineEdits(FIXTURE, [{ kind: 'set-top', key: 'inputs', value: inputs }])

    expect(result.text.indexOf('inputs:')).toBeLessThan(result.text.indexOf('nodes:'))
    expect(result.text).toContain('name: Bugfix\ninputs:')
    expect(commentCount(result.text)).toBe(commentCount(FIXTURE))
    expectIntended(result.text, intended)
  })

  it('rejects unknown node targets and requires an intended document before malformed-source rerender', () => {
    const document = documentFrom()
    const check = checkNode(document, 'check')
    const ghost = { ...check, id: 'ghost' }
    expect(() => applyPipelineEdits(FIXTURE, [{ kind: 'set-node', node: ghost }])).toThrow(
      PipelineEditTargetError
    )
    expect(() => applyPipelineEdits(FIXTURE, [{ kind: 'delete-node', nodeId: 'ghost' }])).toThrow(
      PipelineEditTargetError
    )
    expect(() => applyPipelineEdits(FIXTURE, [{ kind: 'append-node', node: check }])).toThrow(
      PipelineEditTargetError
    )

    const malformed = FIXTURE.replace('nodes:', 'nodes: [')
    expect(() => applyPipelineEdits(malformed, [])).toThrow(PipelineSourceUnparseableError)
    expect(() => applyPipelineEdits(malformed, [], { allowFileRerender: true })).toThrow(
      PipelineSourceUnparseableError
    )

    const rerendered = applyPipelineEdits(malformed, [], {
      allowFileRerender: true,
      intendedDocument: document
    })
    expect(rerendered.text).toBe(renderNewPipeline(document))
    expectIntended(rerendered.text, document)
    expect(commentCount(rerendered.text)).toBe(0)
    const incomplete = { ...document, nodes: [] }
    const incompleteRerender = applyPipelineEdits(malformed, [], {
      allowFileRerender: true,
      intendedDocument: incomplete
    })
    expect(incompleteRerender.text).toBe(renderNewPipeline(incomplete))
    expect(incompleteRerender.text).toContain('nodes: []')

    const missingNodes = 'version: 1\nid: bugfix\nname: Broken\n'
    expect(() => applyPipelineEdits(missingNodes, [])).toThrow(PipelineSourceUnparseableError)
    const missingResult = applyPipelineEdits(missingNodes, [], {
      allowFileRerender: true,
      intendedDocument: document
    })
    expect(missingResult.text).toBe(renderNewPipeline(document))
  })

  it('serializes and reopens schema-invalid drafts without placeholders or comment loss', () => {
    const document = documentFrom()
    const emptyDraft = { ...document, nodes: [] }
    const renderedEmptyDraft = renderNewPipeline(emptyDraft)
    expect(renderedEmptyDraft).toContain('nodes: []')
    expect(parsePipelineText(renderedEmptyDraft).document).toBeNull()

    const minimalEmptyDraft = renderNewPipeline({
      version: 1,
      id: 'unfinished',
      name: 'Unfinished',
      nodes: []
    })
    expect(minimalEmptyDraft).toContain('nodes: []')

    const minimalInvalidCheck = renderNewPipeline({
      version: 1,
      id: 'unfinished',
      name: 'Unfinished',
      nodes: [{ id: 'check', type: 'check', command: '' }]
    })
    expect(minimalInvalidCheck).toContain('command:')
    expect(parsePipelineText(minimalInvalidCheck).document).toBeNull()

    const check = checkNode(document, 'check')

    const emptySourceDocument: PipelineDocument = {
      version: 1,
      id: 'unfinished',
      name: 'Unfinished',
      inputs: document.inputs,
      nodes: []
    }
    const emptySource = `# keep empty draft comment
version: 1
id: unfinished
name: Unfinished
nodes: []
`
    const firstNode = { ...check, id: 'first' }
    const firstNodeIntent = PipelineDocumentSchema.parse({
      ...emptySourceDocument,
      nodes: [firstNode]
    })
    const startedGraph = applyPipelineEdits(
      emptySource,
      [{ kind: 'append-node', node: firstNode }],
      { sourceDocument: emptySourceDocument }
    )
    expect(startedGraph.text).toContain('# keep empty draft comment')
    expectIntended(startedGraph.text, firstNodeIntent)
    expect(commentCount(startedGraph.text)).toBe(commentCount(emptySource))

    const invalidCheck = { ...check, command: '' }
    const invalidScript: PipelineNode = {
      id: 'script',
      type: 'script',
      command: '',
      capability: 'script'
    }
    const invalidDraft: PipelineDocument = {
      ...document,
      nodes: document.nodes
        .map((node) => (node.id === 'check' ? invalidCheck : node))
        .concat(invalidScript)
    }
    const invalidEdit = applyPipelineEdits(FIXTURE, [
      { kind: 'set-node', node: invalidCheck },
      { kind: 'append-node', node: invalidScript }
    ])
    const invalidParse = parsePipelineText(invalidEdit.text)
    const commandErrors = invalidParse.errors.filter(
      (error) => error.code === 'schema' && error.path?.at(-1) === 'command'
    )
    expect(commentCount(invalidEdit.text)).toBe(commentCount(FIXTURE))
    expect(invalidParse.document).toBeNull()
    expect(commandErrors).toHaveLength(2)
    expect(invalidParse.sourceMap.has('check')).toBe(true)
    expect(invalidParse.sourceMap.has('script')).toBe(true)

    const reopened = applyPipelineEdits(
      invalidEdit.text,
      [{ kind: 'set-top', key: 'name', value: 'Still in progress' }],
      { sourceDocument: invalidDraft }
    )
    const reopenedParse = parsePipelineText(reopened.text)
    expect(reopened.text).toContain('name: Still in progress')
    expect(commentCount(reopened.text)).toBe(commentCount(FIXTURE))
    expect(reopenedParse.document).toBeNull()
    expect(reopenedParse.errors.some((error) => error.code === 'schema')).toBe(true)

    const singleNodeSource = `# keep single-node context
version: 1
id: single
name: Single
nodes:
  - id: check
    type: check
    command: pnpm test
`
    const emptyGraph = applyPipelineEdits(singleNodeSource, [
      { kind: 'delete-node', nodeId: 'check' }
    ])
    expect(emptyGraph.text).toContain('nodes:\n  []')
    expect(emptyGraph.text).toContain('# keep single-node context')
    expect(commentCount(emptyGraph.text)).toBe(commentCount(singleNodeSource))
    expect(parsePipelineText(emptyGraph.text).document).toBeNull()
  })

  it('renders all new-file keys in canonical top-level and node order', () => {
    const document = documentFrom()
    const fix = agentNode(document, 'fix')
    const configuredFix = {
      ...fix,
      label: 'Fix',
      after: ['repro'],
      outputs: { summary: { type: 'text' as const } },
      retry: 2,
      timeLimitMinutes: 15
    }
    const configured = PipelineDocumentSchema.parse({
      ...document,
      description: 'Pipeline description',
      capabilities: { agent: 'gated' },
      defaults: { retry: 1 },
      nodes: document.nodes.map((node) => (node.id === 'fix' ? configuredFix : node))
    })
    const rendered = renderNewPipeline(configured)
    const topKeys = rendered
      .split('\n')
      .filter((line) => /^[a-z][a-zA-Z]*:/u.test(line))
      .map((line) => line.slice(0, line.indexOf(':')))
    expect(topKeys).toEqual([
      'version',
      'id',
      'name',
      'description',
      'inputs',
      'capabilities',
      'defaults',
      'nodes'
    ])

    const fixStart = rendered.indexOf('  - id: fix')
    const nextNodeStart = rendered.indexOf('  - id: check', fixStart)
    const fixBlock = rendered.slice(fixStart, nextNodeStart)
    const orderedFields = [
      '  - id: fix',
      '    type: agent',
      '    label: Fix',
      '    after:',
      '    harness: claude',
      '    prompt:',
      '    outputs:',
      '    retry: 2',
      '    timeLimitMinutes: 15'
    ]
    const positions = orderedFields.map((field) => fixBlock.indexOf(field))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(parsePipelineText(rendered).document).toEqual(configured)
  })

  it('writes layout keys in node order and drops stale ids', () => {
    const result = renderPipelineLayout(
      {
        version: 1,
        nodes: {
          land: { x: 3, y: 4 },
          repro: { x: 1, y: 2 },
          gone: { x: 0, y: 0 }
        }
      },
      ['repro', 'land']
    )
    expect(result).toBe(
      '{\n  "version": 1,\n  "nodes": {\n    "repro": {\n      "x": 1,\n      "y": 2\n    },\n    "land": {\n      "x": 3,\n      "y": 4\n    }\n  }\n}\n'
    )
  })
})
