import type { Node, NodeProps } from '@xyflow/react'
import { HeimdallTonePill } from '@/fork-heimdall/heimdall-tone-pill'
import { formatHeimdallDuration, formatHeimdallJson } from '@/fork-heimdall/fleet-format'
import { translate } from '@/i18n/i18n'
import type { PipelineNode } from '../../../shared/fork-heimdall-pipeline/document-schema'
import type {
  PipelineRunNodeView,
  PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import {
  pipelineCanvasNodeTypes,
  UnknownNodeView,
  type UnknownPipelineNodeData
} from './pipeline-node-views'

type PipelineRunGraphNodeData = {
  node: PipelineNode | null
  sourceNode: PipelineRunView['document']['nodes'][number] | null
  runNode: PipelineRunNodeView
}
export type PipelineRunGraphNode = Node<PipelineRunGraphNodeData>

const STATUS_GLYPHS: Record<PipelineRunNodeView['status'], string> = {
  pending: '○',
  running: '●',
  waiting: '…',
  done: '✓',
  failed: '!',
  skipped: '↷',
  unverifiable: '?',
  unknown: '?'
}
const COST_FORMAT = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' })

function statusLabel(status: PipelineRunNodeView['status']): string {
  const labels: Record<PipelineRunNodeView['status'], string> = {
    pending: translate('fork.heimdallPipeline.runGraph.status.pending', 'Pending'),
    running: translate('fork.heimdallPipeline.runGraph.status.running', 'Running'),
    waiting: translate('fork.heimdallPipeline.runGraph.status.waiting', 'Waiting'),
    done: translate('fork.heimdallPipeline.runGraph.status.done', 'Done'),
    failed: translate('fork.heimdallPipeline.runGraph.status.failed', 'Failed'),
    skipped: translate('fork.heimdallPipeline.runGraph.status.skipped', 'Skipped'),
    unverifiable: translate('fork.heimdallPipeline.runGraph.status.unverifiable', 'Unverifiable'),
    unknown: translate('fork.heimdallPipeline.runGraph.status.unknown', 'Unknown')
  }
  return labels[status]
}

function statusTone(
  status: PipelineRunNodeView['status']
): 'success' | 'warning' | 'neutral' | 'destructive' {
  if (status === 'done') {
    return 'success'
  }
  if (status === 'running' || status === 'waiting') {
    return 'warning'
  }
  if (status === 'failed') {
    return 'destructive'
  }
  return 'neutral'
}

function phaseName(phase: string): string {
  switch (phase) {
    case 'planning':
      return translate('fork.heimdallPipeline.runGraph.phases.planning', 'Planning')
    case 'plan-review':
      return translate('fork.heimdallPipeline.runGraph.phases.planReview', 'Plan review')
    case 'running-tasks':
      return translate('fork.heimdallPipeline.runGraph.phases.runningTasks', 'Running tasks')
    case 'checks':
      return translate('fork.heimdallPipeline.runGraph.phases.checks', 'Checks')
    case 'review':
      return translate('fork.heimdallPipeline.runGraph.phases.review', 'Review')
    case 'landing':
      return translate('fork.heimdallPipeline.runGraph.phases.landing', 'Landing')
    case 'landed':
      return translate('fork.heimdallPipeline.runGraph.phases.landed', 'Landed')
    case 'watching':
      return translate('fork.heimdallPipeline.runGraph.phases.watching', 'Watching')
    case 'fixing-checks':
      return translate('fork.heimdallPipeline.runGraph.phases.fixingChecks', 'Fixing checks')
    case 'updating-branch':
      return translate('fork.heimdallPipeline.runGraph.phases.updatingBranch', 'Updating branch')
    case 'resolving-conflicts':
      return translate(
        'fork.heimdallPipeline.runGraph.phases.resolvingConflicts',
        'Resolving conflicts'
      )
    case 'merging':
      return translate('fork.heimdallPipeline.runGraph.phases.merging', 'Merging')
    default: {
      const readable = phase.replace(/[-_]+/gu, ' ')
      return `${readable.charAt(0).toUpperCase()}${readable.slice(1)}`
    }
  }
}

function statusPill(runNode: PipelineRunNodeView): React.JSX.Element {
  const label = statusLabel(runNode.status)
  return (
    <HeimdallTonePill
      tone={statusTone(runNode.status)}
      data-testid={`pipeline-run-node-status-${runNode.instanceId}`}
    >
      <span aria-hidden="true">{STATUS_GLYPHS[runNode.status]}</span>
      {label}
    </HeimdallTonePill>
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
    label: sourceNode?.label ?? data.runNode.label,
    state: statusLabel(data.runNode.status)
  }
  return (
    <div
      className="grid min-w-0 gap-2"
      data-testid={`pipeline-run-node-${data.runNode.instanceId}`}
      data-node-instance={data.runNode.instanceId}
    >
      {NodeView && dataNode ? (
        <NodeView {...props} data={{ node: dataNode }} />
      ) : (
        <UnknownNodeView {...props} data={unknownData} />
      )}
      <div className="grid gap-1.5 rounded-md border border-border bg-card p-2 text-xs text-card-foreground">
        <div className="flex flex-wrap items-center gap-2">
          {statusPill(data.runNode)}
          {data.runNode.round !== undefined ? (
            <span>
              {translate('fork.heimdallPipeline.runGraph.round', 'Round {{round}}', {
                round: data.runNode.round
              })}
            </span>
          ) : (
            <span>
              {translate('fork.heimdallPipeline.runGraph.attempt', 'Attempt {{attempt}}', {
                attempt: data.runNode.attempt
              })}
            </span>
          )}
        </div>
        <span className="text-muted-foreground">
          {translate('fork.heimdallPipeline.runGraph.elapsed', 'Elapsed {{duration}}', {
            duration: formatHeimdallDuration(data.runNode.elapsedMs ?? 0)
          })}
        </span>
        <span className="text-muted-foreground">
          {translate('fork.heimdallPipeline.runGraph.turns', '{{count}} turns', {
            count: data.runNode.turns
          })}
        </span>
        {data.runNode.phase ? (
          <span>
            {translate('fork.heimdallPipeline.runGraph.phase', 'Phase: {{phase}}', {
              phase: phaseName(data.runNode.phase)
            })}
          </span>
        ) : null}
        {data.runNode.revision !== undefined ? (
          <span>
            {translate('fork.heimdallPipeline.runGraph.revision', 'Revision {{revision}}', {
              revision: data.runNode.revision
            })}
          </span>
        ) : null}
        {data.runNode.progress ? (
          <span>
            {translate(
              'fork.heimdallPipeline.runGraph.progress',
              '{{done}} of {{total}} tasks done',
              data.runNode.progress
            )}
          </span>
        ) : null}
        {data.runNode.usage ? (
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
            <span>{translate('fork.heimdallPipeline.runGraph.usageEstimate', 'Estimate')}</span>
            {data.runNode.usage.totalTokens !== undefined ? (
              <span>
                {translate('fork.heimdallPipeline.runGraph.tokens', '{{count}} tokens', {
                  count: data.runNode.usage.totalTokens
                })}
              </span>
            ) : null}
            {data.runNode.usage.estimatedCostUsd !== undefined ? (
              <span>
                {translate('fork.heimdallPipeline.runGraph.cost', '{{amount}} estimated', {
                  amount: COST_FORMAT.format(data.runNode.usage.estimatedCostUsd)
                })}
              </span>
            ) : null}
          </div>
        ) : null}
        {data.runNode.checks?.length ? (
          <section
            className="space-y-1"
            aria-label={translate('fork.heimdallPipeline.runGraph.checks', 'Checks')}
          >
            <h4 className="font-medium">
              {translate('fork.heimdallPipeline.runGraph.checks', 'Checks')}
            </h4>
            <ul className="space-y-1 text-muted-foreground">
              {data.runNode.checks.map((check) => (
                <li key={check.name} className="flex flex-wrap justify-between gap-x-2">
                  <span>{check.name}</span>
                  <span>{check.result === null ? '—' : formatHeimdallJson(check.result)}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {data.runNode.warnings?.length ? (
          <section
            className="space-y-1"
            aria-label={translate('fork.heimdallPipeline.runGraph.warnings', 'Warnings')}
          >
            <h4 className="font-medium">
              {translate('fork.heimdallPipeline.runGraph.warnings', 'Warnings')}
            </h4>
            <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
              {data.runNode.warnings.map((warning, index) => (
                <li key={`${index}:${warning}`}>{warning}</li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  )
}
