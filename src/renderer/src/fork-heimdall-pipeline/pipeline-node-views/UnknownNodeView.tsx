import type { JSX, ReactNode } from 'react'
import type { Node, NodeProps } from '@xyflow/react'
import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { PipelineNodeVisualState } from '../pipeline-run-visual-state'
import { PipelineNodeCardFrame } from './PipelineNodeCardFrame'

export type UnknownPipelineNodeData = {
  id: string
  type: string
  label?: string
  state?: string
}

type UnknownNodeViewProps = NodeProps<Node<UnknownPipelineNodeData>> & {
  visualState?: PipelineNodeVisualState
  children?: ReactNode
}

export function UnknownNodeView({
  data,
  selected,
  visualState,
  children
}: UnknownNodeViewProps): JSX.Element {
  return (
    <PipelineNodeCardFrame
      typeLabel={translate(
        'fork.heimdallPipeline.node.unknownType',
        'Unknown node type: {{value0}}',
        {
          value0: data.type
        }
      )}
      nodeType="unknown"
      label={data.label?.trim() || data.id}
      selected={selected}
      visualState={visualState}
    >
      {children}
      {data.state ? <Badge variant="outline">{data.state}</Badge> : null}
    </PipelineNodeCardFrame>
  )
}
