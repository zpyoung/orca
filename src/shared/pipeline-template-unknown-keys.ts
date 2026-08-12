import { isPlainMap } from './pipeline-template-raw-map'
import type { StructuralRoot } from './pipeline-template-structural-rules'

const TOP_LEVEL_KEYS = new Set(['version', 'name', 'description', 'defaults', 'nodes'])
const CONFIG_KEYS = new Set(['harness', 'model', 'effort', 'limits', 'onFailure'])
const NODE_KEYS = new Set(['id', 'title', 'prompt', 'needs', ...CONFIG_KEYS])
const LIMITS_KEYS = new Set(['maxMinutes'])
const ON_FAILURE_KEYS = new Set(['retries'])

function hasUnrecognizedKey(map: Record<string, unknown>, recognized: Set<string>): boolean {
  return Object.keys(map).some((key) => !recognized.has(key))
}

function mapHasUnrecognizedKey(value: unknown, recognized: Set<string>): boolean {
  return isPlainMap(value) && hasUnrecognizedKey(value, recognized)
}

/**
 * T12: walks the parsed object tree for keys this version of Orca does not recognize.
 * Called only once T11's shape rules have accepted the tree; never affects resolution.
 */
export function pipelineTemplateHasUnrecognizedKeys(root: StructuralRoot): boolean {
  if (hasUnrecognizedKey(root.raw, TOP_LEVEL_KEYS)) {
    return true
  }
  if (root.defaultsRaw) {
    if (hasUnrecognizedKey(root.defaultsRaw, CONFIG_KEYS)) {
      return true
    }
    if (mapHasUnrecognizedKey(root.defaultsRaw.limits, LIMITS_KEYS)) {
      return true
    }
    if (mapHasUnrecognizedKey(root.defaultsRaw.onFailure, ON_FAILURE_KEYS)) {
      return true
    }
  }
  for (const node of root.nodes) {
    if (hasUnrecognizedKey(node.raw, NODE_KEYS)) {
      return true
    }
    if (mapHasUnrecognizedKey(node.raw.limits, LIMITS_KEYS)) {
      return true
    }
    if (mapHasUnrecognizedKey(node.raw.onFailure, ON_FAILURE_KEYS)) {
      return true
    }
  }
  return false
}
