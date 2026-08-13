import type { PipelineDispatchDependency } from '../../../shared/pipeline-dispatch-prompt'
import type {
  ResolvedPipelineDefinition,
  ResolvedPipelineNode
} from '../../../shared/pipeline-template-types'
import type { OrchestrationDb } from '../orchestration/db'
import type { PipelineNodeRow } from '../orchestration/pipeline-run-db'

export type PipelineNodeIndex = {
  taskIdByNodeId: Map<string, string>
  rowByNodeId: Map<string, PipelineNodeRow>
}

export function buildPipelineNodeIndex(nodes: readonly PipelineNodeRow[]): PipelineNodeIndex {
  const taskIdByNodeId = new Map<string, string>()
  const rowByNodeId = new Map<string, PipelineNodeRow>()
  for (const row of nodes) {
    taskIdByNodeId.set(row.node_id, row.task_id)
    rowByNodeId.set(row.node_id, row)
  }
  return { taskIdByNodeId, rowByNodeId }
}

/** All nodes share one worktree, so only one may dispatch; ties break by `nodes` list order. */
export function pickNextReadyNode(
  definition: ResolvedPipelineDefinition,
  index: PipelineNodeIndex
): ResolvedPipelineNode | undefined {
  return definition.nodes.find((node) => {
    const row = index.rowByNodeId.get(node.id)
    if (!row || row.outcome !== null) {
      return false
    }
    return node.needs.every((depId) => index.rowByNodeId.get(depId)?.outcome === 'succeeded')
  })
}

export function allNodesSucceeded(index: PipelineNodeIndex): boolean {
  for (const row of index.rowByNodeId.values()) {
    if (row.outcome !== 'succeeded') {
      return false
    }
  }
  return true
}

/** The node's dependencies' recorded task results, in `needs` list order, for prompt assembly. */
export function buildDependencyResults(
  db: OrchestrationDb,
  node: ResolvedPipelineNode,
  index: PipelineNodeIndex
): PipelineDispatchDependency[] {
  return node.needs.map((depNodeId) => {
    const depTaskId = index.taskIdByNodeId.get(depNodeId)
    const result = depTaskId ? (db.getTask(depTaskId)?.result ?? null) : null
    return { nodeId: depNodeId, result }
  })
}
