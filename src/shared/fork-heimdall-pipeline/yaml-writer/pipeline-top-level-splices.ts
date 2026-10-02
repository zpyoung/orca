import { isMap, isScalar, isSeq, stringify } from 'yaml'
import type { PipelineAuthoringDocument } from './pipeline-authoring-document'
import { arePipelineEditValuesEqual, isPipelineScalarValue } from './pipeline-edit-values'
import type { PipelineEdit, PipelineTopKey } from './pipeline-edit-types'
import {
  lineEndingOf,
  lineStartAt,
  scalarText,
  type PipelineSourceNodes,
  type PipelineSourceSplice
} from './pipeline-yaml-cst'

const TOP_LEVEL_ORDER: readonly string[] = [
  'version',
  'id',
  'name',
  'description',
  'inputs',
  'capabilities',
  'defaults',
  'nodes'
]

function getTopValue(document: PipelineAuthoringDocument, key: PipelineTopKey): unknown {
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

function deleteTopPropertySplice(
  sourceText: string,
  source: PipelineSourceNodes,
  key: PipelineTopKey
): PipelineSourceSplice | null {
  if (source.root.srcToken?.type === 'flow-collection') {
    return null
  }
  for (const pair of source.root.items) {
    if (!isScalar(pair.key) || pair.key.value !== key) {
      continue
    }
    const value = pair.value
    if (!isScalar(value) && !isMap(value) && !isSeq(value)) {
      return null
    }
    const keyRange = pair.key.range
    const valueRange = value.range
    if (
      keyRange === undefined ||
      keyRange === null ||
      valueRange === undefined ||
      valueRange === null
    ) {
      return null
    }
    return {
      start: lineStartAt(sourceText, keyRange[0]),
      end: valueRange[2],
      replacement: ''
    }
  }
  return null
}

function insertTopPropertySplice(
  sourceText: string,
  source: PipelineSourceNodes,
  key: PipelineTopKey,
  value: unknown
): PipelineSourceSplice | null {
  if (source.root.srcToken?.type === 'flow-collection') {
    return null
  }
  const keyRank = TOP_LEVEL_ORDER.indexOf(key)
  const nextPair = source.root.items.find((pair) => {
    const pairKey = pair.key
    if (!isScalar(pairKey) || typeof pairKey.value !== 'string') {
      return false
    }
    const rank = TOP_LEVEL_ORDER.indexOf(pairKey.value)
    return rank !== -1 && rank > keyRank
  })
  if (nextPair === undefined) {
    return null
  }
  const nextKey = nextPair.key
  if (!isScalar(nextKey) || nextKey.range === undefined || nextKey.range === null) {
    return null
  }
  const insertionOffset =
    nextPair.srcToken?.start[0]?.offset ?? lineStartAt(sourceText, nextKey.range[0])
  const lineEnding = lineEndingOf(sourceText)
  const rendered = stringify({ [key]: value }, { indent: 2, lineWidth: 0 })
  const entry = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered
  return {
    start: insertionOffset,
    end: insertionOffset,
    replacement: entry.replaceAll('\n', lineEnding)
  }
}

function topLevelValueSplice(
  sourceText: string,
  source: PipelineSourceNodes,
  key: PipelineTopKey,
  value: unknown
): PipelineSourceSplice | null {
  const valueNode = source.root.get(key, true)
  if (isPipelineScalarValue(value)) {
    return scalarText(valueNode, value)
  }
  if (!isMap(valueNode) && !isSeq(valueNode)) {
    return null
  }
  const range = valueNode.range
  if (range === undefined || range === null) {
    return null
  }
  const lineStart = lineStartAt(sourceText, range[0])
  const leading = sourceText.slice(lineStart, range[0])
  const lineEnding = lineEndingOf(sourceText)
  const rendered = stringify(
    value,
    leading.trim() === '' ? { indent: 2, lineWidth: 0 } : { flow: true, lineWidth: 0 }
  )
  const withoutDocumentEnding = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered
  const replacement =
    leading.trim() === ''
      ? withoutDocumentEnding
          .split('\n')
          .map((line, index) => (index === 0 ? line : `${leading}${line}`))
          .join(lineEnding)
      : withoutDocumentEnding.replaceAll('\n', lineEnding)
  const replacedSource = sourceText.slice(range[0], range[1])
  const ending = replacedSource.endsWith('\r\n')
    ? '\r\n'
    : replacedSource.endsWith('\n')
      ? '\n'
      : replacedSource.endsWith('\r')
        ? '\r'
        : ''
  return { start: range[0], end: range[1], replacement: `${replacement}${ending}` }
}

/** Build local source edits for top-level document fields. */
export function createTopLevelSplices(
  sourceText: string,
  source: PipelineSourceNodes,
  original: PipelineAuthoringDocument,
  intended: PipelineAuthoringDocument,
  edits: readonly PipelineEdit[]
): PipelineSourceSplice[] | null {
  const keys = new Set<PipelineTopKey>()
  for (const edit of edits) {
    if (edit.kind === 'set-top') {
      keys.add(edit.key)
    }
  }
  const splices: PipelineSourceSplice[] = []
  const orderedKeys = [...keys].sort(
    (left, right) => TOP_LEVEL_ORDER.indexOf(right) - TOP_LEVEL_ORDER.indexOf(left)
  )
  for (const key of orderedKeys) {
    const previous = getTopValue(original, key)
    const next = getTopValue(intended, key)
    if (arePipelineEditValuesEqual(previous, next)) {
      continue
    }
    const existing = source.root.get(key, true)
    const replacement =
      next === undefined
        ? deleteTopPropertySplice(sourceText, source, key)
        : existing === undefined
          ? insertTopPropertySplice(sourceText, source, key, next)
          : topLevelValueSplice(sourceText, source, key, next)
    if (replacement === null) {
      return null
    }
    splices.push(replacement)
  }
  return splices
}
