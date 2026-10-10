import type { JSX, ReactNode } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { translate } from '@/i18n/i18n'
import type {
  NodeType,
  PipelineNode
} from '../../../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineNodeVisualState } from '../pipeline-run-visual-state'
import { PipelineNodeCardFrame } from './PipelineNodeCardFrame'

export type PipelineCanvasNodeData = { node: PipelineNode; validationMessages?: readonly string[] }
export type PipelineCanvasNode = Node<PipelineCanvasNodeData>

/** Run mode supplies the visual state and the card face; Edit mode leaves both unset. */
export type PipelineNodeViewProps = NodeProps<PipelineCanvasNode> & {
  visualState?: PipelineNodeVisualState
  children?: ReactNode
}

type PipelineNodeCardProps = PipelineNodeViewProps & { nodeType: NodeType }

export function getPipelineNodeTypeLabel(type: NodeType): string {
  switch (type) {
    case 'agent':
      return translate('fork.heimdallPipeline.node.agent', 'Agent')
    case 'check':
      return translate('fork.heimdallPipeline.node.check', 'Check')
    case 'script':
      return translate('fork.heimdallPipeline.node.script', 'Script')
    case 'decision':
      return translate('fork.heimdallPipeline.node.decision', 'Decision')
    case 'loop':
      return translate('fork.heimdallPipeline.node.loop', 'Loop')
    case 'swarm':
      return translate('fork.heimdallPipeline.node.swarm', 'Swarm')
    case 'merge':
      return translate('fork.heimdallPipeline.node.merge', 'Merge')
    case 'gate':
      return translate('fork.heimdallPipeline.node.gate', 'Human gate')
    case 'land':
      return translate('fork.heimdallPipeline.node.land', 'Land')
    case 'objective':
      return translate('fork.heimdallPipeline.node.objective', 'Objective')
    case 'pr-sitter':
      return translate('fork.heimdallPipeline.node.prSitter', 'PR sitter')
  }
}
export function PipelineNodeCard({
  data,
  selected,
  nodeType,
  visualState,
  children
}: PipelineNodeCardProps): JSX.Element {
  const node = data.node
  const swarmSummary =
    node.type === 'swarm'
      ? translate('fork.heimdallPipeline.node.swarmCount', 'n = {{value0}} (known at run time)', {
          value0: node.from
        })
      : null
  return (
    <PipelineNodeCardFrame
      typeLabel={getPipelineNodeTypeLabel(nodeType)}
      nodeType={nodeType}
      label={node.label?.trim() || node.id}
      selected={selected}
      invalid={(data.validationMessages?.length ?? 0) > 0}
      visualState={visualState}
    >
      {children}
      {swarmSummary ? (
        <div className="font-mono text-[11px] text-muted-foreground">{swarmSummary}</div>
      ) : null}
      {node.type === 'swarm' ? (
        <div className="flex gap-1" aria-hidden="true">
          <span className="h-1.5 w-7 rounded-sm border border-border bg-muted" />
          <span className="h-1.5 w-7 rounded-sm border border-border bg-muted" />
          <span className="h-1.5 w-7 rounded-sm border border-border bg-muted" />
        </div>
      ) : null}
    </PipelineNodeCardFrame>
  )
}
