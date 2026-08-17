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

/** Depth-first search over the `needs` edges, as an explicit stack so an arbitrarily long chain cannot overflow the call stack. */
function findDependencyCycle(root: StructuralRoot): PipelineTemplateError | null {
  const byId = new Map(root.nodes.map((node) => [node.id, node]))
  const state = new Map<string, VisitState>()

  for (const startNode of root.nodes) {
    if (state.has(startNode.id)) {
      continue
    }

    const stack: { node: StructuralNode; needsIndex: number }[] = [{ node: startNode, needsIndex: 0 }]
    state.set(startNode.id, 'visiting')

    while (stack.length > 0) {
      const frame = stack.at(-1)
      if (!frame) {
        break
      }
      const needs = frame.node.needs ?? []
      if (frame.needsIndex >= needs.length) {
        state.set(frame.node.id, 'done')
        stack.pop()
        continue
      }

      const dependencyId = needs[frame.needsIndex]
      frame.needsIndex += 1

      if (state.get(dependencyId) === 'visiting') {
        return {
          rule: 9,
          nodeId: frame.node.id,
          field: 'needs',
          message: `dependency cycle detected through "${dependencyId}".`
        }
      }
      if (state.get(dependencyId) !== 'done') {
        const dependency = byId.get(dependencyId)
        if (dependency) {
          state.set(dependency.id, 'visiting')
          stack.push({ node: dependency, needsIndex: 0 })
        }
      }
    }
  }
  return null
}

/** T11 rules 8-9: dependency-graph validation over nodes already known structurally valid. */
export function validatePipelineTemplateGraph(root: StructuralRoot): PipelineTemplateError | null {
  return validateNeedsReferences(root) ?? findDependencyCycle(root)
}
