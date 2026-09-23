import { Badge } from '@/components/ui/badge'
import { translate } from '@/i18n/i18n'
import type { ObjectiveDetail } from '../../../shared/fork-heimdall-objective/detail-types'
import type { PlanLintFinding } from '../../../shared/fork-heimdall-objective/plan-lint'
import { formatHeimdallTime } from '../fork-heimdall/fleet-format'
import {
  objectiveAssumptionStatusLabel,
  objectiveGateResultLabel,
  objectivePatchStatusLabel,
  objectivePlanLintCodeLabel,
  objectivePlanReviewVerdictLabel
} from './objective-detail-format'

const PLAN_LEVEL_FINDING_GROUP = ''

function groupFindingsByTask(findings: readonly PlanLintFinding[]): [string, PlanLintFinding[]][] {
  const byTask = new Map<string, PlanLintFinding[]>()
  for (const finding of findings) {
    const key = finding.taskKey ?? PLAN_LEVEL_FINDING_GROUP
    byTask.set(key, [...(byTask.get(key) ?? []), finding])
  }
  return [...byTask.entries()]
}

function LintFindings({
  planLint
}: {
  planLint: NonNullable<ObjectiveDetail['planLint']>
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
        <span>
          {translate(
            'fork.heimdallObjective.detail.criticalPathLength',
            'Critical path: {{length}}',
            { length: planLint.criticalPathLength }
          )}
        </span>
        <span>
          {translate('fork.heimdallObjective.detail.maxWidth', 'Max width: {{width}}', {
            width: planLint.maxWidth
          })}
        </span>
        {planLint.conflictPairs.length > 0 ? (
          <span>
            {translate('fork.heimdallObjective.detail.conflictPairs', 'Conflicts: {{pairs}}', {
              pairs: planLint.conflictPairs.map(([a, b]) => `${a} ↔ ${b}`).join(', ')
            })}
          </span>
        ) : null}
      </div>
      {planLint.findings.length === 0 ? null : (
        <ul className="space-y-1.5">
          {groupFindingsByTask(planLint.findings).map(([taskKey, findings]) => (
            <li
              key={taskKey || PLAN_LEVEL_FINDING_GROUP}
              className="rounded-md border border-status-warning-border bg-status-warning-background px-2.5 py-2"
            >
              <p className="font-mono text-[11px] text-status-warning-foreground">
                {taskKey ||
                  translate('fork.heimdallObjective.detail.planLevelFinding', 'Plan-level')}
              </p>
              <ul className="mt-1 space-y-1">
                {findings.map((finding, index) => (
                  <li
                    key={`${finding.code}-${index}`}
                    className="flex flex-wrap items-start gap-2 text-xs text-status-warning-foreground"
                  >
                    <Badge variant="outline">{objectivePlanLintCodeLabel(finding.code)}</Badge>
                    <span className="min-w-0 flex-1">{finding.detail}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Assumptions({
  assumptions
}: {
  assumptions: NonNullable<ObjectiveDetail['assumptions']>
}): React.JSX.Element | null {
  if (assumptions.length === 0) {
    return null
  }
  return (
    <ul className="space-y-1.5">
      {assumptions.map((assumption, index) => (
        <li
          key={index}
          className="rounded-md border border-border bg-muted/10 px-2.5 py-2 text-xs text-foreground"
        >
          <div className="flex flex-wrap items-start gap-2">
            <span className="min-w-0 flex-1">{assumption.claim}</span>
            {assumption.status ? (
              <Badge variant={assumption.status === 'verified' ? 'secondary' : 'outline'}>
                {objectiveAssumptionStatusLabel(assumption.status)}
              </Badge>
            ) : null}
          </div>
          {assumption.evidence ? (
            <p className="mt-1 text-[11px] text-muted-foreground">{assumption.evidence}</p>
          ) : null}
        </li>
      ))}
    </ul>
  )
}

function PlanReviews({
  planReviews
}: {
  planReviews: NonNullable<ObjectiveDetail['planReviews']>
}): React.JSX.Element | null {
  if (planReviews.length === 0) {
    return null
  }
  return (
    <ol className="divide-y divide-border rounded-md border border-border bg-muted/10">
      {planReviews.map((review) => (
        <li
          key={`${review.targetKind}:${review.targetId}:${review.round}`}
          className="flex flex-wrap items-center gap-2 px-2.5 py-2 text-xs text-foreground"
        >
          <Badge variant="outline">{objectivePlanReviewVerdictLabel(review.verdict)}</Badge>
          <span className="text-[11px] text-muted-foreground">
            {translate('fork.heimdallObjective.detail.planReviewRound', 'Round {{round}}', {
              round: review.round
            })}
          </span>
          <span className="min-w-0 flex-1">{review.summary}</span>
          <time
            className="text-[11px] text-muted-foreground"
            dateTime={new Date(review.createdAtMs).toISOString()}
          >
            {formatHeimdallTime(review.createdAtMs)}
          </time>
        </li>
      ))}
    </ol>
  )
}

function PendingPatch({
  pendingPatch
}: {
  pendingPatch: NonNullable<ObjectiveDetail['pendingPatch']>
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-muted/10 px-2.5 py-2 text-xs text-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={pendingPatch.status === 'rejected' ? 'destructive' : 'outline'}>
          {objectivePatchStatusLabel(pendingPatch.status)}
        </Badge>
        <span className="font-mono text-[11px] text-muted-foreground">
          {pendingPatch.touchedTaskKeys.join(', ')}
        </span>
      </div>
      {pendingPatch.rejection ? (
        <p className="mt-1 text-[11px] text-status-warning-foreground">{pendingPatch.rejection}</p>
      ) : null}
    </div>
  )
}

function Gates({
  gates,
  noGateDeclared
}: {
  gates: ObjectiveDetail['gates']
  noGateDeclared: ObjectiveDetail['noGateDeclared']
}): React.JSX.Element | null {
  if (noGateDeclared) {
    return (
      <p className="rounded-md border border-border bg-muted/10 px-2.5 py-2 text-xs text-muted-foreground">
        {translate('fork.heimdallObjective.detail.noGateDeclared', 'No objective gate declared.')}
      </p>
    )
  }
  if (!gates || gates.length === 0) {
    return null
  }
  return (
    <ul className="space-y-1.5">
      {gates.map((gate) => (
        <li
          key={gate.name}
          className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/10 px-2.5 py-2 text-xs text-foreground"
        >
          <span className="font-mono">{gate.name}</span>
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {gate.command}
          </span>
          <Badge
            variant={
              gate.lastResult ? (gate.lastResult.pass ? 'secondary' : 'destructive') : 'outline'
            }
          >
            {objectiveGateResultLabel(gate.lastResult)}
          </Badge>
        </li>
      ))}
    </ul>
  )
}

export function ObjectivePlanQuality({
  detail
}: {
  detail: ObjectiveDetail
}): React.JSX.Element | null {
  const hasContent =
    detail.planLint !== undefined ||
    (detail.assumptions?.length ?? 0) > 0 ||
    (detail.planReviews?.length ?? 0) > 0 ||
    detail.pendingPatch !== undefined ||
    (detail.gates?.length ?? 0) > 0 ||
    detail.noGateDeclared === true
  if (!hasContent) {
    return null
  }
  return (
    <section aria-labelledby="objective-plan-quality-title" className="mt-3 space-y-3">
      <h4
        id="objective-plan-quality-title"
        className="text-[11px] font-semibold text-muted-foreground"
      >
        {translate('fork.heimdallObjective.detail.planQuality', 'Plan quality')}
      </h4>
      {detail.planLint ? <LintFindings planLint={detail.planLint} /> : null}
      {detail.assumptions ? <Assumptions assumptions={detail.assumptions} /> : null}
      {detail.planReviews ? <PlanReviews planReviews={detail.planReviews} /> : null}
      {detail.pendingPatch ? <PendingPatch pendingPatch={detail.pendingPatch} /> : null}
      <Gates gates={detail.gates} noGateDeclared={detail.noGateDeclared} />
    </section>
  )
}
