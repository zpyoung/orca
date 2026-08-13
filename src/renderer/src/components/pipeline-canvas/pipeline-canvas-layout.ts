export type PipelineLayoutNode = { id: string; needs: readonly string[] }
export type PipelineNodePosition = { id: string; column: number; row: number }

/**
 * Layered-DAG layout, keyed only by node topology: column = longest-path depth
 * from a root, row = position among same-column siblings in input list order.
 * Pure and deterministic — nothing here is persisted.
 */
export function computePipelineCanvasLayout(
  nodes: readonly PipelineLayoutNode[]
): PipelineNodePosition[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depthById = new Map<string, number>()
  // visiting-set breaks a cycle by treating a back-edge as depth 0 rather than recursing forever —
  // template validation already forbids cycles, so this only guards against upstream drift.
  const visiting = new Set<string>()

  const depthOf = (id: string): number => {
    const cached = depthById.get(id)
    if (cached !== undefined) {
      return cached
    }
    const node = byId.get(id)
    if (!node || node.needs.length === 0 || visiting.has(id)) {
      depthById.set(id, 0)
      return 0
    }
    visiting.add(id)
    let maxDepDepth = -1
    for (const depId of node.needs) {
      maxDepDepth = Math.max(maxDepDepth, byId.has(depId) ? depthOf(depId) : -1)
    }
    visiting.delete(id)
    const depth = maxDepDepth + 1
    depthById.set(id, depth)
    return depth
  }

  const rowCounterByColumn = new Map<number, number>()
  return nodes.map((node) => {
    const column = depthOf(node.id)
    const row = rowCounterByColumn.get(column) ?? 0
    rowCounterByColumn.set(column, row + 1)
    return { id: node.id, column, row }
  })
}

/**
 * Chains each node to the one before it in list order — the layout used when
 * real dependency edges aren't available.
 */
export function deriveSequentialPipelineLayoutNodes(
  nodeIds: readonly string[]
): PipelineLayoutNode[] {
  return nodeIds.map((id, index) => ({
    id,
    needs: index === 0 ? [] : [nodeIds[index - 1]!]
  }))
}

export type PipelineLayoutSourceNode = { id: string; needs?: readonly string[] }

/**
 * Layout nodes from the wire: real `needs` edges when every node carries
 * them, else a list-order chain — the degrade path for an older host that
 * doesn't send `needs` at all (optional-field wire evolution).
 */
export function derivePipelineLayoutNodes(
  nodes: readonly PipelineLayoutSourceNode[]
): PipelineLayoutNode[] {
  const hasRealDependencyData = nodes.length > 0 && nodes.every((node) => Array.isArray(node.needs))
  if (hasRealDependencyData) {
    return nodes.map((node) => ({ id: node.id, needs: node.needs ?? [] }))
  }
  return deriveSequentialPipelineLayoutNodes(nodes.map((node) => node.id))
}
