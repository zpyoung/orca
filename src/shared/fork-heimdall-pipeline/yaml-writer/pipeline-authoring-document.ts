import type { NodeType, PipelineDocument, PipelineNode } from '../document-schema'

type PipelineAuthoringNodeRecord = {
  id: string
  type: NodeType
  [key: string]: unknown
}

export type PipelineAuthoringNode = PipelineNode | PipelineAuthoringNodeRecord
export type PipelineAuthoringDocument = Omit<PipelineDocument, 'inputs' | 'nodes'> & {
  inputs?: PipelineDocument['inputs']
  nodes: PipelineAuthoringNode[]
}
