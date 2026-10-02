import type { JSX } from 'react'
import type { NodeProps, NodeTypes } from '@xyflow/react'
import { PipelineNodeCard, type PipelineCanvasNode } from './PipelineNodeCard'

export function AgentNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="agent" />
}

export function CheckNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="check" />
}

export function ScriptNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="script" />
}

export function DecisionNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="decision" />
}

export function LoopNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="loop" />
}

export function SwarmNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="swarm" />
}

export function MergeNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="merge" />
}

export function GateNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="gate" />
}

export function LandNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="land" />
}

export function ObjectiveNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="objective" />
}

export function PrSitterNodeView(props: NodeProps<PipelineCanvasNode>): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="pr-sitter" />
}

export const pipelineCanvasNodeTypes = {
  agent: AgentNodeView,
  check: CheckNodeView,
  script: ScriptNodeView,
  decision: DecisionNodeView,
  loop: LoopNodeView,
  swarm: SwarmNodeView,
  merge: MergeNodeView,
  gate: GateNodeView,
  land: LandNodeView,
  objective: ObjectiveNodeView,
  'pr-sitter': PrSitterNodeView
} satisfies NodeTypes
