import React from 'react'
import { ChevronDown, Clock3, Loader2, ShieldCheck, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  HostedReviewSitterLedger,
  HostedReviewSitterStatus
} from '../../../shared/fork-hosted-review-sitter/types'
import {
  formatHostedReviewSitterDuration,
  formatHostedReviewSitterTime,
  hostedReviewSitterActionLabel,
  hostedReviewSitterDiscrepancyLabel,
  hostedReviewSitterLedgerEntrySummary
} from './hosted-review-sitter-format'
import { hostedReviewSitterStatusReason } from './hosted-review-sitter-status-copy'

function HostedReviewSitterLedgerTimeline({
  ledger
}: {
  ledger: HostedReviewSitterLedger | null
}): React.JSX.Element {
  const entries = ledger ? [...ledger.entries].sort((a, b) => b.atMs - a.atMs).slice(0, 20) : []
  if (!ledger) {
    return (
      <div className="py-2 text-[11px] text-muted-foreground">
        {translate('fork.hostedReviewSitter.ledger.loading', 'Loading activity…')}
      </div>
    )
  }
  if (entries.length === 0) {
    return (
      <div className="py-2 text-[11px] text-muted-foreground">
        {translate('fork.hostedReviewSitter.ledger.empty', 'No activity yet.')}
      </div>
    )
  }
  return (
    <ol className="space-y-2 py-2">
      {entries.map((entry) => {
        const summary = hostedReviewSitterLedgerEntrySummary(entry)
        return (
          <li key={entry.eventId} className="grid grid-cols-[6px_minmax(0,1fr)] gap-2 text-[11px]">
            <span className="mt-1.5 size-1.5 rounded-full bg-muted-foreground/50" aria-hidden />
            <div className="min-w-0">
              <div className="flex min-w-0 items-baseline justify-between gap-2">
                <span className="min-w-0 truncate text-foreground" title={summary.title}>
                  {summary.title}
                </span>
                <time
                  className="shrink-0 text-[10px] text-muted-foreground"
                  dateTime={new Date(entry.atMs).toISOString()}
                >
                  {formatHostedReviewSitterTime(entry.atMs)}
                </time>
              </div>
              {summary.detail ? (
                <div className="mt-0.5 break-all text-[10px] leading-relaxed text-muted-foreground">
                  {summary.detail}
                </div>
              ) : null}
            </div>
          </li>
        )
      })}
    </ol>
  )
}

export type HostedReviewSitterStatusContentProps = {
  status: HostedReviewSitterStatus
  ledger: HostedReviewSitterLedger | null
  ledgerOpen: boolean
  busy: boolean
  stopping: boolean
  approving: boolean
  canApprove: boolean
  active: boolean
  onLedgerOpenChange: (open: boolean) => void
  onStop: () => void
  onApprove: () => void
}

export function HostedReviewSitterStatusContent({
  status,
  ledger,
  ledgerOpen,
  busy,
  stopping,
  approving,
  canApprove,
  active,
  onLedgerOpenChange,
  onStop,
  onApprove
}: HostedReviewSitterStatusContentProps): React.JSX.Element {
  const desiredAction = status.desiredAction
  const preparedSha =
    desiredAction && 'preparedCommitSha' in desiredAction ? desiredAction.preparedCommitSha : null
  const statusIsError = status.state === 'escalated' || status.state === 'budget-exhausted'
  return (
    <div className="mt-2 space-y-2">
      <div className="rounded-md border border-border bg-background/60 px-2.5 py-2">
        <div className="flex items-center justify-between gap-2 text-[11px]">
          <span className="flex items-center gap-1 text-muted-foreground">
            <Clock3 className="size-3" aria-hidden />
            {translate(
              'fork.hostedReviewSitter.status.activeBudgetRemaining',
              'Active budget remaining'
            )}
          </span>
          <span className="font-medium tabular-nums text-foreground">
            {formatHostedReviewSitterDuration(status.remainingBudgetMs)}
          </span>
        </div>
        {status.reason ? (
          <div
            className={cn(
              'mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed',
              statusIsError ? 'text-destructive' : 'text-muted-foreground'
            )}
            role={statusIsError ? 'alert' : 'status'}
          >
            {(status.state === 'held' || statusIsError) && (
              <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            )}
            <span>{hostedReviewSitterStatusReason(status.reason)}</span>
          </div>
        ) : null}
      </div>

      {desiredAction ? (
        <div className="rounded-md border border-border bg-background/60 px-2.5 py-2 text-[11px]">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <ShieldCheck className="size-3.5 text-muted-foreground" aria-hidden />
            {hostedReviewSitterActionLabel(desiredAction.kind)}
          </div>
          <dl className="mt-1.5 grid grid-cols-[42px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <dt>{translate('fork.hostedReviewSitter.action.head', 'Head')}</dt>
            <dd className="break-all font-mono text-foreground">{desiredAction.headSha}</dd>
            {preparedSha ? (
              <>
                <dt>{translate('fork.hostedReviewSitter.action.commit', 'Commit')}</dt>
                <dd className="break-all font-mono text-foreground">{preparedSha}</dd>
              </>
            ) : null}
          </dl>
          {canApprove ? (
            <Button
              type="button"
              size="xs"
              className="mt-2 w-full"
              disabled={busy}
              onClick={onApprove}
            >
              {approving ? <Loader2 className="animate-spin" /> : null}
              {translate('fork.hostedReviewSitter.action.approve', 'Approve this action')}
            </Button>
          ) : null}
        </div>
      ) : null}

      {status.discrepancies.length > 0 ? (
        <div className="space-y-1 rounded-md border border-border bg-background/60 px-2.5 py-2">
          {status.discrepancies.map((discrepancy) => (
            <div key={discrepancy.id} className="text-[10px] leading-relaxed text-muted-foreground">
              <span className="font-medium capitalize text-foreground">
                {hostedReviewSitterDiscrepancyLabel(discrepancy.kind)}:
              </span>{' '}
              {hostedReviewSitterStatusReason(discrepancy.reason)}
            </div>
          ))}
        </div>
      ) : null}

      {active ? (
        <>
          <p className="text-[10px] leading-relaxed text-muted-foreground">
            {translate(
              'fork.hostedReviewSitter.stopEffect',
              'Stopping prevents new actions; an in-flight provider operation may finish.'
            )}
          </p>
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="w-full"
            disabled={busy}
            onClick={onStop}
          >
            {stopping ? <Loader2 className="animate-spin" /> : null}
            {translate('fork.hostedReviewSitter.stopCurrent', 'Stop this sitter')}
          </Button>
        </>
      ) : null}

      <Collapsible open={ledgerOpen} onOpenChange={onLedgerOpenChange}>
        <CollapsibleTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            className="w-full justify-between px-1.5 text-muted-foreground"
          >
            {translate('fork.hostedReviewSitter.ledger.title', 'Activity ledger')}
            <ChevronDown
              className={cn('transition-transform', ledgerOpen && 'rotate-180')}
              aria-hidden
            />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <HostedReviewSitterLedgerTimeline ledger={ledger} />
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}
