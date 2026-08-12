import type { StructuralNode, StructuralRoot } from './pipeline-template-structural-rules'
import type { PipelineTemplateError } from './pipeline-template-types'

function validateNeedsReferences(root: StructuralRoot): PipelineTemplateError | null {
  const ids = new Set(root.nodes.map((node) => node.id))
  for (const node of root.nodes) {
    for (const need of node.needs ?? []) {
      if (!ids.has(need)) {
        return { rule: 8, nodeId: node.id, field: 'needs', message: `needs an unknown node id "${need}".` }
      }
      if (need === node.id) {
        return { rule: 8, nodeId: node.id, field: 'needs', message: 'a node cannot list itself in needs.' }
      }
    }
  }
  return null
}

type VisitState = 'visiting' | 'done'

function findDependencyCycle(root: StructuralRoot): PipelineTemplateError | null {
  const byId = new Map(root.nodes.map((node) => [node.id, node]))
  const state = new Map<string, VisitState>()

  function visit(node: StructuralNode): PipelineTemplateError | null {
    state.set(node.id, 'visiting')
    for (const dependencyId of node.needs ?? []) {
      if (state.get(dependencyId) === 'visiting') {
        return {
          rule: 9,
          nodeId: node.id,
          field: 'needs',
          message: `dependency cycle detected through "${dependencyId}".`
        }
      }
      if (state.get(dependencyId) !== 'done') {
        const dependency = byId.get(dependencyId)
        const cycle = dependency ? visit(dependency) : null
        if (cycle) {
          return cycle
        }
      }
    }
    state.set(node.id, 'done')
    return null
  }

  for (const node of root.nodes) {
    if (!state.has(node.id)) {
      const cycle = visit(node)
      if (cycle) {
        return cycle
      }
    }
  }
  return null
}

/** T11 rules 8-9: dependency-graph validation over nodes already known structurally valid. */
export function validatePipelineTemplateGraph(root: StructuralRoot): PipelineTemplateError | null {
  return validateNeedsReferences(root) ?? findDependencyCycle(root)
}
