import type { JSX } from 'react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import {
  PIPELINE_NODE_TYPES,
  type NodeType
} from '../../../shared/fork-heimdall-pipeline/document-schema'
import { getPipelineNodeTypeLabel } from './pipeline-node-views/PipelineNodeCard'

export const PIPELINE_NODE_DRAG_TYPE = 'application/x-orca-heimdall-pipeline-node'

export function PipelinePalette({
  readOnly,
  onAddNode
}: {
  readOnly: boolean
  onAddNode: (type: NodeType) => void
}): JSX.Element {
  return (
    <aside
      className="scrollbar-sleek flex min-h-0 flex-col gap-3 overflow-auto border-r border-border bg-card p-3 text-card-foreground"
      aria-label={translate('fork.heimdallPipeline.palette.title', 'Node palette')}
    >
      <h2 className="text-[13px] font-semibold">
        {translate('fork.heimdallPipeline.palette.title', 'Nodes')}
      </h2>
      <div className="grid gap-1.5">
        {PIPELINE_NODE_TYPES.map((type) => (
          <Button
            key={type}
            type="button"
            variant="outline"
            size="sm"
            className="cursor-grab justify-start active:cursor-grabbing"
            disabled={readOnly}
            draggable={!readOnly}
            data-pipeline-node-type={type}
            onClick={() => onAddNode(type)}
            onDragStart={(event) => {
              event.dataTransfer.setData(PIPELINE_NODE_DRAG_TYPE, type)
              event.dataTransfer.effectAllowed = 'move'
            }}
          >
            {getPipelineNodeTypeLabel(type)}
          </Button>
        ))}
      </div>
    </aside>
  )
}
