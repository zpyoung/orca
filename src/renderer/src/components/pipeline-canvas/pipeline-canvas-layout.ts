export type PipelineLayoutNode = { id: string; needs: readonly string[] }
export type PipelineNodePosition = { id: string; column: number; row: number }

type DepthFrame = { node: PipelineLayoutNode; needsIndex: number; maxDepDepth: number }

/**
 * Explicit-stack post-order depth pass (same shape as
 * pipeline-run-db-instantiate.ts's topologicalNodeOrder) so an arbitrarily long `needs`
 * chain cannot overflow the renderer stack. A 'visiting' node hit again is a back-edge —
 * template validation already forbids cycles, so this only guards against upstream drift,
 * breaking the cycle by contributing no depth from that edge rather than recursing forever.
 */
function computeDepthById(
  nodes: readonly PipelineLayoutNode[],
  byId: ReadonlyMap<string, PipelineLayoutNode>
): Map<string, number> {
  const depthById = new Map<string, number>()
  const state = new Map<string, 'visiting' | 'done'>()

  for (const startNode of nodes) {
    if (state.has(startNode.id)) {
      continue
    }

    const stack: DepthFrame[] = [{ node: startNode, needsIndex: 0, maxDepDepth: -1 }]
    state.set(startNode.id, 'visiting')

    while (stack.length > 0) {
      const frame = stack.at(-1)!
      if (frame.needsIndex >= frame.node.needs.length) {
        const depth = frame.maxDepDepth + 1
        depthById.set(frame.node.id, depth)
        state.set(frame.node.id, 'done')
        stack.pop()
        // Why: propagate the finished child's depth into its caller's frame — the
        // bookkeeping a real call stack would otherwise do via the return value.
        const parent = stack.at(-1)
        if (parent) {
          parent.maxDepDepth = Math.max(parent.maxDepDepth, depth)
        }
        continue
      }

      const depId = frame.node.needs[frame.needsIndex]!
      frame.needsIndex += 1

      if (state.get(depId) === 'visiting') {
        continue
      }
      const cachedDepth = depthById.get(depId)
      if (cachedDepth !== undefined) {
        frame.maxDepDepth = Math.max(frame.maxDepDepth, cachedDepth)
        continue
      }
      const dependency = byId.get(depId)
      if (!dependency) {
        continue
      }
      state.set(dependency.id, 'visiting')
      stack.push({ node: dependency, needsIndex: 0, maxDepDepth: -1 })
    }
  }

  return depthById
}

/**
 * Layered-DAG layout, keyed only by node topology: column = longest-path depth
 * from a root, row = position among same-column siblings in input list order.
 * Pure and deterministic — nothing here is persisted.
 */
export function computePipelineCanvasLayout(
  nodes: readonly PipelineLayoutNode[]
): PipelineNodePosition[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depthById = computeDepthById(nodes, byId)

  const rowCounterByColumn = new Map<number, number>()
  return nodes.map((node) => {
    const column = depthById.get(node.id) ?? 0
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
