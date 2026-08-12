import { validatePipelineTemplateGraph } from './pipeline-template-graph-rules'
import { validatePipelineTemplateStructure } from './pipeline-template-structural-rules'
import type { StructuralNode, StructuralRoot } from './pipeline-template-structural-rules'
import { SUPPORTED_PIPELINE_TEMPLATE_VERSION } from './pipeline-template-types'
import type {
  ParsedPipelineTemplate,
  PipelineNodeConfig,
  PipelineTemplateError,
  PipelineTemplateNode,
  ResolvedPipelineDefinition,
  ResolvedPipelineNode
} from './pipeline-template-types'
import { pipelineTemplateHasUnrecognizedKeys } from './pipeline-template-unknown-keys'
import { validatePipelineTemplateValues } from './pipeline-template-value-rules'
import { parsePipelineTemplateYaml } from './pipeline-template-yaml-parse'

export { assemblePipelineDispatchPrompt } from './pipeline-dispatch-prompt'
export * from './pipeline-template-types'

function basenameWithoutExtension(fileBasename: string): string {
  return fileBasename.replace(/\.[^./\\]+$/, '')
}

function toTemplateNode(node: StructuralNode): PipelineTemplateNode {
  const config: Partial<PipelineNodeConfig> = {}
  if (typeof node.raw.harness === 'string') {
    config.harness = node.raw.harness
  }
  if (typeof node.raw.model === 'string') {
    config.model = node.raw.model
  }
  if (typeof node.raw.effort === 'string') {
    config.effort = node.raw.effort
  }
  if (node.limitsRaw) {
    config.limits = { maxMinutes: node.limitsRaw.maxMinutes as number | undefined }
  }
  if (node.onFailureRaw) {
    config.onFailure = { retries: node.onFailureRaw.retries as number | undefined }
  }
  return {
    id: node.id,
    ...(node.title !== undefined ? { title: node.title } : {}),
    prompt: node.prompt,
    ...(node.needs !== undefined ? { needs: node.needs } : {}),
    ...config
  }
}

function toTemplateDefaults(root: StructuralRoot): Partial<PipelineNodeConfig> | undefined {
  if (!root.defaultsRaw) {
    return undefined
  }
  const config: Partial<PipelineNodeConfig> = {}
  if (typeof root.defaultsRaw.harness === 'string') {
    config.harness = root.defaultsRaw.harness
  }
  if (typeof root.defaultsRaw.model === 'string') {
    config.model = root.defaultsRaw.model
  }
  if (typeof root.defaultsRaw.effort === 'string') {
    config.effort = root.defaultsRaw.effort
  }
  if (root.defaultsLimitsRaw) {
    config.limits = { maxMinutes: root.defaultsLimitsRaw.maxMinutes as number | undefined }
  }
  if (root.defaultsOnFailureRaw) {
    config.onFailure = { retries: root.defaultsOnFailureRaw.retries as number | undefined }
  }
  return config
}

/**
 * Implements T11's nine structural/value/graph rules in fixed order, reporting the first
 * failure. Never throws on malformed input. T12 unknown keys never fail resolution; they
 * only set `needsNewerOrca`, as does a `version` greater than this Orca supports.
 */
export function parsePipelineTemplate(
  content: string,
  fileBasename: string
): { ok: true; template: ParsedPipelineTemplate } | { ok: false; error: PipelineTemplateError } {
  const yamlResult = parsePipelineTemplateYaml(content)
  if (!yamlResult.ok) {
    return yamlResult
  }

  const structuralResult = validatePipelineTemplateStructure(yamlResult.root)
  if (!structuralResult.ok) {
    return structuralResult
  }
  const root = structuralResult.root

  const valueError = validatePipelineTemplateValues(root)
  if (valueError) {
    return { ok: false, error: valueError }
  }

  const graphError = validatePipelineTemplateGraph(root)
  if (graphError) {
    return { ok: false, error: graphError }
  }

  const needsNewerOrca =
    root.version > SUPPORTED_PIPELINE_TEMPLATE_VERSION || pipelineTemplateHasUnrecognizedKeys(root)
  const defaults = toTemplateDefaults(root)

  return {
    ok: true,
    template: {
      version: root.version,
      name: root.name ?? basenameWithoutExtension(fileBasename),
      ...(root.description !== undefined ? { description: root.description } : {}),
      ...(defaults ? { defaults } : {}),
      nodes: root.nodes.map(toTemplateNode),
      needsNewerOrca
    }
  }
}

function substituteInput(prompt: string, inputText: string): string {
  return prompt.split('{{input}}').join(inputText)
}

/**
 * Merges `defaults` into each node (node wins), applies field defaults (title, retries,
 * needs), and substitutes `{{input}}` in every prompt. Preserves `nodes` list order as
 * each node's `index`.
 */
export function resolvePipelineDefinition(
  template: ParsedPipelineTemplate,
  inputText: string
): ResolvedPipelineDefinition {
  const defaults = template.defaults
  const nodes: ResolvedPipelineNode[] = template.nodes.map((node, index) => {
    const model = node.model ?? defaults?.model
    const effort = node.effort ?? defaults?.effort
    const maxMinutes = node.limits?.maxMinutes ?? defaults?.limits?.maxMinutes
    return {
      id: node.id,
      title: node.title ?? node.id,
      prompt: substituteInput(node.prompt, inputText),
      index,
      needs: node.needs ?? [],
      harness: (node.harness ?? defaults?.harness) as string,
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(maxMinutes !== undefined ? { limits: { maxMinutes } } : {}),
      onFailure: { retries: node.onFailure?.retries ?? defaults?.onFailure?.retries ?? 0 }
    }
  })

  return {
    templateName: template.name,
    templateVersion: template.version,
    needsNewerOrca: template.needsNewerOrca,
    inputText,
    nodes
  }
}
