import type { Node, NodeProps } from '@xyflow/react'
import { Progress } from '@/components/ui/progress'
import { HeimdallTonePill } from '@/fork-heimdall/heimdall-tone-pill'
import { formatHeimdallDuration } from '@/fork-heimdall/fleet-format'
import { translate } from '@/i18n/i18n'
import type { PipelineNode } from '../../../shared/fork-heimdall-pipeline/document-schema'
import type {
  PipelineRunNodeView,
  PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import {
  PipelineNodeStatusGlyph,
  pipelineCanvasNodeTypes,
  UnknownNodeView,
  type UnknownPipelineNodeData
} from './pipeline-node-views'
import { phaseName, statusLabel, statusTone } from './pipeline-run-node-format'
import { PipelineRunNodeDetail } from './PipelineRunNodeDetail'
import { pipelineNodeVisualState, type PipelineNodeVisualState } from './pipeline-run-visual-state'

type PipelineRunGraphNodeData = {
  node: PipelineNode | null
  sourceNode: PipelineRunView['document']['nodes'][number] | null
  runNode: PipelineRunNodeView
}
export type PipelineRunGraphNode = Node<PipelineRunGraphNodeData>

function progressPercent(progress: { done: number; total: number }): number {
  if (progress.total <= 0) {
    return 0
  }
  return Math.min(100, Math.max(0, Math.round((progress.done / progress.total) * 100)))
}

function RunCardFace({
  runNode,
  visualState
}: {
  runNode: PipelineRunNodeView
  visualState: PipelineNodeVisualState
}): React.JSX.Element {
  const progressText = runNode.progress
    ? translate('fork.heimdallPipeline.runGraph.progress', '{{done}} of {{total}} tasks done', {
        done: runNode.progress.done,
        total: runNode.progress.total
      })
    : null
  return (
    <>
      <HeimdallTonePill
        tone={statusTone(runNode.status)}
        data-testid={`pipeline-run-node-status-${runNode.instanceId}`}
      >
        <PipelineNodeStatusGlyph state={visualState} />
        {statusLabel(runNode.status)}
      </HeimdallTonePill>
      <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
        <span>
          {translate('fork.heimdallPipeline.runGraph.elapsed', 'Elapsed {{duration}}', {
            duration: formatHeimdallDuration(runNode.elapsedMs ?? 0)
          })}
        </span>
        <span aria-hidden="true">·</span>
        {runNode.round !== undefined ? (
          <span>
            {translate('fork.heimdallPipeline.runGraph.round', 'Round {{round}}', {
              round: runNode.round
            })}
          </span>
        ) : (
          <span>
            {translate('fork.heimdallPipeline.runGraph.attempt', 'Attempt {{attempt}}', {
              attempt: runNode.attempt
            })}
          </span>
        )}
        <span aria-hidden="true">·</span>
        <span>
          {translate('fork.heimdallPipeline.runGraph.turns', '{{count}} turns', {
            count: runNode.turns
          })}
        </span>
      </div>
      {runNode.phase || runNode.revision !== undefined ? (
        <div className="flex flex-wrap items-center gap-x-1.5 text-xs">
          {runNode.phase ? (
            <span>
              {translate('fork.heimdallPipeline.runGraph.phase', 'Phase: {{phase}}', {
                phase: phaseName(runNode.phase)
              })}
            </span>
          ) : null}
          {runNode.phase && runNode.revision !== undefined ? (
            <span aria-hidden="true">·</span>
          ) : null}
          {runNode.revision !== undefined ? (
            <span>
              {translate('fork.heimdallPipeline.runGraph.revision', 'Revision {{revision}}', {
                revision: runNode.revision
              })}
            </span>
          ) : null}
        </div>
      ) : null}
      {runNode.progress ? (
        <div className="grid gap-1 text-xs">
          <span>{progressText}</span>
          <Progress
            className="h-1.5"
            value={progressPercent(runNode.progress)}
            aria-label={progressText ?? undefined}
          />
        </div>
      ) : null}
    </>
  )
}

export function RunGraphNode(props: NodeProps<PipelineRunGraphNode>): React.JSX.Element {
  const { data } = props
  const dataNode = data.node
  const NodeView = dataNode ? pipelineCanvasNodeTypes[dataNode.type] : null
  const sourceNode = data.sourceNode
  const unknownData: UnknownPipelineNodeData = {
    id: sourceNode?.id ?? data.runNode.nodeId,
    type: sourceNode?.type ?? data.runNode.type,
    label: sourceNode?.label ?? data.runNode.label
  }
  const visualState = pipelineNodeVisualState(data.runNode)
  const face = <RunCardFace runNode={data.runNode} visualState={visualState} />
  const fullLabel = dataNode
    ? dataNode.label?.trim() || dataNode.id
    : unknownData.label?.trim() || unknownData.id
  return (
    <PipelineRunNodeDetail runNode={data.runNode} fullLabel={fullLabel}>
      {NodeView && dataNode ? (
        <NodeView {...props} data={{ node: dataNode }} visualState={visualState}>
          {face}
        </NodeView>
      ) : (
        <UnknownNodeView {...props} data={unknownData} visualState={visualState}>
          {face}
        </UnknownNodeView>
      )}
    </PipelineRunNodeDetail>
  )
}
