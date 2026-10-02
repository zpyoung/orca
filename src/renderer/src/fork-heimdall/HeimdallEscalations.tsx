import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { getLatestApproval } from '../../../shared/fork-heimdall/ledger-queries'
import type { WatcherCommandResult } from '../../../shared/fork-heimdall/fleet-types'
import type {
  ApprovalScope,
  EscalationEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherTickTrace } from '../../../shared/fork-heimdall/tick-trace'
import { parsePipelineNodeEvidenceKey } from '../../../shared/fork-heimdall-pipeline/choice-types'
import type { PipelineChoice } from '../../../shared/fork-heimdall-pipeline/choice-types'
import type {
  PipelineRunNodeView,
  PipelineRunView
} from '../../../shared/fork-heimdall-pipeline/run-view-types'
import type { WatcherFleetEntryReader } from '../../../shared/fork-heimdall/remote-reader-schemas'
import {
  PipelineGateDialog,
  pipelineChoiceLabel,
  pipelineChoicesForNode,
  type PipelineChoiceCommand
} from '../fork-heimdall-pipeline/PipelineGateDialog'
import { loadPipelineRunView } from '../fork-heimdall-pipeline/pipeline-run-view-client'
import { approvalActionPresentation, latestApprovalAction } from './approval-action-presentation'

function isPipelineChoiceScope(scope: ApprovalScope): boolean {
  return scope.actionKind === 'pipeline-pass-gate' || scope.actionKind === 'pipeline-apply-choice'
}

function nodeForScope(view: PipelineRunView, scope: ApprovalScope): PipelineRunNodeView | null {
  const identity = parsePipelineNodeEvidenceKey(scope.evidenceKey)
  if (!identity) {
    return null
  }
  return (
    view.nodes.find(
      (node) =>
        node.instanceId === identity.instanceId &&
        node.epoch === identity.epoch &&
        node.attempt === identity.attempt
    ) ?? null
  )
}

export type HeimdallEscalationsProps = {
  entries: readonly EscalationEntry[]
  traces: readonly WatcherTickTrace[]
  readOnly: boolean
  busyKey: string | null
  row: WatcherFleetEntryReader
  ledger: WatcherLedger | null
  onApprove: (key: string, scope: ApprovalScope) => void
  onAnswerChoice: (command: PipelineChoiceCommand) => Promise<WatcherCommandResult | null>
}

type EscalationChoice = { scope: ApprovalScope; choice: PipelineChoice }

export function HeimdallEscalations({
  entries,
  traces,
  readOnly,
  busyKey,
  row,
  ledger,
  onApprove,
  onAnswerChoice
}: HeimdallEscalationsProps): React.JSX.Element | null {
  const unsupportedWatcher = row.entry.enrollment.kind === 'unknown'
  const hasPipelineChoices =
    !unsupportedWatcher &&
    entries.some(
      (entry) => entry.approvalScope !== undefined && isPipelineChoiceScope(entry.approvalScope)
    )
  const targetKey = [
    row.target.connectionId ?? 'local',
    row.target.pairingRevision ?? 'local',
    row.target.watcherId,
    row.ownerFence.revision,
    row.observedAtMs
  ].join(':')
  const [loadedView, setLoadedView] = useState<{ key: string; view: PipelineRunView } | null>(null)
  const [activeChoice, setActiveChoice] = useState<EscalationChoice | null>(null)
  const generation = useRef(0)
  const view = loadedView?.key === targetKey ? loadedView.view : null

  const refreshView = useCallback(async (): Promise<void> => {
    if (!hasPipelineChoices) {
      return
    }
    const requestGeneration = ++generation.current
    const nextView = await loadPipelineRunView(row)
    if (generation.current === requestGeneration) {
      setLoadedView({ key: targetKey, view: nextView })
    }
  }, [hasPipelineChoices, row, targetKey])

  useEffect(() => {
    if (!hasPipelineChoices) {
      return
    }
    void refreshView()
    return () => {
      generation.current += 1
    }
  }, [hasPipelineChoices, refreshView])

  const unsupportedView = unsupportedWatcher || view?.kind === 'unknown'
  const controlsReadOnly = readOnly || unsupportedView
  const activeNode = activeChoice && view ? nodeForScope(view, activeChoice.scope) : null
  const presentedEntries = useMemo(
    () =>
      entries.map((escalation) => {
        const approvalScope = escalation.approvalScope
        const presentation = approvalScope
          ? approvalActionPresentation(approvalScope, latestApprovalAction(traces, approvalScope))
          : null
        const pipelineNode =
          approvalScope && view && isPipelineChoiceScope(approvalScope)
            ? nodeForScope(view, approvalScope)
            : null
        const hasApprovedChoice =
          approvalScope !== undefined &&
          ledger !== null &&
          getLatestApproval(ledger, approvalScope)?.decision === 'approved'
        const choices =
          view && pipelineNode && approvalScope && !unsupportedView && !hasApprovedChoice
            ? pipelineChoicesForNode(view, pipelineNode, approvalScope)
            : []
        return { escalation, approvalScope, presentation, pipelineNode, choices }
      }),
    [entries, ledger, traces, unsupportedView, view]
  )

  if (entries.length === 0) {
    return null
  }
  return (
    <>
      <section aria-labelledby="heimdall-escalations-title">
        <h3
          id="heimdall-escalations-title"
          className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
        >
          {translate('fork.heimdall.escalations.title', 'Open escalations')}
        </h3>
        <ul className="space-y-2">
          {presentedEntries.map(
            ({ escalation, approvalScope, presentation, pipelineNode, choices }) => {
              const approvalKey = `approve:${escalation.escalationId}`
              const isPipelineChoice =
                approvalScope !== undefined && isPipelineChoiceScope(approvalScope)
              const reason =
                escalation.reason && escalation.reason !== escalation.escalationKind
                  ? escalation.reason
                  : null
              return (
                <li
                  key={escalation.escalationId}
                  data-testid={`heimdall-escalation-${escalation.escalationId}`}
                  className="rounded-md border border-status-warning-border bg-status-warning-background p-3 text-xs text-status-warning-foreground"
                >
                  <div className="flex flex-wrap items-center gap-2 font-medium">
                    <span>{presentation?.title ?? escalation.escalationKind}</span>
                    {escalation.foldCount > 1 ? (
                      <Badge variant="outline">×{escalation.foldCount}</Badge>
                    ) : null}
                  </div>
                  {presentation ? <p className="mt-1">{presentation.explanation}</p> : null}
                  {presentation?.details.length ? (
                    <dl className="mt-2 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1 text-[11px]">
                      {presentation.details.map((detail) => (
                        <div key={detail.label} className="contents">
                          <dt className="text-status-warning-foreground/70">{detail.label}</dt>
                          <dd
                            className={
                              detail.mono
                                ? 'whitespace-pre-wrap break-all font-mono text-status-warning-foreground'
                                : 'break-words text-status-warning-foreground'
                            }
                          >
                            {detail.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : null}
                  {reason ? <p className="mt-1">{reason}</p> : null}
                  {approvalScope && presentation ? (
                    <>
                      {approvalScope.preparedCommitSha ? (
                        <p className="mt-2 text-[11px]">
                          <span className="text-status-warning-foreground/70">
                            {translate('fork.heimdall.approval.preparedCommit', 'Prepared commit')}
                          </span>{' '}
                          <code className="break-all font-mono text-status-warning-foreground">
                            {approvalScope.preparedCommitSha}
                          </code>
                        </p>
                      ) : null}
                      <details className="mt-2 text-[11px]">
                        <summary className="cursor-pointer text-status-warning-foreground/70">
                          {translate('fork.heimdall.approval.scopeDetails', 'Approval scope')}
                        </summary>
                        <dl className="mt-1 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-2 gap-y-1">
                          <dt className="text-status-warning-foreground/70">
                            {translate('fork.heimdall.approval.contentState', 'Content state')}
                          </dt>
                          <dd className="break-all font-mono">{approvalScope.contentIdentity}</dd>
                          <dt className="text-status-warning-foreground/70">
                            {translate('fork.heimdall.approval.evidence', 'Evidence')}
                          </dt>
                          <dd className="break-all font-mono">{approvalScope.evidenceKey}</dd>
                        </dl>
                      </details>
                      <p className="mt-2 text-[11px]">
                        {translate(
                          'fork.heimdall.approval.exactScopeNotice',
                          'Approval applies only to this exact action and content. New or changed actions require separate approval.'
                        )}
                      </p>
                      {isPipelineChoice ? (
                        <div className="mt-2 flex flex-wrap gap-2">
                          {choices.map((choice) => (
                            <Button
                              key={choice}
                              type="button"
                              size="xs"
                              variant={choice === 'abort' ? 'destructive' : 'outline'}
                              data-testid={`heimdall-escalation-choice-${choice}`}
                              disabled={
                                controlsReadOnly || busyKey !== null || !pipelineNode || !view
                              }
                              onClick={() => setActiveChoice({ scope: approvalScope, choice })}
                            >
                              {pipelineChoiceLabel(choice)}
                            </Button>
                          ))}
                          {!unsupportedWatcher && hasPipelineChoices && !view ? (
                            <span className="text-xs text-muted-foreground" role="status">
                              {translate(
                                'fork.heimdallPipeline.gateDialog.loading',
                                'Loading pipeline choices…'
                              )}
                            </span>
                          ) : !unsupportedView && view && choices.length === 0 ? (
                            <span className="text-xs text-muted-foreground" role="status">
                              {translate(
                                'fork.heimdallPipeline.gateDialog.unavailable',
                                'Choice controls are unavailable for this host or node.'
                              )}
                            </span>
                          ) : null}
                        </div>
                      ) : !unsupportedView ? (
                        <Button
                          type="button"
                          size="xs"
                          className="mt-2"
                          disabled={readOnly || busyKey !== null}
                          onClick={() => onApprove(approvalKey, approvalScope)}
                        >
                          {busyKey === approvalKey ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <ShieldCheck />
                          )}
                          {translate(
                            'fork.heimdall.controls.approveAction',
                            'Approve: {{action}}',
                            {
                              action: presentation.title
                            }
                          )}
                        </Button>
                      ) : null}
                    </>
                  ) : null}
                </li>
              )
            }
          )}
        </ul>
      </section>
      {activeChoice && activeNode && view ? (
        <PipelineGateDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setActiveChoice(null)
            }
          }}
          view={view}
          node={activeNode}
          scope={activeChoice.scope}
          row={row}
          readOnly={controlsReadOnly || busyKey !== null}
          busy={busyKey !== null}
          surface="heimdall-detail"
          initialChoice={activeChoice.choice}
          onAnswer={onAnswerChoice}
          onAnswered={refreshView}
        />
      ) : null}
    </>
  )
}
