import { isMap, isNode, type YAMLMap } from 'yaml'
import type {
  PipelineAuthoringDocument,
  PipelineAuthoringNode
} from './pipeline-authoring-document'
import { renderPipelineNodeRecordSequenceEntry } from './pipeline-renderer'
import {
  arePipelineEditValuesEqual,
  isPipelineScalarValue,
  pipelineObjectProperty
} from './pipeline-edit-values'
import type { PipelineEdit, PipelineEditMode } from './pipeline-edit-types'
import {
  blankLineSpliceInRange,
  hasBlankLine,
  lineEndingOf,
  lineStartAt,
  scalarText,
  type PipelineRawDocument,
  type PipelineSourceNodes,
  type PipelineSourceSplice
} from './pipeline-yaml-cst'
import { createTopLevelSplices } from './pipeline-top-level-splices'
import {
  createRawPipelineDocumentAfterEdits,
  rawPipelineNodeFromAuthoringNode,
  updateRawPipelineNode
} from './pipeline-source-raw-document'

export type PipelineSourceSplices = {
  splices: PipelineSourceSplice[]
  mode: PipelineEditMode
  rawDocument: PipelineRawDocument
}

type SequenceItem = {
  index: number
  markerOffset: number
  lineStart: number
  rangeValueEnd: number
  rangeEnd: number
  sequenceIndent: number
}

function sequenceItemInfo(
  sourceText: string,
  source: PipelineSourceNodes,
  nodeId: string
): SequenceItem | null {
  const sequenceToken = source.nodes.srcToken
  if (sequenceToken === undefined || sequenceToken.type !== 'block-seq') {
    return null
  }
  const matchingIndexes: number[] = []
  for (let index = 0; index < source.nodes.items.length; index += 1) {
    const item = source.nodes.items[index]
    if (isMap(item) && item.get('id') === nodeId) {
      matchingIndexes.push(index)
    }
  }
  if (matchingIndexes.length !== 1) {
    return null
  }
  const index = matchingIndexes[0]
  if (index === undefined) {
    return null
  }
  const itemNode = source.nodes.items[index]
  const itemToken = sequenceToken.items[index]
  const marker = itemToken?.start.find((token) => token.type === 'seq-item-ind')
  if (
    marker === undefined ||
    !isNode(itemNode) ||
    itemNode.range === undefined ||
    itemNode.range === null
  ) {
    return null
  }
  const range = itemNode.range
  const markerOffset = marker.offset
  return {
    index,
    markerOffset,
    lineStart: lineStartAt(sourceText, markerOffset),
    rangeValueEnd: range[1],
    rangeEnd: range[2],
    sequenceIndent: sequenceToken.indent
  }
}

function changedScalarFields(
  before: PipelineAuthoringNode,
  after: PipelineAuthoringNode
): string[] | null {
  const beforeEntries = Object.entries(before)
  const afterEntries = Object.entries(after)
  if (
    beforeEntries.length !== afterEntries.length ||
    beforeEntries.some(([key]) => !Object.hasOwn(after, key))
  ) {
    return null
  }
  const changed: string[] = []
  for (const [key, oldValue] of beforeEntries) {
    const newValue = pipelineObjectProperty(after, key)
    if (arePipelineEditValuesEqual(oldValue, newValue)) {
      continue
    }
    if (!isPipelineScalarValue(oldValue) || !isPipelineScalarValue(newValue)) {
      return null
    }
    changed.push(key)
  }
  return changed
}

function nodeScalarSplices(
  source: PipelineSourceNodes,
  before: PipelineAuthoringNode,
  after: PipelineAuthoringNode
): PipelineSourceSplice[] | null {
  const fields = changedScalarFields(before, after)
  if (fields === null) {
    return null
  }
  let nodeMap: YAMLMap | undefined
  for (const item of source.nodes.items) {
    if (isMap(item) && item.get('id') === before.id) {
      if (nodeMap !== undefined) {
        return null
      }
      nodeMap = item
    }
  }
  if (nodeMap === undefined) {
    return null
  }
  const splices: PipelineSourceSplice[] = []
  for (const field of fields) {
    const newValue = pipelineObjectProperty(after, field)
    if (!isPipelineScalarValue(newValue)) {
      return null
    }
    const replacement = scalarText(nodeMap.get(field, true), newValue)
    if (replacement === null) {
      return null
    }
    splices.push(replacement)
  }
  return splices
}

function nodeRerenderSplice(
  sourceText: string,
  source: PipelineSourceNodes,
  before: PipelineAuthoringNode,
  after: PipelineAuthoringNode
): PipelineSourceSplice | null {
  const item = sequenceItemInfo(sourceText, source, before.id)
  if (item === null) {
    return null
  }
  const originalRawNode = source.rawNodes[item.index]
  if (originalRawNode === undefined) {
    return null
  }
  const updatedRawNode = updateRawPipelineNode(originalRawNode, before, after)
  const leading = sourceText.slice(item.lineStart, item.markerOffset)
  const replaceFromLineStart = leading.trim() === ''
  const start = replaceFromLineStart ? item.lineStart : item.markerOffset
  const indent = replaceFromLineStart ? item.sequenceIndent : 0
  const renderedNode = renderPipelineNodeRecordSequenceEntry(
    updatedRawNode,
    after.type,
    indent,
    lineEndingOf(sourceText)
  )
  const replacedSource = sourceText.slice(start, item.rangeValueEnd)
  const ending = replacedSource.endsWith('\r\n')
    ? '\r\n'
    : replacedSource.endsWith('\n')
      ? '\n'
      : replacedSource.endsWith('\r')
        ? '\r'
        : ''
  return {
    start,
    end: item.rangeValueEnd,
    replacement: `${renderedNode}${ending}`
  }
}

function deleteNodeSplices(
  sourceText: string,
  source: PipelineSourceNodes,
  before: PipelineAuthoringDocument,
  nodeId: string
): PipelineSourceSplice[] | null {
  const item = sequenceItemInfo(sourceText, source, nodeId)
  if (item === null) {
    return null
  }
  const previous = before.nodes[item.index - 1]
  const next = before.nodes[item.index + 1]
  const previousItem =
    previous === undefined ? null : sequenceItemInfo(sourceText, source, previous.id)
  const nextItem = next === undefined ? null : sequenceItemInfo(sourceText, source, next.id)
  const blankBefore =
    previousItem === null
      ? null
      : blankLineSpliceInRange(sourceText, previousItem.rangeEnd, item.markerOffset)
  const blankAfter =
    nextItem === null
      ? null
      : blankLineSpliceInRange(sourceText, item.rangeEnd, nextItem.markerOffset)
  const splices: PipelineSourceSplice[] = [
    { start: item.lineStart, end: item.rangeEnd, replacement: '' }
  ]
  if (blankBefore !== null && blankAfter !== null) {
    splices.push(blankBefore)
  }
  return splices
}

function nodeItemsAreBlankLineSeparated(
  sourceText: string,
  source: PipelineSourceNodes,
  document: PipelineAuthoringDocument
): boolean {
  for (let index = 1; index < document.nodes.length; index += 1) {
    const previous = document.nodes[index - 1]
    const current = document.nodes[index]
    if (previous === undefined || current === undefined) {
      continue
    }
    const previousItem = sequenceItemInfo(sourceText, source, previous.id)
    const currentItem = sequenceItemInfo(sourceText, source, current.id)
    if (
      previousItem !== null &&
      currentItem !== null &&
      hasBlankLine(sourceText, previousItem.rangeEnd, currentItem.markerOffset)
    ) {
      return true
    }
  }
  return false
}

function appendNodesSplice(
  sourceText: string,
  source: PipelineSourceNodes,
  original: PipelineAuthoringDocument,
  appended: readonly PipelineAuthoringNode[]
): PipelineSourceSplice | null {
  const last = original.nodes.at(-1)
  if (last === undefined) {
    const sequenceToken = source.nodes.srcToken
    const range = source.nodes.range
    if (
      source.nodes.items.length !== 0 ||
      sequenceToken?.type !== 'flow-collection' ||
      range === undefined ||
      range === null
    ) {
      return null
    }
    const lineEnding = lineEndingOf(sourceText)
    const renderedItems = appended
      .map((node) =>
        renderPipelineNodeRecordSequenceEntry(
          rawPipelineNodeFromAuthoringNode(node),
          node.type,
          2,
          lineEnding
        )
      )
      .join(lineEnding)
    const suffix = sourceText.slice(range[1])
    const inlineComment = /^[ \t]+#/u.test(suffix)
    return {
      start: range[0],
      end: range[1],
      replacement: `${lineEnding}${renderedItems}${inlineComment ? lineEnding : ''}`
    }
  }
  const item = sequenceItemInfo(sourceText, source, last.id)
  if (item === null) {
    return null
  }
  const lineEnding = lineEndingOf(sourceText)
  const separated = nodeItemsAreBlankLineSeparated(sourceText, source, original)
  const end = item.rangeEnd
  const prefixAlreadyEndsWithLineEnding =
    end >= lineEnding.length && sourceText.slice(end - lineEnding.length, end) === lineEnding
  const beforeNewItems = separated
    ? prefixAlreadyEndsWithLineEnding
      ? lineEnding
      : `${lineEnding}${lineEnding}`
    : prefixAlreadyEndsWithLineEnding
      ? ''
      : lineEnding
  const renderedItems = appended
    .map((node) =>
      renderPipelineNodeRecordSequenceEntry(
        rawPipelineNodeFromAuthoringNode(node),
        node.type,
        item.sequenceIndent,
        lineEnding
      )
    )
    .join(separated ? `${lineEnding}${lineEnding}` : lineEnding)
  const suffix = sourceText.slice(end)
  const afterNewItems =
    suffix.length > 0
      ? suffix.startsWith('\n') || suffix.startsWith('\r')
        ? ''
        : lineEnding
      : sourceText.endsWith('\n') || sourceText.endsWith('\r')
        ? lineEnding
        : ''
  return {
    start: end,
    end,
    replacement: `${beforeNewItems}${renderedItems}${afterNewItems}`
  }
}

function changedNodes(original: PipelineAuthoringDocument, intended: PipelineAuthoringDocument) {
  const appended = intended.nodes.filter(
    (node) => !original.nodes.some((existing) => existing.id === node.id)
  )
  const deleted = original.nodes.filter(
    (node) => !intended.nodes.some((current) => current.id === node.id)
  )
  const changed = original.nodes.flatMap((node) => {
    const current = intended.nodes.find((candidate) => candidate.id === node.id)
    return current !== undefined && !arePipelineEditValuesEqual(node, current)
      ? [{ before: node, after: current }]
      : []
  })
  return { appended, deleted, changed }
}

/** Build source-local edits for changed nodes, deletions, and appends. */
export function createPipelineSourceSplices(
  sourceText: string,
  source: PipelineSourceNodes,
  original: PipelineAuthoringDocument,
  intended: PipelineAuthoringDocument,
  edits: readonly PipelineEdit[],
  forceNodeRerender: boolean
): PipelineSourceSplices | null {
  const topSplices = createTopLevelSplices(sourceText, source, original, intended, edits)
  if (topSplices === null) {
    return null
  }
  const rawDocument = createRawPipelineDocumentAfterEdits(source, original, intended, edits)
  if (rawDocument === null) {
    return null
  }
  if (intended.nodes.length === 0) {
    if (original.nodes.length === 0) {
      return { splices: topSplices, mode: 'splice', rawDocument }
    }
    const range = source.nodes.range
    if (range === undefined || range === null) {
      return null
    }
    return {
      splices: [...topSplices, { start: range[0], end: range[1], replacement: '[]' }],
      mode: 'node-rerender',
      rawDocument
    }
  }
  const changes = changedNodes(original, intended)
  const splices = [...topSplices]
  let mode: PipelineEditMode = 'splice'
  for (const { before, after } of changes.changed) {
    const scalarSplices = forceNodeRerender ? null : nodeScalarSplices(source, before, after)
    if (scalarSplices !== null) {
      splices.push(...scalarSplices)
      continue
    }
    const replacement = nodeRerenderSplice(sourceText, source, before, after)
    if (replacement === null) {
      return null
    }
    splices.push(replacement)
    mode = 'node-rerender'
  }
  for (const node of changes.deleted) {
    const deletions = deleteNodeSplices(sourceText, source, original, node.id)
    if (deletions === null) {
      return null
    }
    splices.push(...deletions)
    mode = 'node-rerender'
  }
  if (changes.appended.length > 0) {
    const append = appendNodesSplice(sourceText, source, original, changes.appended)
    if (append === null) {
      return null
    }
    splices.push(append)
    mode = 'node-rerender'
  }
  return { splices, mode, rawDocument }
}

/** Apply non-overlapping source ranges from right to left. */
export function applyPipelineSourceSplices(
  sourceText: string,
  splices: readonly PipelineSourceSplice[]
): string {
  const ordered = [...splices].sort((left, right) => right.start - left.start)
  let text = sourceText
  let previousStart = sourceText.length + 1
  for (const splice of ordered) {
    if (splice.start < 0 || splice.end < splice.start || splice.end > previousStart) {
      throw new Error('Pipeline writer generated overlapping source edits')
    }
    text = `${text.slice(0, splice.start)}${splice.replacement}${text.slice(splice.end)}`
    previousStart = splice.start
  }
  return text
}
