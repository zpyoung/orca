import type { JSX } from 'react'
import type { NodeTypes } from '@xyflow/react'
import { PipelineNodeCard, type PipelineNodeViewProps } from './PipelineNodeCard'

export function AgentNodeView(props: PipelineNodeViewProps): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="agent" />
}

export function CheckNodeView(props: PipelineNodeViewProps): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="check" />
}

export function ScriptNodeView(props: PipelineNodeViewProps): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="script" />
}

export function DecisionNodeView(props: PipelineNodeViewProps): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="decision" />
}

export function LoopNodeView(props: PipelineNodeViewProps): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="loop" />
}

export function SwarmNodeView(props: PipelineNodeViewProps): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="swarm" />
}

export function MergeNodeView(props: PipelineNodeViewProps): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="merge" />
}

export function GateNodeView(props: PipelineNodeViewProps): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="gate" />
}

export function LandNodeView(props: PipelineNodeViewProps): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="land" />
}

export function ObjectiveNodeView(props: PipelineNodeViewProps): JSX.Element {
  return <PipelineNodeCard {...props} nodeType="objective" />
}

export function PrSitterNodeView(props: PipelineNodeViewProps): JSX.Element {
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
