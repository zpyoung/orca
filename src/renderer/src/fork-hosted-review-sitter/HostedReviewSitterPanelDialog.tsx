import React from 'react'
import { Bot, ChevronRight, Loader2 } from 'lucide-react'
import { HeimdallTonePill } from '@/fork-heimdall/heimdall-tone-pill'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import type { ApprovalScope, WatcherLedger } from '../../../shared/fork-heimdall/ledger-types'
import type {
  WatcherFleetEntryReader,
  WatcherListEntryReader
} from '../../../shared/fork-heimdall/remote-reader-schemas'
import type {
  HostedReviewBranchUpdateMode,
  HostedReviewMergeCheckScope,
  HostedReviewMergeMethod,
  HostedReviewSitterCapabilities
} from '../../../shared/fork-hosted-review-sitter/types'
import { HostedReviewSitterEnrollmentForm } from './HostedReviewSitterEnrollmentForm'
import { HostedReviewSitterStatusContent } from './HostedReviewSitterStatusContent'
import { formatHeimdallAge } from '@/fork-heimdall/fleet-format'
import { isHeimdallAttentionRow } from '@/fork-heimdall/fleet-selectors'
import { hostedReviewSitterStatusLabel } from './hosted-review-sitter-format'

type HostedReviewSitterPanelDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  reviewProvider: string
  unavailableReason: string | null
  entries: WatcherListEntryReader[] | null
  lostContact: boolean
  currentFleetRow: WatcherFleetEntryReader | null
  currentEntry: WatcherListEntryReader | null
  ledger: WatcherLedger | null
  approvalScope: ApprovalScope | null
  ledgerOpen: boolean
  onLedgerOpenChange: (open: boolean) => void
  controlsReadOnly: boolean
  commandReadOnlyReason: string | null
  busyAction: string | null
  debugReportCopied: boolean
  currentEntryIsActive: boolean
  onDisarm: () => void
  onApprove: () => void
  onCopyDebugReport: () => void
  capabilities: HostedReviewSitterCapabilities
  branchUpdateMode: HostedReviewBranchUpdateMode
  mergeMethod: 'default' | HostedReviewMergeMethod
  mergeCheckScope: HostedReviewMergeCheckScope
  activeBudgetHours: number
  activeElsewhereCount: number
  enrollBlockedReason: string | null
  onCapabilitiesChange: (capabilities: HostedReviewSitterCapabilities) => void
  onBranchUpdateModeChange: (mode: HostedReviewBranchUpdateMode) => void
  onMergeMethodChange: (method: 'default' | HostedReviewMergeMethod) => void
  onMergeCheckScopeChange: (scope: HostedReviewMergeCheckScope) => void
  onActiveBudgetHoursChange: (hours: number) => void
  onArm: () => void
  mutationError: string | null
  mutationTone: 'error' | 'refused' | 'indeterminate'
  serviceError: string | null
}

export function HostedReviewSitterPanelDialog({
  open,
  onOpenChange,
  reviewProvider,
  unavailableReason,
  entries,
  lostContact,
  currentFleetRow,
  currentEntry,
  ledger,
  approvalScope,
  ledgerOpen,
  onLedgerOpenChange,
  controlsReadOnly,
  commandReadOnlyReason,
  busyAction,
  debugReportCopied,
  currentEntryIsActive,
  onDisarm,
  onApprove,
  onCopyDebugReport,
  capabilities,
  branchUpdateMode,
  mergeMethod,
  mergeCheckScope,
  activeBudgetHours,
  activeElsewhereCount,
  enrollBlockedReason,
  onCapabilitiesChange,
  onBranchUpdateModeChange,
  onMergeMethodChange,
  onMergeCheckScopeChange,
  onActiveBudgetHoursChange,
  onArm,
  mutationError,
  mutationTone,
  serviceError
}: HostedReviewSitterPanelDialogProps): React.JSX.Element {
  const statusNeedsAttention = currentFleetRow ? isHeimdallAttentionRow(currentFleetRow) : false

  return (
    <section
      className="border-b border-border bg-muted/10 px-3 py-2"
      aria-label={translate('fork.hostedReviewSitter.title', 'PR Sitter')}
    >
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          >
            <Bot className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="text-xs font-medium text-foreground">
              {translate('fork.hostedReviewSitter.title', 'PR Sitter')}
            </span>
            {currentEntry ? (
              <HeimdallTonePill tone={statusNeedsAttention || lostContact ? 'warning' : 'neutral'}>
                <span className="text-[10px]">
                  {hostedReviewSitterStatusLabel(
                    lostContact ? 'unreachable' : currentEntry.status.state
                  )}
                </span>
              </HeimdallTonePill>
            ) : null}
            {entries === null && !unavailableReason ? (
              <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" aria-hidden />
            ) : null}
            <ChevronRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          </button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{translate('fork.hostedReviewSitter.title', 'PR Sitter')}</DialogTitle>
            <DialogDescription>
              {reviewProvider === 'gitlab'
                ? translate(
                    'fork.hostedReviewSitter.enrollment.descriptionGitLab',
                    'Watch this merge request and choose which actions Orca may take.'
                  )
                : translate(
                    'fork.hostedReviewSitter.enrollment.descriptionGitHub',
                    'Watch this pull request and choose which actions Orca may take.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <div className="scrollbar-sleek max-h-[60vh] overflow-y-auto">
            {unavailableReason ? (
              <div
                className="mt-2 rounded-md border border-border bg-background/60 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground"
                role="status"
              >
                <span className="font-medium text-foreground">
                  {translate('fork.hostedReviewSitter.unavailable.title', 'Unavailable.')}
                </span>{' '}
                {unavailableReason}
              </div>
            ) : entries === null ? (
              <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin" aria-hidden />
                {translate('fork.hostedReviewSitter.loading', 'Loading sitter status…')}
              </div>
            ) : (
              <>
                {lostContact && currentFleetRow ? (
                  <p
                    className="mb-2 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-foreground"
                    role="status"
                  >
                    {translate(
                      'fork.heimdall.detail.lostContact',
                      'Last confirmed {{age}}; the owner cannot currently be reached. The watcher may still be running.',
                      { age: formatHeimdallAge(currentFleetRow.observedAtMs) }
                    )}
                  </p>
                ) : null}
                {currentEntry ? (
                  <HostedReviewSitterStatusContent
                    entry={currentEntry}
                    ledger={ledger}
                    approvalScope={approvalScope}
                    ledgerOpen={ledgerOpen}
                    readOnly={controlsReadOnly}
                    readOnlyReason={commandReadOnlyReason}
                    busy={busyAction !== null}
                    stopping={busyAction === 'disarm'}
                    approving={busyAction === 'approve'}
                    active={currentEntryIsActive}
                    copyingDebugReport={busyAction === 'debugReport'}
                    debugReportCopied={debugReportCopied}
                    onLedgerOpenChange={onLedgerOpenChange}
                    onStop={onDisarm}
                    onApprove={onApprove}
                    onCopyDebugReport={onCopyDebugReport}
                  />
                ) : null}
                {!currentEntryIsActive ? (
                  <HostedReviewSitterEnrollmentForm
                    capabilities={capabilities}
                    branchUpdateMode={branchUpdateMode}
                    mergeMethod={mergeMethod}
                    mergeCheckScope={mergeCheckScope}
                    activeBudgetHours={activeBudgetHours}
                    activeElsewhereCount={activeElsewhereCount}
                    blockedReason={enrollBlockedReason}
                    busy={busyAction !== null}
                    arming={busyAction === 'enroll'}
                    rearming={currentEntry !== null}
                    onCapabilitiesChange={onCapabilitiesChange}
                    onBranchUpdateModeChange={onBranchUpdateModeChange}
                    onMergeMethodChange={onMergeMethodChange}
                    onMergeCheckScopeChange={onMergeCheckScopeChange}
                    onActiveBudgetHoursChange={onActiveBudgetHoursChange}
                    onArm={onArm}
                  />
                ) : null}
              </>
            )}

            {mutationError ? (
              <div
                className={
                  mutationTone === 'refused'
                    ? 'mt-2 rounded-md border border-status-warning-border bg-status-warning-background px-2.5 py-2 text-[10px] leading-relaxed text-status-warning-foreground'
                    : mutationTone === 'indeterminate'
                      ? 'mt-2 rounded-md border border-border bg-muted px-2.5 py-2 text-[10px] leading-relaxed text-foreground'
                      : 'mt-2 text-[10px] leading-relaxed text-destructive'
                }
                role={mutationTone === 'error' ? 'alert' : 'status'}
              >
                {mutationError}
              </div>
            ) : null}
            {serviceError && entries !== null ? (
              <div className="mt-2 text-[10px] leading-relaxed text-destructive" role="alert">
                {serviceError}
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  )
}
