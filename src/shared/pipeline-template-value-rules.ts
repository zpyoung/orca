import type { StructuralNode, StructuralRoot } from './pipeline-template-structural-rules'
import type { PipelineTemplateError } from './pipeline-template-types'

function err(nodeId: string | undefined, field: string, message: string): PipelineTemplateError {
  return { rule: 7, nodeId, field, message }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function validateDefaultsMap(root: StructuralRoot): PipelineTemplateError | null {
  const defaults = root.defaultsRaw
  if (!defaults) {
    return null
  }
  if (defaults.harness !== undefined && (typeof defaults.harness !== 'string' || defaults.harness.trim() === '')) {
    return err(undefined, 'defaults.harness', 'harness must be a non-empty string.')
  }
  if (defaults.model !== undefined && typeof defaults.model !== 'string') {
    return err(undefined, 'defaults.model', 'model must be a string.')
  }
  if (defaults.effort !== undefined && typeof defaults.effort !== 'string') {
    return err(undefined, 'defaults.effort', 'effort must be a string.')
  }
  const retries = root.defaultsOnFailureRaw?.retries
  if (retries !== undefined && (!Number.isInteger(retries) || (retries as number) < 0 || (retries as number) > 10)) {
    return err(undefined, 'defaults.onFailure.retries', 'onFailure.retries must be an integer between 0 and 10.')
  }
  const maxMinutes = root.defaultsLimitsRaw?.maxMinutes
  if (maxMinutes !== undefined && (!isFiniteNumber(maxMinutes) || maxMinutes <= 0)) {
    return err(undefined, 'defaults.limits.maxMinutes', 'limits.maxMinutes must be a finite number greater than 0.')
  }
  return null
}

function validateNodeMap(node: StructuralNode, root: StructuralRoot): PipelineTemplateError | null {
  const ownHarness = node.raw.harness
  if (ownHarness !== undefined && (typeof ownHarness !== 'string' || ownHarness.trim() === '')) {
    return err(node.id, 'harness', 'harness must be a non-empty string.')
  }
  const effectiveHarness = (typeof ownHarness === 'string' ? ownHarness : undefined) ?? root.defaultsRaw?.harness
  if (typeof effectiveHarness !== 'string' || effectiveHarness.trim() === '') {
    return err(node.id, 'harness', 'no effective harness after merging defaults.')
  }

  const ownModel = node.raw.model
  if (ownModel !== undefined && typeof ownModel !== 'string') {
    return err(node.id, 'model', 'model must be a string.')
  }
  const ownEffort = node.raw.effort
  if (ownEffort !== undefined && typeof ownEffort !== 'string') {
    return err(node.id, 'effort', 'effort must be a string.')
  }
  const effectiveModel = (typeof ownModel === 'string' ? ownModel : undefined) ?? root.defaultsRaw?.model
  const effectiveEffort = (typeof ownEffort === 'string' ? ownEffort : undefined) ?? root.defaultsRaw?.effort
  if (effectiveEffort !== undefined && effectiveModel === undefined) {
    return err(node.id, 'effort', 'effort is set without an effective model.')
  }

  const retries = node.onFailureRaw?.retries
  if (retries !== undefined && (!Number.isInteger(retries) || (retries as number) < 0 || (retries as number) > 10)) {
    return err(node.id, 'onFailure.retries', 'onFailure.retries must be an integer between 0 and 10.')
  }

  const maxMinutes = node.limitsRaw?.maxMinutes
  if (maxMinutes !== undefined && (!isFiniteNumber(maxMinutes) || maxMinutes <= 0)) {
    return err(node.id, 'limits.maxMinutes', 'limits.maxMinutes must be a finite number greater than 0.')
  }

  return null
}

/** T11 rule 7: value validation, defaults map first then each node in list order. */
export function validatePipelineTemplateValues(root: StructuralRoot): PipelineTemplateError | null {
  const defaultsError = validateDefaultsMap(root)
  if (defaultsError) {
    return defaultsError
  }
  for (const node of root.nodes) {
    const nodeError = validateNodeMap(node, root)
    if (nodeError) {
      return nodeError
    }
  }
  return null
}
