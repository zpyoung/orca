import { PIPELINE_NODE_TYPES, type NodeType } from './document-schema'

export const HEIMDALL_PIPELINE_RUNTIME_CAPABILITY = 'heimdall.pipeline.v1'
export const HEIMDALL_PIPELINE_NODE_CAPABILITY = (type: NodeType): string =>
  `heimdall.pipeline-node.${type}.v1`
export const HEIMDALL_PIPELINE_RUNTIME_CAPABILITIES: readonly string[] = [
  HEIMDALL_PIPELINE_RUNTIME_CAPABILITY,
  ...PIPELINE_NODE_TYPES.map(HEIMDALL_PIPELINE_NODE_CAPABILITY)
]
export const HEIMDALL_PIPELINE_CLIENT_CAPABILITIES = ['heimdall.pipeline.v1'] as const

export function hostPipelineNodeTypes(advertised: readonly string[]): ReadonlySet<NodeType> {
  const capabilities = new Set(advertised)
  return new Set(
    PIPELINE_NODE_TYPES.filter((type) => capabilities.has(HEIMDALL_PIPELINE_NODE_CAPABILITY(type)))
  )
}
