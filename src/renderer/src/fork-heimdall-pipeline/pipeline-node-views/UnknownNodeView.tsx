import type { JSX } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { Badge } from '@/components/ui/badge'
import { Handle, Position } from '@xyflow/react'
import { translate } from '@/i18n/i18n'

export type UnknownPipelineNodeData = {
  id: string
  type: string
  label?: string
  state?: string
}

export function UnknownNodeView({
  data,
  selected
}: NodeProps<Node<UnknownPipelineNodeData>>): JSX.Element {
  const title = data.label?.trim() || data.id
  return (
    <div className="pipeline-node-card" data-selected={selected} data-node-type="unknown">
      <Handle type="target" position={Position.Top} id="pipeline-input" />
      <div className="pipeline-node-card__type">
        {translate('fork.heimdallPipeline.node.unknownType', 'Unknown node type: {{value0}}', {
          value0: data.type
        })}
      </div>
      <div className="pipeline-node-card__label" title={title}>
        {title}
      </div>
      {data.state ? <Badge variant="outline">{data.state}</Badge> : null}
      <Handle type="source" position={Position.Bottom} id="pipeline-output" />
    </div>
  )
}
