export const PIPELINE_TEMPLATE_NODE_ID_PATTERN = /^[a-z0-9-]{1,64}$/
export const SUPPORTED_PIPELINE_TEMPLATE_VERSION = 1

export type PipelineNodeConfig = {
  harness: string
  model?: string
  effort?: string
  limits?: { maxMinutes?: number }
  onFailure?: { retries?: number }
}

export type PipelineTemplateNode = {
  id: string
  title?: string
  prompt: string
  needs?: string[]
} & Partial<PipelineNodeConfig>

export type ParsedPipelineTemplate = {
  version: number
  name: string
  description?: string
  defaults?: Partial<PipelineNodeConfig>
  nodes: PipelineTemplateNode[]
  needsNewerOrca: boolean
}

export type PipelineTemplateError = {
  rule: number
  nodeId?: string
  field?: string
  message: string
}

export type ResolvedPipelineNode = {
  id: string
  title: string
  prompt: string
  index: number
  needs: string[]
} & PipelineNodeConfig

export type ResolvedPipelineDefinition = {
  templateName: string
  templateVersion: number
  needsNewerOrca: boolean
  inputText: string
  nodes: ResolvedPipelineNode[]
}
