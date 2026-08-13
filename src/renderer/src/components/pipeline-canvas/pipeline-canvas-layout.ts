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
 * The pipeline snapshot wire carries no dependency edges — only the
 * template's list order, already applied host-side. Until the wire grows a
 * real edges field, treat that order as a straight chain so the only shipped
 * template (a chain) still lays out and draws edges correctly.
 */
export function deriveSequentialPipelineLayoutNodes(
  nodeIds: readonly string[]
): PipelineLayoutNode[] {
  return nodeIds.map((id, index) => ({
    id,
    needs: index === 0 ? [] : [nodeIds[index - 1]!]
  }))
}
