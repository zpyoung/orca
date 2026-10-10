import type {
  PipelineAuthoringDocument,
  PipelineAuthoringNode
} from './pipeline-authoring-document'
import {
  arePipelineEditValuesEqual,
  cleanPipelineYamlValue,
  pipelineObjectProperty
} from './pipeline-edit-values'
import type { PipelineEdit, PipelineTopKey } from './pipeline-edit-types'
import type { PipelineRawDocument, PipelineRawNode, PipelineSourceNodes } from './pipeline-yaml-cst'

export function updateRawPipelineNode(
  rawNode: PipelineRawNode,
  before: PipelineAuthoringNode,
  after: PipelineAuthoringNode
): PipelineRawNode {
  const result = { ...rawNode }
  const fields = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const field of fields) {
    const wasPresent = Object.hasOwn(before, field)
    const remainsPresent = Object.hasOwn(after, field)
    const previous = pipelineObjectProperty(before, field)
    const next = pipelineObjectProperty(after, field)
    if (wasPresent === remainsPresent && arePipelineEditValuesEqual(previous, next)) {
      continue
    }
    if (remainsPresent && next !== undefined) {
      result[field] = cleanPipelineYamlValue(next)
    } else {
      delete result[field]
    }
  }
  return result
}

export function rawPipelineNodeFromAuthoringNode(node: PipelineAuthoringNode): PipelineRawNode {
  const result: PipelineRawNode = {}
  for (const [key, value] of Object.entries(node)) {
    if (value !== undefined) {
      result[key] = cleanPipelineYamlValue(value)
    }
  }
  return result
}

function pipelineTopValue(document: PipelineAuthoringDocument, key: PipelineTopKey): unknown {
  switch (key) {
    case 'id':
      return document.id
    case 'name':
      return document.name
    case 'description':
      return document.description
    case 'inputs':
      return document.inputs
    case 'capabilities':
      return document.capabilities
    case 'defaults':
      return document.defaults
  }
}

export function createRawPipelineDocumentAfterEdits(
  source: PipelineSourceNodes,
  original: PipelineAuthoringDocument,
  intended: PipelineAuthoringDocument,
  edits: readonly PipelineEdit[]
): PipelineRawDocument | null {
  const rawDocument = { ...source.rawDocument }
  const rawNodes: PipelineRawNode[] = []
  let originalIndex = 0
  for (const node of intended.nodes) {
    let matchingIndex: number | null = null
    for (let index = originalIndex; index < original.nodes.length; index += 1) {
      if (original.nodes[index]?.id === node.id) {
        matchingIndex = index
        break
      }
    }
    if (matchingIndex === null) {
      rawNodes.push(rawPipelineNodeFromAuthoringNode(node))
      continue
    }
    const originalNode = original.nodes[matchingIndex]
    const sourceNode = source.rawNodes[matchingIndex]
    if (originalNode === undefined || sourceNode === undefined) {
      return null
    }
    rawNodes.push(updateRawPipelineNode(sourceNode, originalNode, node))
    originalIndex = matchingIndex + 1
  }
  rawDocument.nodes = rawNodes

  const changedTopKeys = new Set<PipelineTopKey>()
  for (const edit of edits) {
    if (edit.kind === 'set-top') {
      changedTopKeys.add(edit.key)
    }
  }
  for (const key of changedTopKeys) {
    const previous = pipelineTopValue(original, key)
    const next = pipelineTopValue(intended, key)
    if (arePipelineEditValuesEqual(previous, next)) {
      continue
    }
    if (next === undefined) {
      delete rawDocument[key]
    } else {
      rawDocument[key] = cleanPipelineYamlValue(next)
    }
  }
  return rawDocument
}
