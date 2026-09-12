import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bot, ChevronRight, Loader2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { HostedReviewInfo } from '../../../shared/hosted-review'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import type {
  HostedReviewSitterApi,
  HostedReviewSitterArmInput,
  HostedReviewSitterListEntry
} from '../../../shared/fork-hosted-review-sitter/api'
import { approvalScopeForAction } from '../../../shared/fork-hosted-review-sitter/ledger'
import type {
  HostedReviewBranchUpdateMode,
  HostedReviewMergeMethod,
  HostedReviewSitterCapabilities,
  HostedReviewSitterLedger,
  HostedReviewSitterProvider
} from '../../../shared/fork-hosted-review-sitter/types'
import { HostedReviewSitterEnrollmentForm } from './HostedReviewSitterEnrollmentForm'
import { HostedReviewSitterStatusContent } from './HostedReviewSitterStatusContent'
import { hostedReviewSitterStatusLabel } from './hosted-review-sitter-format'

const POLL_INTERVAL_MS = 5_000
const DEFAULT_ACTIVE_BUDGET_HOURS = 4
const DEFAULT_CAPABILITIES: HostedReviewSitterCapabilities = {
  updateBranch: 'off',
  resolveConflicts: 'off',
  fixChecks: 'off',
  merge: 'off'
}

export type HostedReviewSitterReviewPanelProps = {
  repoId: string
  worktreeId: string
  repoPath: string
  branch: string
  reviewProvider: string
  reviewNumber: number
  reviewUrl: string
  reviewState: string
}

type HostedReviewSitterPanelContentProps = {
  /** A paired runtime owns its own main process; headless sitter transport is not available in v1. */
  runtimeEnvironmentId: string | null
} & HostedReviewSitterReviewPanelProps

function getHostedReviewSitterApi(): HostedReviewSitterApi | null {
  const candidate: unknown = window.api?.hostedReviewSitter
  if (!candidate || typeof candidate !== 'object') {
    return null
  }
  const methods = candidate as Partial<Record<keyof HostedReviewSitterApi, unknown>>
  if (
    typeof methods.list !== 'function' ||
    typeof methods.arm !== 'function' ||
    typeof methods.stop !== 'function' ||
    typeof methods.stopAll !== 'function' ||
    typeof methods.approve !== 'function' ||
    typeof methods.ledger !== 'function'
  ) {
    return null
  }
  return candidate as HostedReviewSitterApi
}

function isSupportedProvider(provider: string): provider is HostedReviewSitterProvider {
  return provider === 'github' || provider === 'gitlab'
}

function sameHostedReview(
  entry: HostedReviewSitterListEntry,
  repoId: string,
  reviewProvider: string,
  reviewNumber: number
): boolean {
  return (
    entry.definition.repoId === repoId &&
    entry.definition.provider === reviewProvider &&
    entry.definition.reviewNumber === reviewNumber
  )
}

function isActiveHostedReviewSitter(entry: HostedReviewSitterListEntry): boolean {
  return (
    entry.definition.enabled &&
    entry.status.enabled &&
    entry.status.state !== 'merged' &&
    entry.status.state !== 'closed' &&
    entry.status.state !== 'disabled'
  )
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message
  }
  if (typeof error === 'string' && error.trim()) {
    return error
  }
  return translate(
    'fork.hostedReviewSitter.error.noResponse',
    'The PR Sitter service did not respond.'
  )
}

function HostedReviewSitterPanelContent({
  repoId,
  worktreeId,
  repoPath,
  branch,
  reviewProvider,
  reviewNumber,
  reviewUrl,
  reviewState,
  runtimeEnvironmentId
}: HostedReviewSitterPanelContentProps): React.JSX.Element | null {
  const bridgeApi = getHostedReviewSitterApi()
  const api = runtimeEnvironmentId ? null : bridgeApi
  const supportedProvider = isSupportedProvider(reviewProvider)
  const [entries, setEntries] = useState<HostedReviewSitterListEntry[] | null>(null)
  const [ledger, setLedger] = useState<HostedReviewSitterLedger | null>(null)
  const [serviceError, setServiceError] = useState<string | null>(null)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [ledgerOpen, setLedgerOpen] = useState(false)
  const [configOpen, setConfigOpen] = useState(false)
  const [capabilities, setCapabilities] = useState<HostedReviewSitterCapabilities>({
    ...DEFAULT_CAPABILITIES
  })
  const [branchUpdateMode, setBranchUpdateMode] =
    useState<HostedReviewBranchUpdateMode>('merge-base-update')
  const [mergeMethod, setMergeMethod] = useState<'default' | HostedReviewMergeMethod>('default')
  const [activeBudgetHours, setActiveBudgetHours] = useState(DEFAULT_ACTIVE_BUDGET_HOURS)
  const requestSerialRef = useRef(0)
  const identityKey = `${repoId}:${reviewProvider}:${reviewNumber}:${runtimeEnvironmentId ?? 'desktop'}`

  const refresh = useCallback(async (): Promise<void> => {
    if (!api || !supportedProvider) {
      return
    }
    const requestSerial = ++requestSerialRef.current
    try {
      const nextEntries = await api.list()
      if (requestSerial !== requestSerialRef.current) {
        return
      }
      setEntries(nextEntries)
      setServiceError(null)
      const current = nextEntries.find((entry) =>
        sameHostedReview(entry, repoId, reviewProvider, reviewNumber)
      )
      if (!current) {
        setLedger(null)
        return
      }
      try {
        const nextLedger = await api.ledger(current.definition.id)
        if (requestSerial === requestSerialRef.current) {
          setLedger(nextLedger)
        }
      } catch (error) {
        if (requestSerial === requestSerialRef.current) {
          setLedger(null)
          setServiceError(
            translate(
              'fork.hostedReviewSitter.error.activityUnavailable',
              'Activity unavailable: {{error}}',
              { error: describeError(error) }
            )
          )
        }
      }
    } catch (error) {
      if (requestSerial === requestSerialRef.current) {
        setServiceError(describeError(error))
      }
    }
  }, [api, repoId, reviewNumber, reviewProvider, supportedProvider])

  useEffect(() => {
    requestSerialRef.current += 1
    setEntries(null)
    setLedger(null)
    setServiceError(null)
    setMutationError(null)
    setCapabilities({ ...DEFAULT_CAPABILITIES })
    setBranchUpdateMode('merge-base-update')
    setMergeMethod('default')
    setActiveBudgetHours(DEFAULT_ACTIVE_BUDGET_HOURS)
    setLedgerOpen(false)
    setConfigOpen(false)
    if (!api || !supportedProvider) {
      return
    }
    void refresh()
    const interval = window.setInterval(() => void refresh(), POLL_INTERVAL_MS)
    return () => {
      window.clearInterval(interval)
      requestSerialRef.current += 1
    }
  }, [api, identityKey, refresh, supportedProvider])

  const currentEntry = useMemo(
    () =>
      entries?.find((entry) => sameHostedReview(entry, repoId, reviewProvider, reviewNumber)) ??
      null,
    [entries, repoId, reviewNumber, reviewProvider]
  )
  const currentEntryIsActive = currentEntry !== null && isActiveHostedReviewSitter(currentEntry)
  const activeEntries = useMemo(() => entries?.filter(isActiveHostedReviewSitter) ?? [], [entries])

  if (!supportedProvider) {
    return null
  }

  const runMutation = async (name: string, operation: () => Promise<void>): Promise<void> => {
    if (!api || busyAction) {
      return
    }
    setBusyAction(name)
    setMutationError(null)
    try {
      await operation()
      await refresh()
    } catch (error) {
      setMutationError(describeError(error))
    } finally {
      setBusyAction(null)
    }
  }

  const arm = (): void => {
    if (!api) {
      return
    }
    const input: HostedReviewSitterArmInput = {
      repoId,
      worktreeId,
      repoPath,
      branch,
      provider: reviewProvider,
      reviewNumber,
      reviewUrl,
      capabilities,
      activeBudgetMs: Math.round(activeBudgetHours * 60 * 60 * 1_000),
      branchUpdateMode,
      mergeMethod: mergeMethod === 'default' ? null : mergeMethod
    }
    void runMutation('arm', async () => {
      await api.arm(input)
    })
  }

  const stopCurrent = (): void => {
    if (!api || !currentEntry || !currentEntryIsActive) {
      return
    }
    void runMutation('stop', () => api.stop(currentEntry.definition.id))
  }

  const approveCurrentAction = (): void => {
    const action = currentEntry?.status.desiredAction
    if (!api || !currentEntry || !action) {
      return
    }
    void runMutation('approve', () =>
      api.approve(currentEntry.definition.id, approvalScopeForAction(action))
    )
  }

  const unavailableReason = runtimeEnvironmentId
    ? translate(
        'fork.hostedReviewSitter.unavailable.pairedRuntime',
        'PR Sitter is not available for peer-hosted workspaces.'
      )
    : !bridgeApi
      ? translate(
          'fork.hostedReviewSitter.unavailable.missingApi',
          'This Orca host does not provide the PR Sitter service.'
        )
      : entries === null
        ? serviceError
        : null
  const armBlockedReason =
    reviewState !== 'open' && reviewState !== 'draft'
      ? translate(
          'fork.hostedReviewSitter.enrollment.reviewNotOpen',
          'Only an open review can be armed.'
        )
      : !branch.trim()
        ? translate(
            'fork.hostedReviewSitter.enrollment.branchRequired',
            'A checked-out branch is required to arm PR Sitter.'
          )
        : !repoPath.trim()
          ? translate(
              'fork.hostedReviewSitter.enrollment.worktreeUnavailable',
              'The worktree path is unavailable.'
            )
          : null
  const desiredAction = currentEntry?.status.desiredAction ?? null
  const canApprove = Boolean(
    desiredAction &&
    currentEntryIsActive &&
    currentEntry?.status.state === 'held' &&
    currentEntry.status.reason === 'awaiting-approval'
  )
  const statusIsError =
    currentEntry?.status.state === 'escalated' || currentEntry?.status.state === 'budget-exhausted'

  return (
    <section
      className="border-b border-border bg-muted/10 px-3 py-2"
      aria-label={translate('fork.hostedReviewSitter.title', 'PR Sitter')}
    >
      <Dialog open={configOpen} onOpenChange={setConfigOpen}>
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
              <Badge
                variant={statusIsError ? 'destructive' : 'outline'}
                className="h-5 text-[10px]"
              >
                {hostedReviewSitterStatusLabel(currentEntry.status.state)}
              </Badge>
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
                {currentEntry ? (
                  <HostedReviewSitterStatusContent
                    status={currentEntry.status}
                    ledger={ledger}
                    ledgerOpen={ledgerOpen}
                    busy={busyAction !== null}
                    stopping={busyAction === 'stop'}
                    approving={busyAction === 'approve'}
                    canApprove={canApprove}
                    active={currentEntryIsActive}
                    onLedgerOpenChange={setLedgerOpen}
                    onStop={stopCurrent}
                    onApprove={approveCurrentAction}
                  />
                ) : null}
                {!currentEntryIsActive ? (
                  <HostedReviewSitterEnrollmentForm
                    capabilities={capabilities}
                    branchUpdateMode={branchUpdateMode}
                    mergeMethod={mergeMethod}
                    activeBudgetHours={activeBudgetHours}
                    activeElsewhereCount={activeEntries.length}
                    blockedReason={armBlockedReason}
                    busy={busyAction !== null}
                    arming={busyAction === 'arm'}
                    rearming={currentEntry !== null}
                    onCapabilitiesChange={setCapabilities}
                    onBranchUpdateModeChange={setBranchUpdateMode}
                    onMergeMethodChange={setMergeMethod}
                    onActiveBudgetHoursChange={setActiveBudgetHours}
                    onArm={arm}
                  />
                ) : null}
              </>
            )}

            {mutationError ? (
              <div className="mt-2 text-[10px] leading-relaxed text-destructive" role="alert">
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

export function HostedReviewSitterReviewPanel(
  props: HostedReviewSitterReviewPanelProps
): React.JSX.Element | null {
  const runtimeEnvironmentId = useAppStore((state) =>
    getRuntimeEnvironmentIdForWorktree(state, props.worktreeId)
  )
  return <HostedReviewSitterPanelContent {...props} runtimeEnvironmentId={runtimeEnvironmentId} />
}

export type HostedReviewSitterPanelModel = {
  activeReview: HostedReviewInfo | null
  activeWorktree: Worktree | null
  activeWorktreeId: string | null
  detachedHeadDisplay: unknown
  repo: Repo | null
}

export function HostedReviewSitterPanel({
  model
}: {
  model: HostedReviewSitterPanelModel
}): React.JSX.Element | null {
  const { activeReview, activeWorktree, activeWorktreeId, repo } = model
  if (!activeReview || !activeWorktree || !activeWorktreeId || !repo) {
    return null
  }
  return (
    <HostedReviewSitterReviewPanel
      repoId={repo.id}
      worktreeId={activeWorktreeId}
      repoPath={activeWorktree.path}
      branch={model.detachedHeadDisplay ? '' : activeWorktree.branch}
      reviewProvider={activeReview.provider}
      reviewNumber={activeReview.number}
      reviewUrl={activeReview.url}
      reviewState={activeReview.state}
    />
  )
}
