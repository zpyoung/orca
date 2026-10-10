import { useSyncExternalStore, type ComponentType, type JSX } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps
} from '@xyflow/react'
import type { PipelineDocument } from '../../../shared/fork-heimdall-pipeline/document-schema'
import type {
  PipelineRunNodeView,
  PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import {
  pipelineNodeVisualState,
  pipelineRunEdgeState,
  type PipelineRunEdgeState
} from './pipeline-run-visual-state'
import './pipeline-flow-edge.css'

export type PipelineFlowEdgeData = { condition?: string; runState?: PipelineRunEdgeState }

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia(REDUCED_MOTION_QUERY) : null
}

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = reducedMotionQuery()
  query?.addEventListener?.('change', onChange)
  return () => query?.removeEventListener?.('change', onChange)
}

function readReducedMotion(): boolean {
  // no media query support means no way to honor the preference, so stay still
  return reducedMotionQuery()?.matches ?? true
}

function PipelineFlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  data
}: EdgeProps<Edge<PipelineFlowEdgeData>>): JSX.Element {
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition
  })
  const reducedMotion = useSyncExternalStore(subscribeToReducedMotion, readReducedMotion)
  const condition = data?.condition
  const runState = data?.runState
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className="pipeline-flow-edge__path"
        data-run-state={runState}
        data-conditional={condition === undefined ? 'false' : 'true'}
      />
      {condition ? (
        <EdgeLabelRenderer>
          <div
            className="pipeline-flow-edge__label"
            data-run-state={runState}
            title={condition}
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {condition}
          </div>
        </EdgeLabelRenderer>
      ) : null}
      {runState === 'active' && !reducedMotion ? (
        <circle className="pipeline-flow-edge__spark" r={3}>
          <animateMotion dur="1.6s" repeatCount="indefinite" path={path} />
        </circle>
      ) : null}
    </>
  )
}

export const pipelineEdgeTypes: {
  pipeline: ComponentType<EdgeProps<Edge<PipelineFlowEdgeData>>>
} = { pipeline: PipelineFlowEdge }

/** Builds the editor's dependency edges from each node's `after` entries, conditional ones carrying their `when`. */
export function buildEditFlowEdges(document: PipelineDocument): Edge<PipelineFlowEdgeData>[] {
  const edges: Edge<PipelineFlowEdgeData>[] = []
  for (const target of document.nodes) {
    for (const [index, dependency] of (target.after ?? []).entries()) {
      const source = typeof dependency === 'string' ? dependency : dependency.node
      edges.push({
        id: `${source}:${target.id}:${index}`,
        source,
        target: target.id,
        sourceHandle: 'pipeline-output',
        targetHandle: 'pipeline-input',
        type: 'pipeline',
        data: typeof dependency === 'string' ? {} : { condition: dependency.when }
      })
    }
  }
  return edges
}

/**
 * Builds a run's edges between root node instances, each carrying the progress state derived from
 * its two endpoints. Edges with an unknown or non-visible endpoint are dropped.
 */
export function buildRunFlowEdges(
  view: PipelineRunView,
  visibleInstanceIds: ReadonlySet<string>
): Edge<PipelineFlowEdgeData>[] {
  const rootByNodeId = new Map<string, PipelineRunNodeView>()
  for (const node of view.nodes) {
    if (!node.parentInstanceId) {
      rootByNodeId.set(node.nodeId, node)
    }
  }
  return view.edges.flatMap((edge, index): Edge<PipelineFlowEdgeData>[] => {
    const source = rootByNodeId.get(edge.from)
    const target = rootByNodeId.get(edge.to)
    if (
      !source ||
      !target ||
      !visibleInstanceIds.has(source.instanceId) ||
      !visibleInstanceIds.has(target.instanceId)
    ) {
      return []
    }
    return [
      {
        id: `${edge.from}:${edge.to}:${index}`,
        source: source.instanceId,
        target: target.instanceId,
        sourceHandle: 'pipeline-output',
        targetHandle: 'pipeline-input',
        type: 'pipeline',
        data: {
          runState: pipelineRunEdgeState(
            pipelineNodeVisualState(source),
            pipelineNodeVisualState(target)
          ),
          ...(edge.when === undefined ? {} : { condition: edge.when })
        }
      }
    ]
  })
}
