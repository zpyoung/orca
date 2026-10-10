import {
  CST,
  Scalar,
  isMap,
  isScalar,
  isSeq,
  parseDocument,
  type YAMLMap,
  type YAMLSeq
} from 'yaml'
import { z } from 'zod'
import { isOrcaYamlTextWithinLimit, MAX_ORCA_YAML_ALIAS_COUNT } from '../../orca-yaml-file-limit'
import type { PipelineParseResult } from '../pipeline-parse'

export type PipelineSourceSplice = { start: number; end: number; replacement: string }
export type PipelineRawNode = Record<string, unknown>
export type PipelineRawDocument = Record<string, unknown>

export type PipelineSourceNodes = {
  root: YAMLMap
  nodes: YAMLSeq
  rawDocument: PipelineRawDocument
  rawNodes: PipelineRawNode[]
  parseResult: PipelineParseResult
}

const YAML_PARSE_OPTIONS = {
  uniqueKeys: true,
  logLevel: 'silent' as const,
  prettyErrors: false,
  keepSourceTokens: true
}

/** Parse structurally editable pipeline YAML with CST tokens and raw decoded values. */
export function parsePipelineSourceNodes(
  sourceText: string,
  parseResult: PipelineParseResult
): PipelineSourceNodes | null {
  if (!isOrcaYamlTextWithinLimit(sourceText)) {
    return null
  }
  const yamlDocument = parseDocument(sourceText, YAML_PARSE_OPTIONS)
  if (yamlDocument.errors.length > 0 || !isMap(yamlDocument.contents)) {
    return null
  }
  const nodes = yamlDocument.contents.get('nodes', true)
  if (!isSeq(nodes)) {
    return null
  }
  let rawValue: unknown = parseResult.sourceDocument
  if (rawValue === undefined) {
    try {
      rawValue = yamlDocument.toJS({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT })
    } catch {
      return null
    }
  }
  const rawDocument = z.record(z.string(), z.unknown()).safeParse(rawValue)
  if (!rawDocument.success) {
    return null
  }
  const rawNodes = z.array(z.record(z.string(), z.unknown())).safeParse(rawDocument.data.nodes)
  if (!rawNodes.success) {
    return null
  }
  return {
    root: yamlDocument.contents,
    nodes,
    rawDocument: rawDocument.data,
    rawNodes: rawNodes.data,
    parseResult
  }
}

/** Choose the original line-ending convention for rendered source fragments. */
export function lineEndingOf(text: string): string {
  const firstNewline = text.search(/\r\n|\n|\r/u)
  if (firstNewline < 0) {
    return '\n'
  }
  return text[firstNewline] === '\r' && text[firstNewline + 1] === '\n'
    ? '\r\n'
    : (text[firstNewline] ?? '\n')
}

/** Return the offset of the line containing a YAML source position. */
export function lineStartAt(text: string, offset: number): number {
  let start = offset
  while (start > 0 && text[start - 1] !== '\n' && text[start - 1] !== '\r') {
    start -= 1
  }
  return start
}

/** Detect whether a source range contains an empty line between items. */
export function hasBlankLine(text: string, start: number, end: number): boolean {
  const lines = text.slice(start, end).split(/\r\n|\n|\r/u)
  for (let index = 0; index < lines.length - 1; index += 1) {
    if (lines[index]?.trim() === '') {
      return true
    }
  }
  return false
}

function lineEndingLengthAt(text: string, offset: number): number {
  if (text.slice(offset, offset + 2) === '\r\n') {
    return 2
  }
  if (text[offset] === '\n' || text[offset] === '\r') {
    return 1
  }
  return 0
}

/** Locate one complete blank line for the structural delete policy. */
export function blankLineSpliceInRange(
  text: string,
  start: number,
  end: number
): PipelineSourceSplice | null {
  let lineStart = start
  while (lineStart < end) {
    let lineEnd = lineStart
    while (lineEnd < end && text[lineEnd] !== '\n' && text[lineEnd] !== '\r') {
      lineEnd += 1
    }
    const endingLength = lineEndingLengthAt(text, lineEnd)
    if (text.slice(lineStart, lineEnd).trim() === '' && endingLength > 0) {
      return {
        start: lineStart,
        end: lineEnd + endingLength,
        replacement: ''
      }
    }
    if (endingLength === 0) {
      return null
    }
    lineStart = lineEnd + endingLength
  }
  return null
}

/** Mutate a parsed scalar token and capture its exact replacement range. */
export function scalarText(
  node: unknown,
  value: string | number | boolean | null
): PipelineSourceSplice | null {
  if (
    !isScalar(node) ||
    node.srcToken === undefined ||
    node.range === undefined ||
    node.range === null
  ) {
    return null
  }
  const [start, , end] = node.range
  let preferredType = node.type ?? Scalar.PLAIN
  if (typeof value !== 'string') {
    preferredType = Scalar.PLAIN
  }
  const scalarValue = String(value)
  CST.setScalarValue(node.srcToken, scalarValue, { afterKey: true, type: preferredType })
  if (typeof value === 'string' && CST.resolveAsScalar(node.srcToken)?.value !== value) {
    CST.setScalarValue(node.srcToken, value, {
      afterKey: true,
      type: Scalar.QUOTE_DOUBLE
    })
  }
  return { start, end, replacement: CST.stringify(node.srcToken) }
}
