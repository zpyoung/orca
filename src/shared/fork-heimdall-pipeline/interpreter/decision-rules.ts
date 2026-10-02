import type { PipelineDocument, PipelineNode } from '../document-schema'
import type { PipelineNodeRunState } from './index'
import { pipelineDecisionBranchValue } from './verdict-output'

export type PipelineOutputValues = Readonly<Record<string, Readonly<Record<string, unknown>>>>
type PipelineDecisionValue = { output: unknown; branch: string }
type PipelineDecisionValues = ReadonlyMap<string, PipelineDecisionValue>

export function pipelineOutputReference(
  reference: string
): { nodeId: string; name: string } | null {
  const match = /^\$([a-z][a-z0-9-]{0,62})\.outputs\.([a-zA-Z][a-zA-Z0-9_]{0,62})$/u.exec(reference)
  const nodeId = match?.[1]
  const name = match?.[2]
  return nodeId === undefined || name === undefined ? null : { nodeId, name }
}

function decisionValue(
  node: PipelineNode,
  outputs: PipelineOutputValues
): PipelineDecisionValue | undefined {
  if (node.type !== 'decision') {
    return undefined
  }
  const reference = pipelineOutputReference(node.on)
  if (reference === null) {
    return undefined
  }
  const output = outputs[reference.nodeId]?.[reference.name]
  const branch = pipelineDecisionBranchValue(output)
  return branch === null ? undefined : { output, branch }
}

export function topologicalPipelineNodes(document: PipelineDocument): PipelineNode[] {
  const remaining = new Map(document.nodes.map((node) => [node.id, node]))
  const settled = new Set<string>()
  const ordered: PipelineNode[] = []
  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((node) =>
        (node.after ?? []).every((edge) => settled.has(typeof edge === 'string' ? edge : edge.node))
      )
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    const next = ready[0]
    if (next === undefined) {
      ordered.push(
        ...[...remaining.values()].sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0
        )
      )
      return ordered
    }
    remaining.delete(next.id)
    settled.add(next.id)
    ordered.push(next)
  }
  return ordered
}

/** Propagates edge satisfaction and Decision-node branch skips to a fixed point. */
export function resolvePipelineReadiness(
  document: PipelineDocument,
  states: Map<string, PipelineNodeRunState>,
  outputs: PipelineOutputValues
): Map<string, PipelineNodeRunState> {
  const nodes = topologicalPipelineNodes(document)
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const decisionValues: PipelineDecisionValues = new Map(
    nodes.flatMap((node) => {
      const value = decisionValue(node, outputs)
      return value === undefined ? [] : [[node.id, value] as const]
    })
  )

  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      const state = states.get(node.id)
      if (state === undefined || (state.status !== 'pending' && state.status !== 'ready')) {
        continue
      }
      const edges = node.after ?? []
      if (edges.length === 0) {
        if (node.type === 'decision') {
          const value = decisionValues.get(node.id)
          if (value !== undefined) {
            states.set(node.id, { ...state, status: 'done', outputs: { value: value.output } })
            changed = true
          }
        } else if (state.status !== 'ready') {
          states.set(node.id, { ...state, status: 'ready' })
          changed = true
        }
        continue
      }
      let allResolved = true
      let anySatisfied = false
      for (const edge of edges) {
        const sourceId = typeof edge === 'string' ? edge : edge.node
        const sourceState = states.get(sourceId)
        if (
          sourceState === undefined ||
          (sourceState.status !== 'done' && sourceState.status !== 'skipped')
        ) {
          allResolved = false
          break
        }
        if (sourceState.status === 'skipped') {
          continue
        }
        if (typeof edge !== 'string') {
          const source = byId.get(sourceId)
          const value = decisionValues.get(sourceId)
          if (source?.type === 'decision' && value?.branch !== edge.when) {
            continue
          }
        }
        anySatisfied = true
      }
      if (!allResolved) {
        continue
      }
      const nextStatus: PipelineNodeRunState['status'] = anySatisfied ? 'ready' : 'skipped'
      if (state.status !== nextStatus) {
        states.set(node.id, { ...state, status: nextStatus })
        changed = true
      }
      if (node.type === 'decision' && nextStatus === 'ready') {
        const value = decisionValues.get(node.id)
        if (value !== undefined) {
          states.set(node.id, { ...state, status: 'done', outputs: { value: value.output } })
          changed = true
        }
      }
    }
  }
  return states
}
