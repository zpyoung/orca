import { decodePipelineNodeStatus } from '../../../../shared/pipeline-run-snapshot'
import { translate } from '@/i18n/i18n'
import {
  computePipelineCanvasLayout,
  deriveSequentialPipelineLayoutNodes
} from './pipeline-canvas-layout'
import { pipelineNodeVisual } from './pipeline-canvas-node-visuals'

export type PipelineCanvasSceneNode = {
  id: string
  title?: string
  status?: string
  attempt?: number
  attemptsAllowed?: number
  limitBreached?: boolean
  limitMinutes?: number
  /** Elapsed time for the current attempt, pre-formatted by the caller. */
  elapsedLabel?: string
}

export type PipelineCanvasSceneProps = {
  nodes: readonly PipelineCanvasSceneNode[]
  /** A pause was requested and the currently running node hasn't ended its attempt yet. */
  pausing: boolean
}

const COLUMN_WIDTH = 220
const ROW_HEIGHT = 96
const NODE_WIDTH = 168
const NODE_HEIGHT = 64
const PADDING = 32

function nodeCenter(column: number, row: number): { x: number; y: number; left: number; top: number } {
  const left = PADDING + column * COLUMN_WIDTH
  const top = PADDING + row * ROW_HEIGHT
  return { left, top, x: left + NODE_WIDTH / 2, y: top + NODE_HEIGHT / 2 }
}

/**
 * Renders pipeline nodes and their dependency edges as SVG. One visual per
 * node status, including the `unknown` decode fallback, plus the attempt
 * counter, advisory-limit badge, and pausing annotation.
 */
export default function PipelineCanvasScene({
  nodes,
  pausing
}: PipelineCanvasSceneProps): React.JSX.Element {
  const layoutNodes = deriveSequentialPipelineLayoutNodes(nodes.map((n) => n.id))
  const positions = computePipelineCanvasLayout(layoutNodes)
  const positionById = new Map(positions.map((p) => [p.id, p]))
  const layoutById = new Map(layoutNodes.map((n) => [n.id, n]))

  const maxColumn = positions.reduce((max, p) => Math.max(max, p.column), 0)
  const maxRow = positions.reduce((max, p) => Math.max(max, p.row), 0)
  const width = PADDING * 2 + (maxColumn + 1) * COLUMN_WIDTH
  const height = PADDING * 2 + (maxRow + 1) * ROW_HEIGHT

  return (
    <svg
      role="img"
      aria-label={translate('auto.components.pipeline.canvas.PipelineCanvasScene.scene', 'Pipeline nodes')}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className="overflow-visible"
    >
      <g data-pipeline-edges>
        {nodes.map((node) => {
          const position = positionById.get(node.id)
          const layout = layoutById.get(node.id)
          if (!position || !layout) {
            return null
          }
          return layout.needs.map((depId) => {
            const depPosition = positionById.get(depId)
            if (!depPosition) {
              return null
            }
            const from = nodeCenter(depPosition.column, depPosition.row)
            const to = nodeCenter(position.column, position.row)
            const midX = (from.x + NODE_WIDTH / 2 + (to.x - NODE_WIDTH / 2)) / 2
            const path = `M ${from.x + NODE_WIDTH / 2} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x - NODE_WIDTH / 2} ${to.y}`
            return (
              <path
                key={`${depId}->${node.id}`}
                data-pipeline-edge
                d={path}
                fill="none"
                className="stroke-border"
                strokeWidth={1.5}
              />
            )
          })
        })}
      </g>
      {nodes.map((node) => {
        const position = positionById.get(node.id)
        if (!position) {
          return null
        }
        const { left, top } = nodeCenter(position.column, position.row)
        const status = decodePipelineNodeStatus(node.status)
        const visual = pipelineNodeVisual(status)
        const Icon = visual.icon
        const showAttempt =
          node.attempt !== undefined && node.attemptsAllowed !== undefined && node.attemptsAllowed > 1
        const showPausingAnnotation = pausing && status === 'running'
        return (
          <g key={node.id} data-node-id={node.id} data-status={status}>
            <rect
              x={left}
              y={top}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx={10}
              className={visual.toneClassName}
              strokeWidth={1.5}
            />
            <foreignObject x={left} y={top} width={NODE_WIDTH} height={NODE_HEIGHT}>
              <div className="flex h-full flex-col justify-center gap-0.5 overflow-hidden px-3 text-foreground">
                <div className="flex items-center gap-1.5">
                  <Icon className={`size-3.5 shrink-0 ${visual.spin ? 'animate-spin' : ''}`} />
                  <span className="truncate text-xs font-medium">{node.title ?? node.id}</span>
                </div>
                <span className="text-[11px] text-muted-foreground">{visual.label}</span>
                {status === 'running' && node.elapsedLabel && (
                  <span className="text-[10px] text-muted-foreground">{node.elapsedLabel}</span>
                )}
                {showAttempt && (
                  <span className="text-[10px] text-muted-foreground">
                    {translate(
                      'auto.components.pipeline.canvas.PipelineCanvasScene.attempt',
                      'attempt {{value0}} of {{value1}}',
                      { value0: node.attempt, value1: node.attemptsAllowed }
                    )}
                  </span>
                )}
                {showPausingAnnotation && (
                  <span className="text-[10px] text-muted-foreground italic">
                    {translate('auto.components.pipeline.canvas.PipelineCanvasScene.pausing', 'pausing')}
                  </span>
                )}
              </div>
            </foreignObject>
            {node.limitBreached && (
              <foreignObject x={left} y={top - 18} width={NODE_WIDTH} height={16}>
                <span className="inline-flex items-center rounded-full border border-destructive/30 bg-destructive/10 px-1.5 text-[10px] text-destructive">
                  {translate(
                    'auto.components.pipeline.canvas.PipelineCanvasScene.overlimit',
                    'over its {{value0}} min limit',
                    { value0: node.limitMinutes }
                  )}
                </span>
              </foreignObject>
            )}
          </g>
        )
      })}
    </svg>
  )
}
