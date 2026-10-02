import type { JSX } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { translate } from '@/i18n/i18n'
import type {
  NodeType,
  PipelineNode
} from '../../../../shared/fork-heimdall-pipeline/document-schema'

export type PipelineCanvasNodeData = { node: PipelineNode; validationMessages?: readonly string[] }
export type PipelineCanvasNode = Node<PipelineCanvasNodeData>

type PipelineNodeCardProps = NodeProps<PipelineCanvasNode> & { nodeType: NodeType }

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
export function PipelineNodeCard({ data, selected, nodeType }: PipelineNodeCardProps): JSX.Element {
  const node = data.node
  const typeLabel = getPipelineNodeTypeLabel(nodeType)
  const swarmSummary =
    node.type === 'swarm'
      ? translate('fork.heimdallPipeline.node.swarmCount', 'n = {{value0}} (known at run time)', {
          value0: node.from
        })
      : null
  const nodeLabel = node.label?.trim() || node.id
  return (
    <div className="pipeline-node-card" data-selected={selected} data-node-type={nodeType}>
      <Handle type="target" position={Position.Top} id="pipeline-input" />
      <div className="pipeline-node-card__type">{typeLabel}</div>
      <div className="pipeline-node-card__label" title={nodeLabel}>
        {nodeLabel}
      </div>
      {swarmSummary ? <div className="pipeline-node-card__summary">{swarmSummary}</div> : null}
      {node.type === 'swarm' ? (
        <div className="pipeline-node-card__swarm-placeholder" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
      ) : null}
      <Handle type="source" position={Position.Bottom} id="pipeline-output" />
    </div>
  )
}
