import {
  PipelineLayoutSchema,
  type PipelineLayout
} from '../../../shared/fork-heimdall-pipeline/layout-schema'
import type {
  PipelineDocument,
  PipelineNode
} from '../../../shared/fork-heimdall-pipeline/document-schema'

type Point = { x: number; y: number }

function predecessorsByNode(nodes: readonly PipelineNode[]): Map<string, string[]> {
  const ids = new Set(nodes.map((node) => node.id))
  return new Map<string, string[]>(
    nodes.map((node): [string, string[]] => [
      node.id,
      [
        ...new Set(
          (node.after ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.node))
        )
      ].filter((id) => ids.has(id))
    ])
  )
}

function calculatedLayers(
  nodes: readonly PipelineNode[],
  predecessors: ReadonlyMap<string, readonly string[]>
): Map<string, number> {
  const layers = new Map<string, number>()
  const visiting = new Set<string>()
  const layerFor = (id: string): number => {
    const cached = layers.get(id)
    if (cached !== undefined) {
      return cached
    }
    if (visiting.has(id)) {
      return 0
    }
    visiting.add(id)
    let layer = 0
    for (const predecessor of predecessors.get(id) ?? []) {
      layer = Math.max(layer, layerFor(predecessor) + 1)
    }
    visiting.delete(id)
    layers.set(id, layer)
    return layer
  }
  for (const node of nodes) {
    layerFor(node.id)
  }
  return layers
}

/** Place unpositioned nodes in deterministic dependency layers while retaining valid saved points. */
export function layeredLayout(document: PipelineDocument, stored?: PipelineLayout): PipelineLayout {
  const parsed = stored === undefined ? null : PipelineLayoutSchema.safeParse(stored)
  const storedLayout = parsed?.success ? parsed.data : null
  const predecessors = predecessorsByNode(document.nodes)
  const layers = calculatedLayers(document.nodes, predecessors)
  const inputOrder = new Map<string, number>(
    document.nodes.map((node, index): [string, number] => [node.id, index])
  )
  const maximumLayer = Math.max(0, ...layers.values())
  const orderByNode = new Map<string, number>()
  const nodesByLayer = new Map<number, string[]>()
  for (const node of document.nodes) {
    const layer = layers.get(node.id) ?? 0
    const nodeIds = nodesByLayer.get(layer) ?? []
    nodeIds.push(node.id)
    nodesByLayer.set(layer, nodeIds)
  }
  for (const nodeIds of nodesByLayer.values()) {
    nodeIds.forEach((id, index) => orderByNode.set(id, index))
  }

  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (let layer = 1; layer <= maximumLayer; layer += 1) {
      const nodeIds = nodesByLayer.get(layer)
      if (!nodeIds) {
        continue
      }
      nodeIds.sort((leftId, rightId) => {
        const meanPredecessorOrder = (id: string): number | null => {
          const parentOrders = (predecessors.get(id) ?? [])
            .map((parentId) => orderByNode.get(parentId))
            .filter((order): order is number => order !== undefined)
          return parentOrders.length === 0
            ? null
            : parentOrders.reduce((total, order) => total + order, 0) / parentOrders.length
        }
        const leftMean = meanPredecessorOrder(leftId)
        const rightMean = meanPredecessorOrder(rightId)
        if (leftMean === null || rightMean === null || leftMean === rightMean) {
          return (inputOrder.get(leftId) ?? 0) - (inputOrder.get(rightId) ?? 0)
        }
        return leftMean - rightMean
      })
      nodeIds.forEach((id, index) => orderByNode.set(id, index))
    }
  }

  const positions: Record<string, Point> = {}
  for (const node of document.nodes) {
    const calculated = {
      x: (layers.get(node.id) ?? 0) * 280,
      y: (orderByNode.get(node.id) ?? 0) * 120
    }
    const point = storedLayout?.nodes[node.id]
    positions[node.id] =
      point && Number.isFinite(point.x) && Number.isFinite(point.y)
        ? { x: point.x, y: point.y }
        : calculated
  }
  const viewport = storedLayout?.viewport
  return {
    version: 1,
    nodes: positions,
    ...(viewport &&
    Number.isFinite(viewport.x) &&
    Number.isFinite(viewport.y) &&
    Number.isFinite(viewport.zoom) &&
    viewport.zoom > 0
      ? { viewport }
      : {})
  }
}
