import {
  OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB,
  type ObjectiveWorkspaceKind
} from '../fork-heimdall-objective/contract-types'
import type {
  PipelineDocument,
  PipelineObjectiveNode,
  PipelinePrSitterNode
} from './document-schema'

export type PipelineEnrollmentKind = 'objective' | 'hosted-review' | 'pipeline'

export class PipelineRoutingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PipelineRoutingError'
  }
}

export function routeEnrollmentKind(document: PipelineDocument): PipelineEnrollmentKind {
  if (document.nodes.length === 1 && document.nodes[0]?.type === 'objective') {
    return 'objective'
  }
  if (document.nodes.length === 1 && document.nodes[0]?.type === 'pr-sitter') {
    return 'hosted-review'
  }
  return 'pipeline'
}

function soleObjective(document: PipelineDocument): PipelineObjectiveNode {
  const node = document.nodes[0]
  if (document.nodes.length !== 1 || node?.type !== 'objective') {
    throw new PipelineRoutingError('Pipeline does not route to the Objective kind')
  }
  return node
}

function solePrSitter(document: PipelineDocument): PipelinePrSitterNode {
  const node = document.nodes[0]
  if (document.nodes.length !== 1 || node?.type !== 'pr-sitter') {
    throw new PipelineRoutingError('Pipeline does not route to the hosted-review kind')
  }
  return node
}

export function objectiveKindPayloadFromDocument(
  document: PipelineDocument,
  options: { objectiveText: string; workspaceKind: ObjectiveWorkspaceKind }
) {
  const node = soleObjective(document)
  return {
    objectiveText: options.objectiveText,
    tier: node.tier,
    landingBar: node.landingBar,
    lanesEnabled: node.lanesEnabled ?? true,
    maxConcurrency: node.maxConcurrency ?? 3,
    workspaceKind: options.workspaceKind,
    writeTerritory: [OBJECTIVE_ALL_WORKSPACE_PATHS_GLOB],
    roleAgents: node.roleAgents ?? {},
    sitterOverrides: {},
    ...(node.checks === undefined ? {} : { gates: node.checks })
  }
}

export function sitterKindPayloadFromDocument(document: PipelineDocument) {
  const node = solePrSitter(document)
  return {
    branchUpdateMode: node.branchUpdateMode ?? 'merge-base-update',
    mergeMethod: node.mergeMethod ?? null,
    mergeCheckScope: node.mergeCheckScope,
    repeatFixLimit: node.repeatFixLimit
  }
}
