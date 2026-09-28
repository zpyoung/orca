import { useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { ObjectiveDetail } from '../../../shared/fork-heimdall-objective/detail-types'
import { formatHeimdallTime } from '../fork-heimdall/fleet-format'
import { shortObjectiveIdentity } from './objective-detail-format'
import {
  objectiveCriterionReviewLabel,
  objectiveNodeStateLabel,
  objectiveReviewRoleLabel,
  objectiveTrainStateLabel,
  objectiveRevisionStatusLabel,
  objectiveVerdictLabel
} from './objective-copy'
import { ObjectivePlanQuality } from './ObjectivePlanQuality'

function Criterion({
  criterion
}: {
  criterion: ObjectiveDetail['nodes'][number]['criteria'][number]
}): React.JSX.Element {
  const check = criterion.lastCheck
  return (
    <li className="rounded-md border border-border/70 bg-background px-2.5 py-2">
      <p className="text-xs text-foreground">{criterion.body}</p>
      <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">{criterion.id}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {criterion.shellCheckable
            ? translate('fork.heimdallObjective.detail.shellCheck', 'Shell check')
            : translate('fork.heimdallObjective.detail.reviewCriterion', 'Review criterion')}
        </span>
        {check ? (
          <>
            <Badge variant="outline">
              {check.timedOut
                ? translate('fork.heimdallObjective.detail.timedOut', 'Timed out')
                : translate('fork.heimdallObjective.detail.exitCode', 'Exit {{code}}', {
                    code: check.exitCode ?? '—'
                  })}
            </Badge>
            <time dateTime={new Date(check.atMs).toISOString()}>
              {formatHeimdallTime(check.atMs)}
            </time>
            <span className="font-mono" title={check.contentIdentity}>
              {shortObjectiveIdentity(check.contentIdentity)}
            </span>
          </>
        ) : null}
        {criterion.lastReview ? (
          <Badge variant="outline">
            {translate('fork.heimdallObjective.detail.reviewResult', 'Review: {{result}}', {
              result: objectiveCriterionReviewLabel(criterion.lastReview)
            })}
          </Badge>
        ) : null}
        {!check && !criterion.lastReview ? (
          <span>{translate('fork.heimdallObjective.detail.notChecked', 'Not checked yet')}</span>
        ) : null}
      </div>
    </li>
  )
}

function RevisionPlan({
  detail,
  revisionId
}: {
  detail: ObjectiveDetail
  revisionId: string
}): React.JSX.Element {
  const nodes = detail.nodes.filter((node) => node.revisionId === revisionId)
  const dispatchByTaskKey = new Map<
    string,
    NonNullable<ObjectiveDetail['parallel']>['dispatches'][number]
  >()
  for (const dispatch of detail.parallel?.dispatches ?? []) {
    if (dispatch.revisionId !== revisionId) {
      continue
    }
    const previous = dispatchByTaskKey.get(dispatch.taskKey)
    if (!previous || previous.createdAtMs <= dispatch.createdAtMs) {
      dispatchByTaskKey.set(dispatch.taskKey, dispatch)
    }
  }
  if (nodes.length === 0) {
    return (
      <p className="rounded-md border border-border bg-muted/10 px-3 py-5 text-center text-xs text-muted-foreground">
        {translate('fork.heimdallObjective.detail.noNodes', 'No plan nodes in this revision.')}
      </p>
    )
  }
  return (
    <ol className="space-y-2">
      {nodes.map((node) => {
        const dispatch = dispatchByTaskKey.get(node.taskKey)
        const laneTaskKeys = dispatch?.laneTaskKeys ?? node.laneTaskKeys ?? [node.taskKey]
        return (
          <li key={node.taskKey} className="rounded-md border border-border bg-muted/10 p-3">
            <div className="flex flex-wrap items-start gap-2">
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-foreground">{node.title}</p>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{node.taskKey}</p>
              </div>
              <Badge variant="outline">{objectiveNodeStateLabel(node.state)}</Badge>
              {dispatch ? (
                <Badge variant="secondary">
                  {translate('fork.heimdallObjective.detail.trainState', 'Train: {{state}}', {
                    state: objectiveTrainStateLabel(dispatch.state)
                  })}
                </Badge>
              ) : null}
            </div>
            {laneTaskKeys.length > 1 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {translate('fork.heimdallObjective.detail.lane', 'Lane')}:{' '}
                <span className="font-mono">{laneTaskKeys.join(' → ')}</span>
              </p>
            ) : null}
            {node.territory && node.territory.length > 0 ? (
              <p className="mt-2 text-[11px] text-muted-foreground">
                {translate('fork.heimdallObjective.detail.territory', 'Write territory')}:{' '}
                <span className="font-mono">{node.territory.join(', ')}</span>
              </p>
            ) : null}
            {node.overrunPaths && node.overrunPaths.length > 0 ? (
              <p className="mt-1 text-[11px] text-status-warning-foreground">
                {translate(
                  'fork.heimdallObjective.detail.overrunPaths',
                  'Outside territory: {{paths}}',
                  { paths: node.overrunPaths.join(', ') }
                )}
              </p>
            ) : null}
            {node.state === 'awaiting-approval' ? (
              <a
                href="#heimdall-escalations-title"
                className="mt-2 inline-block text-xs font-medium text-foreground underline underline-offset-2"
              >
                {translate(
                  'fork.heimdallObjective.detail.reviewApproval',
                  'Review approval request'
                )}
              </a>
            ) : null}
            {node.orchestrationTaskId || node.dispatchId ? (
              <p className="mt-2 break-all font-mono text-[10px] text-muted-foreground">
                {node.orchestrationTaskId
                  ? translate('fork.heimdallObjective.detail.taskId', 'Task {{id}}', {
                      id: node.orchestrationTaskId
                    })
                  : ''}
                {node.orchestrationTaskId && node.dispatchId ? ' · ' : ''}
                {node.dispatchId
                  ? translate('fork.heimdallObjective.detail.dispatchId', 'Dispatch {{id}}', {
                      id: node.dispatchId
                    })
                  : ''}
              </p>
            ) : null}
            {node.criteria.length > 0 ? (
              <ul className="mt-3 space-y-2">
                {node.criteria.map((criterion) => (
                  <Criterion key={criterion.id} criterion={criterion} />
                ))}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ol>
  )
}

export function ObjectivePlan({ detail }: { detail: ObjectiveDetail }): React.JSX.Element {
  const revisions = [...detail.revisions].sort((left, right) => right.number - left.number)
  const initialRevision = revisions[0]
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const [selectedRevisionId, setSelectedRevisionId] = useState(initialRevision?.id)
  const selectedRevision =
    revisions.find((revision) => revision.id === selectedRevisionId) ?? initialRevision
  // approved means implementation is underway, so the default tracks the latest revision's status until the user toggles
  const open = userOpen ?? initialRevision?.status !== 'approved'

  return (
    <section aria-labelledby="objective-plan-title">
      <Collapsible open={open} onOpenChange={setUserOpen}>
        <h3
          id="objective-plan-title"
          className={cn(
            'mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground',
            // the trigger's own padding would push the label off the section's left edge
            selectedRevision && '-mx-1.5'
          )}
        >
          {selectedRevision ? (
            <CollapsibleTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="xs"
                className="group w-full justify-between"
              >
                <span className="text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground group-hover:text-foreground">
                  {translate('fork.heimdallObjective.detail.plan', 'Plan')}
                </span>
                <ChevronRight
                  aria-hidden
                  className="size-3.5 transition-transform motion-reduce:transition-none group-data-[state=open]:rotate-90"
                />
              </Button>
            </CollapsibleTrigger>
          ) : (
            translate('fork.heimdallObjective.detail.plan', 'Plan')
          )}
        </h3>
        {selectedRevision ? (
          <div className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">
              {translate('fork.heimdallObjective.detail.revision', 'Revision {{number}}', {
                number: selectedRevision.number
              })}
            </span>
            <Badge variant="outline">{objectiveRevisionStatusLabel(selectedRevision.status)}</Badge>
            <span>
              {translate(
                'fork.heimdallObjective.detail.revisionMeta',
                '{{nodes}} nodes · created {{time}} · digest {{digest}}',
                {
                  nodes: selectedRevision.nodeCount,
                  time: formatHeimdallTime(selectedRevision.createdAtMs),
                  digest: shortObjectiveIdentity(selectedRevision.digest)
                }
              )}
            </span>
            {selectedRevision.approvedAtMs !== null ? (
              <span>
                {translate('fork.heimdallObjective.detail.revisionApproved', 'Approved {{time}}', {
                  time: formatHeimdallTime(selectedRevision.approvedAtMs)
                })}
              </span>
            ) : null}
          </div>
        ) : null}
        <CollapsibleContent asChild>
          <div className="collapsible-height-content">
            {selectedRevision ? (
              <Tabs value={selectedRevision.id} onValueChange={setSelectedRevisionId}>
                <div className="max-w-full overflow-x-auto scrollbar-sleek">
                  <TabsList className="justify-start" variant="line">
                    {revisions.map((revision) => (
                      <TabsTrigger key={revision.id} value={revision.id}>
                        {translate(
                          'fork.heimdallObjective.detail.revision',
                          'Revision {{number}}',
                          {
                            number: revision.number
                          }
                        )}
                        <Badge variant="outline">
                          {objectiveRevisionStatusLabel(revision.status)}
                        </Badge>
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </div>
                {revisions.map((revision) => (
                  <TabsContent key={revision.id} value={revision.id}>
                    <RevisionPlan detail={detail} revisionId={revision.id} />
                  </TabsContent>
                ))}
              </Tabs>
            ) : (
              <p className="rounded-md border border-border bg-muted/10 px-3 py-5 text-center text-xs text-muted-foreground">
                {translate('fork.heimdallObjective.detail.noPlan', 'No plan revision yet.')}
              </p>
            )}
            <ObjectivePlanQuality detail={detail} />
            {detail.verdicts.length > 0 ? (
              <div className="mt-3 space-y-1.5">
                <h4 className="text-[11px] font-semibold text-muted-foreground">
                  {translate('fork.heimdallObjective.detail.verdicts', 'Review verdicts')}
                </h4>
                {detail.verdicts.map((verdict) => (
                  <div
                    key={`${verdict.dispatchId}:${verdict.role}`}
                    className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground"
                  >
                    <Badge variant="outline">{objectiveReviewRoleLabel(verdict.role)}</Badge>
                    <span>{objectiveVerdictLabel(verdict.verdict)}</span>
                    {verdict.synthesizedByOwner ? (
                      <Badge variant="secondary">
                        {translate(
                          'fork.heimdallObjective.detail.verdictSynthesizedByOwner',
                          'Synthesized by owner'
                        )}
                      </Badge>
                    ) : null}
                    <time dateTime={new Date(verdict.atMs).toISOString()}>
                      {formatHeimdallTime(verdict.atMs)}
                    </time>
                    <span className="font-mono" title={verdict.contentIdentity}>
                      {shortObjectiveIdentity(verdict.contentIdentity)}
                    </span>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  )
}
