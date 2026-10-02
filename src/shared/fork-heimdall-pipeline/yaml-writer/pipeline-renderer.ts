import { stringify } from 'yaml'
import type { NodeType, PipelineNode } from '../document-schema'
import type {
  PipelineAuthoringDocument,
  PipelineAuthoringNode
} from './pipeline-authoring-document'
import type { PipelineRawDocument, PipelineRawNode } from './pipeline-yaml-cst'

type PipelineRenderableProperties =
  | PipelineAuthoringDocument
  | PipelineAuthoringNode
  | PipelineRawDocument
  | PipelineRawNode

const TOP_LEVEL_KEYS = [
  'version',
  'id',
  'name',
  'description',
  'inputs',
  'capabilities',
  'defaults',
  'nodes'
] as const

const NODE_TYPE_FIELDS = {
  agent: ['harness', 'model', 'effort', 'prompt', 'onFail'],
  check: ['command', 'timeoutSeconds', 'onFail'],
  script: ['command', 'capability', 'inputs', 'timeoutSeconds'],
  decision: ['on'],
  loop: ['body', 'until', 'maxRounds'],
  swarm: ['from', 'maxParallel', 'worktree', 'child'],
  merge: ['from'],
  gate: ['sendBackTo', 'notify'],
  land: ['title', 'body', 'draft', 'commitMessage'],
  objective: ['tier', 'landingBar', 'checks', 'roleAgents', 'maxConcurrency', 'lanesEnabled'],
  'pr-sitter': ['repeatFixLimit', 'branchUpdateMode', 'mergeMethod', 'mergeCheckScope']
} as const

function orderedProperties(
  value: PipelineRenderableProperties,
  preferredKeys: readonly string[]
): PipelineRawNode {
  const remaining = new Map(Object.entries(value))
  const ordered: PipelineRawNode = {}
  for (const key of preferredKeys) {
    const property = remaining.get(key)
    if (property !== undefined) {
      ordered[key] = property
      remaining.delete(key)
    }
  }
  for (const [key, property] of remaining) {
    if (property !== undefined) {
      ordered[key] = property
    }
  }
  return ordered
}

function orderedNodeProperties(
  node: PipelineAuthoringNode | PipelineRawNode,
  nodeType: NodeType
): PipelineRawNode {
  return orderedProperties(node, [
    'id',
    'type',
    'label',
    'after',
    ...NODE_TYPE_FIELDS[nodeType],
    'outputs',
    'retry',
    'timeLimitMinutes'
  ])
}

function orderedNode(node: PipelineAuthoringNode): PipelineRawNode {
  return orderedNodeProperties(node, node.type)
}

/** Render a pipeline with canonical key order, including incomplete editor drafts. */
export function renderNewPipeline(document: PipelineAuthoringDocument): string {
  const nodes = document.nodes.map(orderedNode)
  const orderedDocumentInput: PipelineRawDocument = { ...document, nodes }
  const orderedDocument = orderedProperties(orderedDocumentInput, TOP_LEVEL_KEYS)
  return stringify(orderedDocument, { indent: 2, lineWidth: 0 })
}

/** Render one block-sequence item at the sequence's existing indentation. */
export function renderPipelineNodeSequenceEntry(
  node: PipelineNode,
  sequenceIndent: number,
  lineEnding: string
): string {
  return renderNodeRecordSequenceEntry(node, node.type, sequenceIndent, lineEnding)
}
/** Render a raw node map using canonical node keys without schema validation. */
export function renderPipelineNodeRecordSequenceEntry(
  node: PipelineRawNode,
  nodeType: NodeType,
  sequenceIndent: number,
  lineEnding: string
): string {
  return renderNodeRecordSequenceEntry(node, nodeType, sequenceIndent, lineEnding)
}

function renderNodeRecordSequenceEntry(
  node: PipelineAuthoringNode | PipelineRawNode,
  nodeType: NodeType,
  sequenceIndent: number,
  lineEnding: string
): string {
  const rendered = stringify([orderedNodeProperties(node, nodeType)], {
    indent: 2,
    lineWidth: 0
  })
  const withoutDocumentEnding = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered
  const indentation = ' '.repeat(sequenceIndent)
  return withoutDocumentEnding
    .split('\n')
    .map((line) => `${indentation}${line}`)
    .join(lineEnding)
}
