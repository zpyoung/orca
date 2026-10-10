import type { JSX, KeyboardEvent, ReactNode } from 'react'
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card'
import { formatHeimdallJson } from '@/fork-heimdall/fleet-format'
import { translate } from '@/i18n/i18n'
import type { PipelineRunNodeView } from '../../../shared/fork-heimdall-pipeline/run-view-types'
import { COST_FORMAT, statusLabel } from './pipeline-run-node-format'

type PipelineRunNodeDetailProps = {
  runNode: PipelineRunNodeView
  fullLabel: string
  children: ReactNode
}

function UsageEstimate({
  usage
}: {
  usage: NonNullable<PipelineRunNodeView['usage']>
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-2 text-muted-foreground">
      <span>{translate('fork.heimdallPipeline.runGraph.usageEstimate', 'Estimate')}</span>
      {usage.totalTokens !== undefined ? (
        <span>
          {translate('fork.heimdallPipeline.runGraph.tokens', '{{count}} tokens', {
            count: usage.totalTokens
          })}
        </span>
      ) : null}
      {usage.estimatedCostUsd !== undefined ? (
        <span>
          {translate('fork.heimdallPipeline.runGraph.cost', '{{amount}} estimated', {
            amount: COST_FORMAT.format(usage.estimatedCostUsd)
          })}
        </span>
      ) : null}
    </div>
  )
}

/**
 * Enter and Space on the focus stop replay as a click, so the graph's node click handler stays the
 * only place that decides what activating a run node does.
 */
function activateOnEnterOrSpace(event: KeyboardEvent<HTMLDivElement>): void {
  if (
    (event.key !== 'Enter' && event.key !== ' ') ||
    event.target !== event.currentTarget ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return
  }
  event.preventDefault()
  if (!event.repeat) {
    event.currentTarget.click()
  }
}

/**
 * Wraps a run card so the long detail the compact face leaves out opens on hover and on keyboard
 * focus, and so Enter or Space activates the node like a click. The wrapper is the focus stop
 * because run nodes are emitted with `focusable: false`.
 */
export function PipelineRunNodeDetail({
  runNode,
  fullLabel,
  children
}: PipelineRunNodeDetailProps): JSX.Element {
  const checksLabel = translate('fork.heimdallPipeline.runGraph.checks', 'Checks')
  const warningsLabel = translate('fork.heimdallPipeline.runGraph.warnings', 'Warnings')
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <div
          className="min-w-0 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          role="button"
          aria-label={`${fullLabel}, ${statusLabel(runNode.status)}`}
          tabIndex={0}
          onKeyDown={activateOnEnterOrSpace}
          data-testid={`pipeline-run-node-${runNode.instanceId}`}
          data-node-instance={runNode.instanceId}
        >
          {children}
        </div>
      </HoverCardTrigger>
      <HoverCardContent className="w-96">
        <div className="scrollbar-sleek grid max-h-96 gap-3 overflow-y-auto text-xs">
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">
              {translate('fork.heimdallPipeline.runGraph.detail.label', 'Label')}
            </dt>
            <dd className="font-medium break-words">{fullLabel}</dd>
            <dt className="text-muted-foreground">
              {translate('fork.heimdallPipeline.runGraph.detail.nodeId', 'Node ID')}
            </dt>
            <dd className="font-mono break-all">{runNode.nodeId}</dd>
            <dt className="text-muted-foreground">
              {translate('fork.heimdallPipeline.runGraph.detail.instanceId', 'Instance ID')}
            </dt>
            <dd className="font-mono break-all">{runNode.instanceId}</dd>
          </dl>
          {runNode.usage ? <UsageEstimate usage={runNode.usage} /> : null}
          {runNode.checks?.length ? (
            <section className="grid gap-1" aria-label={checksLabel}>
              <h4 className="font-medium">{checksLabel}</h4>
              <ul className="grid gap-1.5">
                {runNode.checks.map((check) => (
                  <li key={check.name} className="grid gap-0.5">
                    <span className="font-medium">{check.name}</span>
                    <pre className="font-mono text-[11px] break-words whitespace-pre-wrap text-muted-foreground">
                      {check.result === null ? '—' : formatHeimdallJson(check.result)}
                    </pre>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {runNode.warnings?.length ? (
            <section className="grid gap-1" aria-label={warningsLabel}>
              <h4 className="font-medium">{warningsLabel}</h4>
              <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                {runNode.warnings.map((warning, index) => (
                  <li key={`${index}:${warning}`}>{warning}</li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </HoverCardContent>
    </HoverCard>
  )
}
