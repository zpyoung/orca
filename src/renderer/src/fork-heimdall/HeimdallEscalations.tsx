import { Loader2, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ApprovalScope, EscalationEntry } from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherTickTrace } from '../../../shared/fork-heimdall/tick-trace'
import { approvalActionPresentation, latestApprovalAction } from './approval-action-presentation'

export type HeimdallEscalationsProps = {
  entries: readonly EscalationEntry[]
  traces: readonly WatcherTickTrace[]
  readOnly: boolean
  busyKey: string | null
  onApprove: (key: string, scope: ApprovalScope) => void
}

export function HeimdallEscalations({
  entries,
  traces,
  readOnly,
  busyKey,
  onApprove
}: HeimdallEscalationsProps): React.JSX.Element | null {
  if (entries.length === 0) {
    return null
  }
  return (
    <section aria-labelledby="heimdall-escalations-title">
      <h3
        id="heimdall-escalations-title"
        className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
      >
        {translate('fork.heimdall.escalations.title', 'Open escalations')}
      </h3>
      <ul className="space-y-2">
        {entries.map((escalation) => {
          const approvalScope = escalation.approvalScope
          const approvalKey = `approve:${escalation.escalationId}`
          const presentation = approvalScope
            ? approvalActionPresentation(approvalScope, latestApprovalAction(traces, approvalScope))
            : null
          const reason =
            escalation.reason && escalation.reason !== escalation.escalationKind
              ? escalation.reason
              : null
          return (
            <li
              key={escalation.escalationId}
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
                    {translate('fork.heimdall.controls.approveAction', 'Approve: {{action}}', {
                      action: presentation.title
                    })}
                  </Button>
                </>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}
