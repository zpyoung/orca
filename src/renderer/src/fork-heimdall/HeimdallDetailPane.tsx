import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Clock3, Loader2, Pause, Play, StopCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  getLatestApproval,
  getLatestEscalations
} from '../../../shared/fork-heimdall/ledger-queries'
import type {
  WatcherCommand,
  WatcherCommandResult,
  WatcherDetail,
  WatcherFleetEntry,
  WatcherWorker
} from '../../../shared/fork-heimdall/fleet-types'
import { formatHeimdallAge, formatHeimdallTime } from './fleet-format'
import { openHeimdallWorker } from './heimdall-worker-navigation'
import { getHeimdallControlApi } from './heimdall-control-api'
import { HeimdallBudgetCard } from './HeimdallBudgetCard'
import { HeimdallDebugReportButton } from './HeimdallDebugReportButton'
import { HeimdallDecisionTrace } from './HeimdallDecisionTrace'
import { HeimdallEscalations } from './HeimdallEscalations'
import { HeimdallLedgerActivity } from './HeimdallLedgerActivity'
import { HeimdallKindDetail } from './HeimdallKindDetail'
import { HeimdallStatusPill } from './HeimdallStatusPill'
import { HeimdallWorkers } from './HeimdallWorkers'
import { watcherHostLabel, watcherKindLabel } from './watcher-status-copy'

function targetKey(row: WatcherFleetEntry): string {
  return `${row.target.connectionId ?? 'local'}:${row.target.pairingRevision ?? 'local'}:${row.target.watcherId}`
}
type HeimdallCommandNotice = {
  tone: 'applied' | 'refused' | 'indeterminate'
  text: string
}
function commandNotice(result: WatcherCommandResult): HeimdallCommandNotice {
  if (result.status === 'applied') {
    return {
      tone: 'applied',
      text: translate('fork.heimdall.command.applied', 'Applied by the owner at {{time}}.', {
        time: formatHeimdallTime(result.appliedAtMs)
      })
    }
  }
  if (result.status === 'refused') {
    return {
      tone: 'refused',
      text: translate(
        'fork.heimdall.command.refused',
        'Owner refused the command ({{reason}}): {{detail}}',
        { reason: result.reason, detail: result.detail }
      )
    }
  }
  return {
    tone: 'indeterminate',
    text: translate(
      'fork.heimdall.command.indeterminate',
      'The command may or may not have applied. Re-reading owner state… {{detail}}',
      { detail: result.detail }
    )
  }
}

export type HeimdallDetailPaneProps = {
  row: WatcherFleetEntry
  onBack: () => void
}

export function HeimdallDetailPane(props: HeimdallDetailPaneProps): React.JSX.Element {
  return <HeimdallDetailPaneContent key={targetKey(props.row)} {...props} />
}

function HeimdallDetailPaneContent({ row, onBack }: HeimdallDetailPaneProps): React.JSX.Element {
  const hydrateFleet = useAppStore((state) => state.hydrateHeimdallFleet)
  const [detail, setDetail] = useState<WatcherDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [notice, setNotice] = useState<HeimdallCommandNotice | null>(null)
  const requestGeneration = useRef(0)
  const lastRefreshSignature = useRef<string | null>(null)
  const rowKey = targetKey(row)
  const activeDetail = detail && targetKey(detail.watcher) === rowKey ? detail : null
  const detailRefreshSignature = [
    rowKey,
    row.observedAtMs,
    row.ownerFence.executionHostId,
    row.ownerFence.schedulerOwner,
    row.ownerFence.workspaceKey,
    row.ownerFence.revision,
    row.contact,
    row.readOnlyReason ?? '',
    ...row.capabilityNotes
  ].join(':')

  const loadDetail = useCallback(async (): Promise<void> => {
    const api = getHeimdallControlApi()
    if (!api) {
      setLoading(false)
      setError(
        translate('fork.heimdall.error.unavailable', 'Heimdall control plane is unavailable.')
      )
      return
    }
    const generation = ++requestGeneration.current
    setLoading(true)
    setError(null)
    try {
      const next = await api.detail(row.target)
      if (requestGeneration.current === generation) {
        setDetail(next)
      }
    } catch (cause) {
      if (requestGeneration.current === generation) {
        setError(cause instanceof Error ? cause.message : String(cause))
      }
    } finally {
      if (requestGeneration.current === generation) {
        setLoading(false)
      }
    }
  }, [row.target])

  useEffect(() => {
    if (lastRefreshSignature.current === detailRefreshSignature) {
      return
    }
    lastRefreshSignature.current = detailRefreshSignature
    void loadDetail()
  }, [detailRefreshSignature, loadDetail])

  const detailOwnsNewerState =
    activeDetail !== null &&
    (activeDetail.watcher.ownerFence.revision > row.ownerFence.revision ||
      (activeDetail.watcher.ownerFence.revision === row.ownerFence.revision &&
        activeDetail.watcher.observedAtMs >= row.observedAtMs))
  const ownerSnapshotRow = detailOwnsNewerState && activeDetail ? activeDetail.watcher : row
  const displayedRow: WatcherFleetEntry = {
    ...ownerSnapshotRow,
    target: row.target,
    contact: row.contact,
    readOnlyReason: row.readOnlyReason,
    capabilityNotes: row.capabilityNotes
  }
  const openEscalations = useMemo(() => {
    if (!activeDetail) {
      return []
    }
    return getLatestEscalations(activeDetail.ledger).filter((entry) => {
      if (
        (entry.status !== 'open' && entry.status !== 'escalated') ||
        entry.escalationKind === 'park-worker-escalation'
      ) {
        return false
      }
      return !(
        entry.escalationKind === 'awaiting-approval' &&
        entry.approvalScope &&
        getLatestApproval(activeDetail.ledger, entry.approvalScope)?.decision === 'approved'
      )
    })
  }, [activeDetail])
  const readOnly =
    Boolean(displayedRow.readOnlyReason) ||
    displayedRow.contact === 'unverifiable' ||
    displayedRow.entry.status.state === 'unreachable'
  const detailEvidenceStale =
    !activeDetail ||
    activeDetail.watcher.ownerFence.revision < row.ownerFence.revision ||
    (activeDetail.watcher.ownerFence.revision === row.ownerFence.revision &&
      activeDetail.watcher.observedAtMs < row.observedAtMs)

  const runCommand = async (
    key: string,
    command: WatcherCommand
  ): Promise<WatcherCommandResult | null> => {
    const api = getHeimdallControlApi()
    const requiresDetailEvidence =
      command.kind === 'approve' ||
      command.kind === 'adjust-budget' ||
      command.kind === 'answer-question' ||
      command.kind === 'stop-worker'
    if (!api || busyKey || readOnly || (requiresDetailEvidence && detailEvidenceStale)) {
      return null
    }
    setBusyKey(key)
    setNotice(null)
    try {
      const result = await api.command({
        target: displayedRow.target,
        expectedOwner: displayedRow.ownerFence,
        command
      })
      setNotice(commandNotice(result))
      return result
    } catch (cause) {
      setNotice({
        tone: 'indeterminate',
        text: translate(
          'fork.heimdall.command.indeterminate',
          'The command may or may not have applied. Re-reading owner state… {{detail}}',
          { detail: cause instanceof Error ? cause.message : String(cause) }
        )
      })
      return null
    } finally {
      const refreshes: Promise<unknown>[] = [hydrateFleet()]
      refreshes.push(loadDetail())
      await Promise.allSettled(refreshes)
      setBusyKey(null)
    }
  }

  const answerWorker = async (worker: WatcherWorker, body: string): Promise<void> => {
    if (!worker.question) {
      return
    }
    await runCommand(`answer:${worker.question.messageId}`, {
      kind: 'answer-question',
      messageId: worker.question.messageId,
      body
    })
  }

  const status = displayedRow.entry.status
  const lostContact = displayedRow.contact === 'unverifiable' || status.state === 'unreachable'
  const pausedOrParked = displayedRow.paused || status.state === 'parked'
  const resumeBlockedByBudget =
    status.parkReason?.kind === 'budget' && status.budget.exhausted !== null
  const detailFallback = loading
    ? translate('fork.heimdall.detail.loading', 'Loading owner detail…')
    : translate('fork.heimdall.detail.unavailable', 'Owner detail is unavailable.')
  return (
    <article
      className="scrollbar-sleek h-full min-h-0 overflow-y-auto bg-background"
      aria-labelledby="heimdall-detail-title"
    >
      <header className="sticky top-0 z-20 border-b border-border bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex items-start gap-3">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onBack}
            aria-label={translate('fork.heimdall.detail.back', 'Back to fleet')}
          >
            <ArrowLeft aria-hidden />
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="heimdall-detail-title" className="truncate text-base font-semibold">
                {displayedRow.entry.name}
              </h2>
              <HeimdallStatusPill row={displayedRow} />
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {watcherKindLabel(displayedRow.entry.enrollment.kind)} ·{' '}
              {watcherHostLabel(displayedRow)} · {status.phase}
            </p>
          </div>
          <HeimdallDebugReportButton target={displayedRow.target} />
          {loading ? (
            <Loader2
              className="mt-1 size-4 animate-spin text-muted-foreground"
              aria-label={translate('fork.heimdall.detail.refreshing', 'Refreshing detail')}
            />
          ) : null}
        </div>
      </header>

      <div className="space-y-6 p-4">
        <section className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Clock3 className="size-3.5" aria-hidden />
            <span>
              {translate('fork.heimdall.detail.observed', 'Owner state observed {{age}}', {
                age: formatHeimdallAge(displayedRow.observedAtMs)
              })}
            </span>
            {displayedRow.target.connectionId ? (
              <Badge variant="outline">
                {translate('fork.heimdall.detail.remote', 'Remote cache')}
              </Badge>
            ) : null}
          </div>
          {status.reason ? <p className="text-xs text-foreground">{status.reason}</p> : null}
          {lostContact ? (
            <p
              className="rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-foreground"
              role="status"
            >
              {translate(
                'fork.heimdall.detail.lostContact',
                'Last confirmed {{age}}; the owner cannot currently be reached. The watcher may still be running.',
                { age: formatHeimdallAge(displayedRow.observedAtMs) }
              )}
            </p>
          ) : null}
          {displayedRow.readOnlyReason ? (
            <p
              className="rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-foreground"
              role="status"
            >
              <strong>{translate('fork.heimdall.detail.readOnly', 'Read-only.')}</strong>{' '}
              {displayedRow.readOnlyReason}
            </p>
          ) : null}
          {displayedRow.capabilityNotes.length > 0 ? (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {displayedRow.capabilityNotes.map((note) => (
                <li key={note}>{note}</li>
              ))}
            </ul>
          ) : null}
          {error && !lostContact ? (
            <p className="text-xs text-destructive" role="alert">
              {translate(
                'fork.heimdall.detail.staleError',
                'Detail refresh failed; showing the last confirmed data: {{error}}',
                { error }
              )}
            </p>
          ) : null}
        </section>

        <section aria-labelledby="heimdall-controls-title">
          <h3
            id="heimdall-controls-title"
            className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
          >
            {translate('fork.heimdall.controls.title', 'Owner controls')}
          </h3>
          <div className="flex flex-wrap gap-2">
            {pausedOrParked ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={readOnly || busyKey !== null || resumeBlockedByBudget}
                onClick={() => void runCommand('resume', { kind: 'resume' })}
              >
                {busyKey === 'resume' ? <Loader2 className="animate-spin" /> : <Play />}
                {translate('fork.heimdall.controls.resume', 'Resume')}
              </Button>
            ) : status.enabled && status.state !== 'terminal' ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={readOnly || busyKey !== null}
                onClick={() => void runCommand('pause', { kind: 'pause' })}
              >
                {busyKey === 'pause' ? <Loader2 className="animate-spin" /> : <Pause />}
                {translate('fork.heimdall.controls.pause', 'Pause')}
              </Button>
            ) : null}
            {status.state !== 'terminal' && status.state !== 'disabled' ? (
              <Button
                type="button"
                variant="destructive"
                size="sm"
                disabled={readOnly || busyKey !== null}
                onClick={() => void runCommand('disarm', { kind: 'disarm' })}
              >
                {busyKey === 'disarm' ? <Loader2 className="animate-spin" /> : <StopCircle />}
                {translate('fork.heimdall.controls.disarm', 'Disarm')}
              </Button>
            ) : null}
          </div>
          {pausedOrParked && resumeBlockedByBudget ? (
            <p className="mt-2 text-xs text-status-warning">
              {translate(
                'fork.heimdall.controls.budgetResumeWarning',
                'This watcher exhausted its budget. Increase the limit before resuming or it will park again.'
              )}
            </p>
          ) : null}
          {notice ? (
            <p
              className={
                notice.tone === 'applied'
                  ? 'mt-3 rounded-md border border-status-success-border bg-status-success-background px-3 py-2 text-xs text-status-success'
                  : notice.tone === 'refused'
                    ? 'mt-3 rounded-md border border-status-warning-border bg-status-warning-background px-3 py-2 text-xs text-status-warning-foreground'
                    : 'mt-3 rounded-md border border-border bg-muted px-3 py-2 text-xs text-foreground'
              }
              role="status"
            >
              {notice.text}
            </p>
          ) : null}
        </section>

        <HeimdallBudgetCard
          policy={displayedRow.entry.enrollment.budget}
          usage={status.budget}
          disabled={readOnly || detailEvidenceStale}
          busy={busyKey !== null}
          applying={busyKey === 'adjust-budget'}
          onApply={async (budget) => {
            const result = await runCommand('adjust-budget', { kind: 'adjust-budget', budget })
            return result?.status === 'applied'
          }}
        />

        <HeimdallEscalations
          entries={openEscalations}
          traces={activeDetail?.traces ?? []}
          readOnly={readOnly || detailEvidenceStale}
          busyKey={busyKey}
          onApprove={(key, scope) => void runCommand(key, { kind: 'approve', scope })}
        />
        <HeimdallKindDetail row={displayedRow} ledger={activeDetail?.ledger ?? null} />

        <section aria-labelledby="heimdall-workers-title">
          <h3
            id="heimdall-workers-title"
            className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
          >
            {translate('fork.heimdall.workers.title', 'Live workers')}
          </h3>
          {activeDetail ? (
            <HeimdallWorkers
              workers={activeDetail.workers}
              disabled={readOnly || detailEvidenceStale}
              busyKey={busyKey}
              ownerConnectionId={displayedRow.target.connectionId}
              onOpen={openHeimdallWorker}
              onAnswer={answerWorker}
              onStop={async (worker) => {
                await runCommand(`stop-worker:${worker.dispatchId}`, {
                  kind: 'stop-worker',
                  dispatchId: worker.dispatchId
                })
              }}
            />
          ) : (
            <p className="text-xs text-muted-foreground">{detailFallback}</p>
          )}
        </section>
        <section aria-labelledby="heimdall-trace-title">
          <h3
            id="heimdall-trace-title"
            className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
          >
            {translate('fork.heimdall.trace.title', 'Decision trace')}
          </h3>
          {activeDetail ? (
            <HeimdallDecisionTrace traces={activeDetail.traces} />
          ) : (
            <p className="text-xs text-muted-foreground">{detailFallback}</p>
          )}
        </section>
        {activeDetail ? (
          <section aria-labelledby="heimdall-ledger-title">
            <h3
              id="heimdall-ledger-title"
              className="mb-2 text-xs font-semibold uppercase tracking-[0.05em] text-muted-foreground"
            >
              {translate('fork.heimdall.ledger.title', 'Watcher activity')}
            </h3>
            <HeimdallLedgerActivity ledger={activeDetail.ledger} />
          </section>
        ) : null}
      </div>
    </article>
  )
}
