import { isPlainMap } from './pipeline-template-raw-map'
import { PIPELINE_TEMPLATE_NODE_ID_PATTERN } from './pipeline-template-types'
import type { PipelineTemplateError } from './pipeline-template-types'

export type StructuralNode = {
  raw: Record<string, unknown>
  id: string
  title?: string
  prompt: string
  needs?: string[]
  limitsRaw?: Record<string, unknown>
  onFailureRaw?: Record<string, unknown>
}

export type StructuralRoot = {
  raw: Record<string, unknown>
  version: number
  name?: string
  description?: string
  defaultsRaw?: Record<string, unknown>
  defaultsLimitsRaw?: Record<string, unknown>
  defaultsOnFailureRaw?: Record<string, unknown>
  nodes: StructuralNode[]
}

export type StructuralValidationResult =
  | { ok: true; root: StructuralRoot }
  | { ok: false; error: PipelineTemplateError }

function err(rule: number, message: string, nodeId?: string, field?: string): PipelineTemplateError {
  return { rule, nodeId, field, message }
}

function isTemplateError(value: StructuralNode | PipelineTemplateError): value is PipelineTemplateError {
  return 'rule' in value
}

function validateNode(node: unknown, index: number): StructuralNode | PipelineTemplateError {
  if (!isPlainMap(node)) {
    return err(6, `Node at position ${index} must be a map.`, undefined, `nodes[${index}]`)
  }

  const idValue = node.id
  if (typeof idValue !== 'string' || !PIPELINE_TEMPLATE_NODE_ID_PATTERN.test(idValue)) {
    return err(
      6,
      'id is missing, not a string, or does not match ^[a-z0-9-]{1,64}$.',
      typeof idValue === 'string' ? idValue : undefined,
      'id'
    )
  }

  if (node.title !== undefined && typeof node.title !== 'string') {
    return err(6, 'title must be a string.', idValue, 'title')
  }

  const prompt = node.prompt
  if (typeof prompt !== 'string' || prompt.trim().length === 0) {
    return err(6, 'prompt is missing, not a string, or empty.', idValue, 'prompt')
  }

  let needs: string[] | undefined
  if (node.needs !== undefined) {
    if (!Array.isArray(node.needs) || node.needs.some((entry) => typeof entry !== 'string')) {
      return err(6, 'needs must be a list of strings.', idValue, 'needs')
    }
    needs = node.needs as string[]
  }

  if (node.limits !== undefined && !isPlainMap(node.limits)) {
    return err(6, 'limits must be a map.', idValue, 'limits')
  }
  if (node.onFailure !== undefined && !isPlainMap(node.onFailure)) {
    return err(6, 'onFailure must be a map.', idValue, 'onFailure')
  }

  return {
    raw: node,
    id: idValue,
    title: node.title as string | undefined,
    prompt,
    needs,
    limitsRaw: isPlainMap(node.limits) ? node.limits : undefined,
    onFailureRaw: isPlainMap(node.onFailure) ? node.onFailure : undefined
  }
}

/** T11 rules 2-6: document-shape validation, evaluated in fixed order over the parsed root. */
export function validatePipelineTemplateStructure(raw: Record<string, unknown>): StructuralValidationResult {
  const version = raw.version
  if (typeof version !== 'number' || !Number.isInteger(version) || version <= 0) {
    return { ok: false, error: err(2, 'version is missing or not a positive integer.', undefined, 'version') }
  }

  if (raw.name !== undefined && typeof raw.name !== 'string') {
    return { ok: false, error: err(3, 'name must be a string.', undefined, 'name') }
  }
  if (raw.description !== undefined && typeof raw.description !== 'string') {
    return { ok: false, error: err(3, 'description must be a string.', undefined, 'description') }
  }

  let defaultsRaw: Record<string, unknown> | undefined
  let defaultsLimitsRaw: Record<string, unknown> | undefined
  let defaultsOnFailureRaw: Record<string, unknown> | undefined
  if (raw.defaults !== undefined) {
    if (!isPlainMap(raw.defaults)) {
      return { ok: false, error: err(4, 'defaults must be a map.', undefined, 'defaults') }
    }
    defaultsRaw = raw.defaults
    if (defaultsRaw.limits !== undefined && !isPlainMap(defaultsRaw.limits)) {
      return { ok: false, error: err(4, 'defaults.limits must be a map.', undefined, 'defaults.limits') }
    }
    if (defaultsRaw.onFailure !== undefined && !isPlainMap(defaultsRaw.onFailure)) {
      return { ok: false, error: err(4, 'defaults.onFailure must be a map.', undefined, 'defaults.onFailure') }
    }
    defaultsLimitsRaw = isPlainMap(defaultsRaw.limits) ? defaultsRaw.limits : undefined
    defaultsOnFailureRaw = isPlainMap(defaultsRaw.onFailure) ? defaultsRaw.onFailure : undefined
  }

  if (raw.nodes === undefined || !Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    return { ok: false, error: err(5, 'nodes is missing, not a list, or empty.', undefined, 'nodes') }
  }

  const seenIds = new Set<string>()
  const nodes: StructuralNode[] = []
  for (const [index, rawNode] of raw.nodes.entries()) {
    const node = validateNode(rawNode, index)
    if (isTemplateError(node)) {
      return { ok: false, error: node }
    }
    if (seenIds.has(node.id)) {
      return { ok: false, error: err(6, `Duplicate node id "${node.id}".`, node.id, 'id') }
    }
    seenIds.add(node.id)
    nodes.push(node)
  }

  return {
    ok: true,
    root: {
      raw,
      version,
      name: raw.name as string | undefined,
      description: raw.description as string | undefined,
      defaultsRaw,
      defaultsLimitsRaw,
      defaultsOnFailureRaw,
      nodes
    }
  }
}
