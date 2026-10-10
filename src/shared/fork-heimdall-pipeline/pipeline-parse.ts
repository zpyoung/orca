import { isMap, isSeq, parseDocument, type Document } from 'yaml'
import { z } from 'zod'
import { isOrcaYamlTextWithinLimit, MAX_ORCA_YAML_ALIAS_COUNT } from '../orca-yaml-file-limit'
import {
  PipelineDocumentSchema,
  PIPELINE_NODE_TYPES,
  type PipelineDocument
} from './document-schema'
import type { NodeId } from './node-id'
import type { PipelineValidationError } from './pipeline-validate'

export type PipelineSourceRange = { start: number; end: number }
export type PipelineParseResult = {
  document: PipelineDocument | null
  errors: PipelineValidationError[]
  sourceMap: Map<NodeId, PipelineSourceRange>
  sourceDocument?: unknown
}

function nodeRangeMap(yamlDocument: Document): Map<NodeId, PipelineSourceRange> {
  const sourceMap = new Map<NodeId, PipelineSourceRange>()
  const contents = yamlDocument.contents
  if (!isMap(contents)) {
    return sourceMap
  }
  const nodes = contents.get('nodes')
  if (!isSeq(nodes)) {
    return sourceMap
  }
  for (const item of nodes.items) {
    if (!isMap(item)) {
      continue
    }
    const id = item.get('id')
    const range = item.range
    if (
      typeof id === 'string' &&
      Array.isArray(range) &&
      typeof range[0] === 'number' &&
      typeof range[1] === 'number'
    ) {
      sourceMap.set(id, { start: range[0], end: range[1] })
    }
  }
  return sourceMap
}

function recordFrom(value: unknown): Record<string, unknown> | null {
  const parsed = z.record(z.string(), z.unknown()).safeParse(value)
  return parsed.success ? parsed.data : null
}

function makeError(
  nodeId: string | null,
  code: PipelineValidationError['code'],
  message: string,
  path?: (string | number)[],
  line?: number
): PipelineValidationError {
  return {
    nodeId,
    code,
    message,
    ...(path === undefined ? {} : { path }),
    ...(line === undefined ? {} : { line })
  }
}

export function parsePipelineText(text: string): PipelineParseResult {
  const sourceMap = new Map<NodeId, PipelineSourceRange>()
  if (!isOrcaYamlTextWithinLimit(text)) {
    return {
      document: null,
      errors: [makeError(null, 'yaml-parse', 'Pipeline YAML exceeds 256 KiB', undefined, 1)],
      sourceMap
    }
  }

  let yamlDocument: Document
  try {
    yamlDocument = parseDocument(text, {
      uniqueKeys: true,
      logLevel: 'silent',
      prettyErrors: false,
      keepSourceTokens: true
    })
  } catch {
    return {
      document: null,
      errors: [makeError(null, 'yaml-parse', 'Invalid pipeline YAML', undefined, 1)],
      sourceMap
    }
  }
  const ranges = nodeRangeMap(yamlDocument)
  for (const [id, range] of ranges) {
    sourceMap.set(id, range)
  }
  if (yamlDocument.errors.length > 0) {
    const errors = yamlDocument.errors.map((error) =>
      makeError(null, 'yaml-parse', error.message, undefined, error.linePos?.[0]?.line ?? 1)
    )
    return { document: null, errors, sourceMap }
  }

  let root: unknown
  try {
    root = yamlDocument.toJS({ maxAliasCount: MAX_ORCA_YAML_ALIAS_COUNT })
  } catch {
    return {
      document: null,
      errors: [makeError(null, 'yaml-parse', 'Pipeline YAML could not be expanded', undefined, 1)],
      sourceMap
    }
  }
  const rootRecord = recordFrom(root)
  if (rootRecord?.version !== 1) {
    return {
      document: null,
      errors: [
        makeError(null, 'schema-version-unsupported', 'Pipeline version must be 1', ['version'])
      ],
      sourceMap,
      sourceDocument: root
    }
  }

  const rawNodes = rootRecord.nodes
  if (Array.isArray(rawNodes)) {
    const errors: PipelineValidationError[] = []
    for (let index = 0; index < rawNodes.length; index += 1) {
      const node = recordFrom(rawNodes[index])
      if (
        typeof node?.type !== 'string' ||
        PIPELINE_NODE_TYPES.some((knownType) => knownType === node.type)
      ) {
        continue
      }
      const nodeId = typeof node.id === 'string' ? node.id : null
      errors.push(
        makeError(nodeId, 'unknown-node-type', `Unknown pipeline node type "${node.type}"`, [
          'nodes',
          index,
          'type'
        ])
      )
    }
    if (errors.length > 0) {
      return { document: null, errors, sourceMap, sourceDocument: root }
    }
  }

  const parsed = PipelineDocumentSchema.safeParse(root)
  if (parsed.success) {
    return { document: parsed.data, errors: [], sourceMap, sourceDocument: root }
  }

  const rawNodeIds = Array.isArray(rawNodes)
    ? rawNodes.map((node) => {
        const nodeRecord = recordFrom(node)
        return typeof nodeRecord?.id === 'string' ? nodeRecord.id : null
      })
    : []
  const errors = parsed.error.issues.map((issue) => {
    const path = issue.path.filter(
      (segment): segment is string | number =>
        typeof segment === 'string' || typeof segment === 'number'
    )
    const nodeIndex = path[0] === 'nodes' && typeof path[1] === 'number' ? path[1] : null
    const nodeId = nodeIndex === null ? null : (rawNodeIds[nodeIndex] ?? null)
    return makeError(nodeId, 'schema', issue.message, path)
  })
  return { document: null, errors, sourceMap, sourceDocument: root }
}
