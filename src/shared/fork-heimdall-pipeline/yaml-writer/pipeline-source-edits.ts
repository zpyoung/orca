import { PipelineDocumentSchema, type PipelineDocument } from '../document-schema'
import type { PipelineAuthoringDocument } from './pipeline-authoring-document'
import { parsePipelineText, type PipelineParseResult } from '../pipeline-parse'
import { renderNewPipeline } from './pipeline-renderer'
import { arePipelineEditValuesEqual, cleanPipelineYamlValue } from './pipeline-edit-values'
import { applyPipelineSourceSplices, createPipelineSourceSplices } from './pipeline-source-splices'
import {
  lineEndingOf,
  parsePipelineSourceNodes,
  type PipelineSourceNodes
} from './pipeline-yaml-cst'
import type {
  ApplyPipelineEditsOptions,
  PipelineEdit,
  PipelineEditResult,
  SetTopEdit
} from './pipeline-edit-types'

export type {
  ApplyPipelineEditsOptions,
  PipelineEdit,
  PipelineEditMode,
  PipelineEditResult
} from './pipeline-edit-types'

export class PipelineSourceUnparseableError extends Error {
  readonly errors: PipelineParseResult['errors']

  constructor(
    errors: PipelineParseResult['errors'],
    message = 'Pipeline source cannot be edited safely'
  ) {
    super(message)
    this.name = 'PipelineSourceUnparseableError'
    this.errors = errors
  }
}

export class PipelineEditTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PipelineEditTargetError'
  }
}

function applyTopEdit(
  document: PipelineAuthoringDocument,
  edit: SetTopEdit
): PipelineAuthoringDocument {
  const next = { ...document }
  switch (edit.key) {
    case 'id':
      next.id = edit.value
      break
    case 'name':
      next.name = edit.value
      break
    case 'description':
      if (edit.value === undefined) {
        delete next.description
      } else {
        next.description = edit.value
      }
      break
    case 'inputs':
      if (edit.value === undefined) {
        delete next.inputs
      } else {
        next.inputs = edit.value
      }
      break
    case 'capabilities':
      if (edit.value === undefined) {
        delete next.capabilities
      } else {
        next.capabilities = edit.value
      }
      break
    case 'defaults':
      if (edit.value === undefined) {
        delete next.defaults
      } else {
        next.defaults = edit.value
      }
      break
  }
  return next
}

type PipelineEditIntent = {
  document: PipelineAuthoringDocument
  schemaValid: boolean
  validatedDocument: PipelineDocument | null
}

function pipelineEditIntent(document: PipelineAuthoringDocument): PipelineEditIntent {
  const validated = PipelineDocumentSchema.safeParse(document)
  return validated.success
    ? { document, schemaValid: true, validatedDocument: validated.data }
    : { document, schemaValid: false, validatedDocument: null }
}

function intendedAfterEdits(
  document: PipelineAuthoringDocument,
  edits: readonly PipelineEdit[]
): PipelineEditIntent {
  let intended = document
  for (const edit of edits) {
    switch (edit.kind) {
      case 'set-node':
        intended = {
          ...intended,
          nodes: intended.nodes.map((node) => (node.id === edit.node.id ? edit.node : node))
        }
        break
      case 'delete-node':
        intended = {
          ...intended,
          nodes: intended.nodes.filter((node) => node.id !== edit.nodeId)
        }
        break
      case 'append-node':
        intended = { ...intended, nodes: [...intended.nodes, edit.node] }
        break
      case 'set-top':
        intended = applyTopEdit(intended, edit)
        break
    }
  }
  return pipelineEditIntent(intended)
}

function validateTargets(
  document: PipelineAuthoringDocument,
  edits: readonly PipelineEdit[]
): void {
  const appendIds = new Set<string>()
  for (const edit of edits) {
    if (edit.kind === 'set-node' || edit.kind === 'delete-node') {
      const nodeId = edit.kind === 'set-node' ? edit.node.id : edit.nodeId
      const matches = document.nodes.filter((node) => node.id === nodeId).length
      if (matches === 0) {
        throw new PipelineEditTargetError(`Pipeline node "${nodeId}" does not exist`)
      }
      if (matches > 1) {
        throw new PipelineEditTargetError(`Pipeline node "${nodeId}" is ambiguous`)
      }
    } else if (edit.kind === 'append-node') {
      const nodeId = edit.node.id
      if (document.nodes.some((node) => node.id === nodeId) || appendIds.has(nodeId)) {
        throw new PipelineEditTargetError(`Pipeline node "${nodeId}" already exists`)
      }
      appendIds.add(nodeId)
    }
  }
}

function rerenderSourceAsWholeFile(
  document: PipelineAuthoringDocument,
  sourceText: string
): string {
  const rendered = renderNewPipeline(document).replaceAll('\n', lineEndingOf(sourceText))
  const sourceHasFinalNewline = sourceText.endsWith('\n') || sourceText.endsWith('\r')
  return sourceHasFinalNewline ? rendered : rendered.replace(/(?:\r\n|\n|\r)$/u, '')
}
function matchesEditedPipeline(
  text: string,
  intent: PipelineEditIntent,
  expectedRawDocument: unknown
): boolean {
  const parsed = parsePipelineText(text)
  const source = parsePipelineSourceNodes(text, parsed)
  if (source === null || !arePipelineEditValuesEqual(source.rawDocument, expectedRawDocument)) {
    return false
  }
  if (intent.schemaValid) {
    return (
      parsed.document !== null &&
      intent.validatedDocument !== null &&
      arePipelineEditValuesEqual(parsed.document, intent.validatedDocument)
    )
  }
  return parsed.document === null
}
function sourceDocumentMatchesYaml(
  source: PipelineSourceNodes,
  document: PipelineAuthoringDocument
): boolean {
  if (
    (typeof source.rawDocument.version === 'number' &&
      source.rawDocument.version !== document.version) ||
    (typeof source.rawDocument.id === 'string' && source.rawDocument.id !== document.id) ||
    (typeof source.rawDocument.name === 'string' && source.rawDocument.name !== document.name) ||
    source.rawNodes.length !== document.nodes.length
  ) {
    return false
  }
  for (let index = 0; index < document.nodes.length; index += 1) {
    if (source.rawNodes[index]?.id !== document.nodes[index]?.id) {
      return false
    }
  }
  return true
}

function applySourceEditSplices(
  sourceText: string,
  source: PipelineSourceNodes,
  original: PipelineAuthoringDocument,
  intent: PipelineEditIntent,
  edits: readonly PipelineEdit[]
): PipelineEditResult | null {
  const initial = createPipelineSourceSplices(
    sourceText,
    source,
    original,
    intent.document,
    edits,
    false
  )
  if (initial === null) {
    return null
  }
  const initialText = applyPipelineSourceSplices(sourceText, initial.splices)
  if (matchesEditedPipeline(initialText, intent, initial.rawDocument)) {
    return { text: initialText, mode: initial.mode }
  }

  const rerenderedNodes = createPipelineSourceSplices(
    sourceText,
    source,
    original,
    intent.document,
    edits,
    true
  )
  if (rerenderedNodes !== null) {
    const rerenderedText = applyPipelineSourceSplices(sourceText, rerenderedNodes.splices)
    if (
      rerenderedNodes.mode === 'node-rerender' &&
      matchesEditedPipeline(rerenderedText, intent, rerenderedNodes.rawDocument)
    ) {
      return { text: rerenderedText, mode: 'node-rerender' }
    }
  }
  return wholeFileRerenderResult(intent, sourceText)
}

function wholeFileRerenderResult(
  intent: PipelineEditIntent,
  sourceText: string
): PipelineEditResult {
  const text = rerenderSourceAsWholeFile(intent.document, sourceText)
  if (!matchesEditedPipeline(text, intent, cleanPipelineYamlValue(intent.document))) {
    throw new Error('Pipeline writer could not reproduce the intended raw document')
  }
  return { text, mode: 'file-rerender' }
}
/** Apply pipeline edits while retaining source formatting outside the edited YAML nodes. */
export function applyPipelineEdits(
  sourceText: string,
  edits: PipelineEdit[],
  options: ApplyPipelineEditsOptions = {}
): PipelineEditResult {
  const parsed = parsePipelineText(sourceText)
  const source = parsePipelineSourceNodes(sourceText, parsed)

  if (parsed.document === null) {
    const sourceDocument = options.sourceDocument
    if (
      source !== null &&
      sourceDocument !== undefined &&
      sourceDocumentMatchesYaml(source, sourceDocument)
    ) {
      validateTargets(sourceDocument, edits)
      const intent = intendedAfterEdits(sourceDocument, edits)
      return (
        applySourceEditSplices(sourceText, source, sourceDocument, intent, edits) ??
        wholeFileRerenderResult(intent, sourceText)
      )
    }
    if (options.allowFileRerender !== true) {
      throw new PipelineSourceUnparseableError(parsed.errors)
    }
    if (options.intendedDocument === undefined) {
      throw new PipelineSourceUnparseableError(
        parsed.errors,
        'Replacing an unparseable pipeline requires the intended canvas document'
      )
    }
    const intent = pipelineEditIntent(options.intendedDocument)
    const text = renderNewPipeline(intent.document)
    if (!matchesEditedPipeline(text, intent, cleanPipelineYamlValue(intent.document))) {
      throw new PipelineSourceUnparseableError(
        parsed.errors,
        'The intended canvas document cannot be rendered as pipeline YAML'
      )
    }
    return { text, mode: 'file-rerender' }
  }

  const original = parsed.document
  validateTargets(original, edits)
  const intent = intendedAfterEdits(original, edits)
  if (source === null) {
    if (options.allowFileRerender !== true) {
      throw new PipelineSourceUnparseableError(
        parsed.errors,
        'Pipeline nodes are not available as a YAML sequence'
      )
    }
    const fallbackIntent =
      options.intendedDocument === undefined ? intent : pipelineEditIntent(options.intendedDocument)
    return wholeFileRerenderResult(fallbackIntent, sourceText)
  }

  const result = applySourceEditSplices(sourceText, source, original, intent, edits)
  if (result !== null) {
    return result
  }
  if (!intent.schemaValid) {
    return wholeFileRerenderResult(intent, sourceText)
  }
  if (options.allowFileRerender !== true) {
    throw new PipelineSourceUnparseableError(
      parsed.errors,
      'Pipeline source cannot be edited without replacing the file'
    )
  }
  const fallbackIntent =
    options.intendedDocument === undefined ? intent : pipelineEditIntent(options.intendedDocument)
  return wholeFileRerenderResult(fallbackIntent, sourceText)
}
