import {
  PIPELINE_NODE_TYPES,
  PIPELINE_NODE_TYPE_DISPLAY_NAMES,
  type NodeType,
  type PipelineCapabilityKey,
  type PipelineDocument,
  type PipelineNode
} from './document-schema'
import { validatePipelineNodeDetails } from './pipeline-node-validation'

export const PIPELINE_VALIDATION_CODES = [
  'yaml-parse',
  'schema',
  'schema-version-unsupported',
  'id-mismatch',
  'duplicate-node-id',
  'unknown-node-type',
  'dangling-edge',
  'cycle',
  'missing-field',
  'invalid-output-ref',
  'ref-not-upstream',
  'decision-when-unknown',
  'when-without-decision',
  'loop-body-invalid',
  'loop-until-invalid',
  'git-only-node-in-folder',
  'own-worktree-in-folder',
  'objective-not-sole-node',
  'multiple-pr-sitter',
  'pr-sitter-without-land',
  'multiple-land',
  'merge-source-not-swarm',
  'send-back-not-ancestor',
  'capability-unknown',
  'node-type-unsupported-by-host',
  'ref-in-script-command',
  'script-env-denied'
] as const
export type PipelineValidationCode = (typeof PIPELINE_VALIDATION_CODES)[number]
export type PipelineValidationContext = {
  workspaceKind: 'git' | 'folder' | 'unknown'
  hostNodeTypes?: ReadonlySet<NodeType>
  hostLabel?: string
  expectedId?: string
}
export type PipelineValidationError = {
  nodeId: string | null
  code: PipelineValidationCode
  message: string
  path?: (string | number)[]
  line?: number
}

type OrderedValidationError = {
  error: PipelineValidationError
  nodeIndex: number | null
  order: number
}
type AddPipelineError = (
  nodeId: string | null,
  nodeIndex: number | null,
  code: PipelineValidationCode,
  message: string,
  path?: (string | number)[]
) => void

const CAPABILITY_KEYS: Readonly<Record<PipelineCapabilityKey, true>> = {
  agent: true,
  check: true,
  script: true,
  integrate: true,
  push: true,
  land: true,
  updateBranch: true,
  resolveConflicts: true,
  fixChecks: true,
  merge: true,
  gate: true,
  pipeline: true
}

export function validatePipeline(
  document: PipelineDocument,
  context: PipelineValidationContext
): readonly PipelineValidationError[] {
  const ordered: OrderedValidationError[] = []
  let order = 0
  const addError: AddPipelineError = (nodeId, nodeIndex, code, message, path) => {
    ordered.push({
      error: { nodeId, code, message, ...(path === undefined ? {} : { path }) },
      nodeIndex,
      order
    })
    order += 1
  }

  const nodeIndexById = new Map<string, number>()
  const byId = new Map<string, PipelineNode>()
  document.nodes.forEach((node, index) => {
    if (nodeIndexById.has(node.id)) {
      addError(node.id, index, 'duplicate-node-id', `Node id ${node.id} is duplicated`, [
        'nodes',
        index,
        'id'
      ])
    } else {
      nodeIndexById.set(node.id, index)
      byId.set(node.id, node)
    }
  })

  if (context.expectedId !== undefined && document.id !== context.expectedId) {
    addError(
      null,
      null,
      'id-mismatch',
      `Pipeline id ${document.id} does not match ${context.expectedId}`,
      ['id']
    )
  }

  const usedTypes = new Set<NodeType>()
  for (const node of document.nodes) {
    usedTypes.add(node.type)
  }
  if (context.hostNodeTypes !== undefined) {
    const missingTypes = PIPELINE_NODE_TYPES.filter(
      (type) => usedTypes.has(type) && !context.hostNodeTypes?.has(type)
    )
    if (missingTypes.length > 0) {
      const displayNames = missingTypes
        .map((type) => PIPELINE_NODE_TYPE_DISPLAY_NAMES[type])
        .join(', ')
      addError(
        null,
        null,
        'node-type-unsupported-by-host',
        `Update Orca on ${context.hostLabel ?? 'this host'} to run this pipeline (needs: ${displayNames})`
      )
    }
  }

  if (document.capabilities !== undefined) {
    for (const key of Object.keys(document.capabilities)) {
      if (!Object.hasOwn(CAPABILITY_KEYS, key) || key === 'gate' || key === 'pipeline') {
        addError(null, null, 'capability-unknown', `Capability ${key} cannot be requested`)
      }
    }
  }

  const sitterNodes = document.nodes.filter((node) => node.type === 'pr-sitter')
  if (sitterNodes.length > 1) {
    for (const node of sitterNodes.slice(1)) {
      addError(
        node.id,
        nodeIndexById.get(node.id) ?? null,
        'multiple-pr-sitter',
        'Only one PR sitter is allowed'
      )
    }
  }
  const landNodes = document.nodes.filter((node) => node.type === 'land')
  if (landNodes.length > 1) {
    for (const node of landNodes.slice(1)) {
      addError(
        node.id,
        nodeIndexById.get(node.id) ?? null,
        'multiple-land',
        'Only one Land node is allowed'
      )
    }
  }
  const objectiveNodes = document.nodes.filter((node) => node.type === 'objective')
  if (objectiveNodes.length > 0 && document.nodes.length > 1) {
    for (const node of objectiveNodes) {
      addError(
        node.id,
        nodeIndexById.get(node.id) ?? null,
        'objective-not-sole-node',
        'Objective must be the only node'
      )
    }
  }
  validatePipelineNodeDetails(
    document,
    context.workspaceKind,
    byId,
    nodeIndexById,
    sitterNodes,
    addError
  )

  ordered.sort((left, right) => {
    if (left.nodeIndex === null && right.nodeIndex !== null) {
      return -1
    }
    if (left.nodeIndex !== null && right.nodeIndex === null) {
      return 1
    }
    const indexDifference = (left.nodeIndex ?? -1) - (right.nodeIndex ?? -1)
    if (indexDifference !== 0) {
      return indexDifference
    }
    const leftCode = PIPELINE_VALIDATION_CODES.indexOf(left.error.code)
    const rightCode = PIPELINE_VALIDATION_CODES.indexOf(right.error.code)
    return leftCode - rightCode || left.order - right.order
  })
  return ordered.map(({ error }) => error)
}
