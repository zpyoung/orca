import React from 'react'
import {
  Check,
  ChevronDown,
  ClipboardCopy,
  Clock3,
  Loader2,
  ShieldCheck,
  TriangleAlert
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  ApprovalScope,
  EscalationEntry,
  WatcherLedger
} from '../../../shared/fork-heimdall/ledger-types'
import type { WatcherListEntry } from '../../../shared/fork-heimdall/watcher-types'
import {
  formatHostedReviewSitterDuration,
  formatHostedReviewSitterTime,
  hostedReviewSitterKernelActionLabel,
  hostedReviewSitterKernelDiscrepancyLabel,
  hostedReviewSitterDiscrepancyStatusLabel,
  hostedReviewSitterLedgerEntrySummary
} from './hosted-review-sitter-format'
import { hostedReviewSitterStatusReason } from './hosted-review-sitter-status-copy'

function HostedReviewSitterLedgerTimeline({
  ledger
}: {
  ledger: WatcherLedger | null
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

function latestEscalations(ledger: WatcherLedger | null): EscalationEntry[] {
  if (!ledger) {
    return []
  }
  const latest = new Map<string, EscalationEntry>()
  for (const entry of ledger.entries) {
    if (entry.kind !== 'escalation') {
      continue
    }
    const previous = latest.get(entry.escalationId)
    if (!previous || entry.atMs >= previous.atMs) {
      latest.set(entry.escalationId, entry)
    }
  }
  return [...latest.values()].filter(
    (entry) => entry.status === 'open' || entry.status === 'escalated'
  )
}

function entryStatusReason(entry: WatcherListEntry): string | null {
  if (entry.status.reason) {
    return hostedReviewSitterStatusReason(entry.status.reason)
  }
  const parkReason = entry.status.parkReason
  if (!parkReason) {
    return null
  }
  if (parkReason.kind === 'budget') {
    return parkReason.exhaustion.kind === 'turns'
      ? hostedReviewSitterStatusReason('budget-turns')
      : hostedReviewSitterStatusReason('budget-wall-clock')
  }
  if (parkReason.kind === 'stop-predicate') {
    return hostedReviewSitterStatusReason(parkReason.reason)
  }
  if (parkReason.kind === 'worker-question') {
    return translate(
      'fork.hostedReviewSitter.status.workerQuestion',
      'A worker question needs a person before the watcher can continue.'
    )
  }
  return hostedReviewSitterStatusReason('coordinator-seat-lost')
}

export type HostedReviewSitterStatusContentProps = {
  entry: WatcherListEntry
  ledger: WatcherLedger | null
  approvalScope: ApprovalScope | null
  ledgerOpen: boolean
  readOnly: boolean
  readOnlyReason: string | null
  busy: boolean
  stopping: boolean
  approving: boolean
  active: boolean
  copyingDebugReport: boolean
  debugReportCopied: boolean
  onLedgerOpenChange: (open: boolean) => void
  onStop: () => void
  onApprove: () => void
  onCopyDebugReport: () => void
}

export function HostedReviewSitterStatusContent({
  entry,
  ledger,
  approvalScope,
  ledgerOpen,
  readOnly,
  readOnlyReason,
  busy,
  stopping,
  approving,
  active,
  copyingDebugReport,
  debugReportCopied,
  onLedgerOpenChange,
  onStop,
  onApprove,
  onCopyDebugReport
}: HostedReviewSitterStatusContentProps): React.JSX.Element {
  const { enrollment, status } = entry
  const reason = entryStatusReason(entry)
  const statusNeedsAttention = status.state === 'escalated' || status.state === 'parked'
  const activeLimitMs = enrollment.budget.wallClockActiveMs
  const remainingBudgetMs =
    activeLimitMs === null ? null : Math.max(0, activeLimitMs - status.budget.activeMs)
  const escalations = latestEscalations(ledger)
  return (
    <div className="mt-2 space-y-2">
      {readOnlyReason ? (
        <p
          className="rounded-md border border-status-warning-border bg-status-warning-background px-2.5 py-2 text-[11px] text-status-warning-foreground"
          role="status"
        >
          <strong>{translate('fork.heimdall.detail.readOnly', 'Read-only.')}</strong>{' '}
          {readOnlyReason}
        </p>
      ) : null}
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
            {remainingBudgetMs === null
              ? translate('fork.heimdall.budget.unlimited', 'Unlimited')
              : formatHostedReviewSitterDuration(remainingBudgetMs)}
          </span>
        </div>
        {enrollment.budget.turns !== null ? (
          <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
            <span>{translate('fork.heimdall.budget.turns', 'Worker turns')}</span>
            <span className="tabular-nums text-foreground">
              {status.budget.turns}/{enrollment.budget.turns}
            </span>
          </div>
        ) : null}
        <div className="mt-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span>{translate('fork.heimdall.status.phase', 'Current phase')}</span>
          <span className="truncate text-foreground">{status.phase}</span>
        </div>
        {reason ? (
          <div
            className={cn(
              'mt-1.5 flex items-start gap-1.5 text-[11px] leading-relaxed',
              statusNeedsAttention ? 'text-status-warning' : 'text-muted-foreground'
            )}
            role="status"
          >
            {(status.state === 'held' || statusNeedsAttention) && (
              <TriangleAlert className="mt-0.5 size-3 shrink-0" aria-hidden />
            )}
            <span>{reason}</span>
          </div>
        ) : null}
      </div>

      {approvalScope ? (
        <div className="rounded-md border border-border bg-background/60 px-2.5 py-2 text-[11px]">
          <div className="flex items-center gap-1.5 font-medium text-foreground">
            <ShieldCheck className="size-3.5 text-muted-foreground" aria-hidden />
            {hostedReviewSitterKernelActionLabel(approvalScope.actionKind)}
          </div>
          <dl className="mt-1.5 grid grid-cols-[52px_minmax(0,1fr)] gap-x-2 gap-y-1 text-[10px] text-muted-foreground">
            <dt>{translate('fork.hostedReviewSitter.action.contentIdentity', 'Review state')}</dt>
            <dd className="break-all font-mono text-foreground">{approvalScope.contentIdentity}</dd>
            {approvalScope.preparedCommitSha ? (
              <>
                <dt>{translate('fork.hostedReviewSitter.action.commit', 'Commit')}</dt>
                <dd className="break-all font-mono text-foreground">
                  {approvalScope.preparedCommitSha}
                </dd>
              </>
            ) : null}
          </dl>
          <Button
            type="button"
            size="xs"
            className="mt-2 w-full"
            disabled={busy || readOnly}
            onClick={onApprove}
          >
            {approving ? <Loader2 className="animate-spin" /> : null}
            {translate('fork.hostedReviewSitter.action.approve', 'Approve this action')}
          </Button>
        </div>
      ) : null}

      {escalations.length > 0 ? (
        <div className="space-y-1 rounded-md border border-border bg-background/60 px-2.5 py-2">
          {escalations.map((escalation) => (
            <div
              key={escalation.escalationId}
              className="text-[10px] leading-relaxed text-muted-foreground"
            >
              <span className="font-medium text-foreground">
                {hostedReviewSitterKernelDiscrepancyLabel(escalation.escalationKind)}
                {' · '}
                {hostedReviewSitterDiscrepancyStatusLabel(escalation.status)}
              </span>
              {escalation.reason ? `: ${hostedReviewSitterStatusReason(escalation.reason)}` : null}
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
            disabled={busy || readOnly}
            onClick={onStop}
          >
            {stopping ? <Loader2 className="animate-spin" /> : null}
            {translate('fork.hostedReviewSitter.stopCurrent', 'Stop this sitter')}
          </Button>
        </>
      ) : null}

      <Button
        type="button"
        variant="outline"
        size="xs"
        className="w-full"
        disabled={busy}
        onClick={onCopyDebugReport}
      >
        {copyingDebugReport ? (
          <Loader2 className="animate-spin" />
        ) : debugReportCopied ? (
          <Check />
        ) : (
          <ClipboardCopy />
        )}
        {debugReportCopied
          ? translate('fork.hostedReviewSitter.debugReport.copied', 'Debug report copied')
          : translate('fork.hostedReviewSitter.debugReport.copy', 'Copy debug report')}
      </Button>

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
