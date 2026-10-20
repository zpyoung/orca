import { Children, type JSX, type ReactNode } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeType } from '../../../../shared/fork-heimdall-pipeline/document-schema'
import type { PipelineNodeVisualState } from '../pipeline-run-visual-state'
import { PipelineNodeStatusGlyph } from './PipelineNodeStatusGlyph'
import { PIPELINE_NODE_TYPE_ICONS } from './pipeline-node-type-icons'
import { usePipelineFarZoom } from './use-pipeline-far-zoom'
import './pipeline-node-motion.css'

type PipelineNodeCardFrameProps = {
  typeLabel: string
  nodeType: NodeType | 'unknown'
  label: string
  selected?: boolean
  invalid?: boolean
  visualState?: PipelineNodeVisualState
  children?: ReactNode
}

/**
 * The one compact card every pipeline node renders in, in Edit and Run mode. Far zoom hides all but
 * the glyph, type icon and label through CSS, so the DOM text is the same at every zoom level.
 */
export function PipelineNodeCardFrame({
  typeLabel,
  nodeType,
  label,
  selected,
  invalid,
  visualState,
  children
}: PipelineNodeCardFrameProps): JSX.Element {
  const far = usePipelineFarZoom()
  const hasChildren = Children.toArray(children).length > 0
  const TypeIcon = PIPELINE_NODE_TYPE_ICONS[nodeType]
  return (
    <div
      className="pipeline-node-frame group/pipeline-node relative flex min-h-20 w-56 flex-col gap-1 rounded-xl border border-border bg-card px-3 py-2.5 text-card-foreground data-[invalid=true]:ring-2 data-[invalid=true]:ring-destructive data-[lod=far]:flex-row data-[lod=far]:items-center data-[lod=far]:gap-2 data-[selected=true]:outline-2 data-[selected=true]:outline-offset-2 data-[selected=true]:outline-ring"
      data-node-type={nodeType}
      data-selected={selected === true}
      data-invalid={invalid === true}
      data-visual-state={visualState}
      data-lod={far ? 'far' : 'near'}
    >
      <Handle type="target" position={Position.Top} id="pipeline-input" />
      <div className="flex min-w-0 shrink-0 items-center gap-1.5 text-[11px] font-semibold text-muted-foreground">
        {visualState ? (
          <span className="hidden group-data-[lod=far]/pipeline-node:inline-flex">
            <PipelineNodeStatusGlyph state={visualState} />
          </span>
        ) : null}
        <TypeIcon aria-hidden="true" className="size-3.5 shrink-0" />
        <span className="truncate group-data-[lod=far]/pipeline-node:hidden">{typeLabel}</span>
      </div>
      <div
        className="min-w-0 truncate text-[13px] font-semibold group-data-[lod=far]/pipeline-node:text-lg"
        title={label}
      >
        {label}
      </div>
      {hasChildren ? (
        <div className="grid gap-1.5 group-data-[lod=far]/pipeline-node:hidden">{children}</div>
      ) : null}
      <Handle type="source" position={Position.Bottom} id="pipeline-output" />
    </div>
  )
}
