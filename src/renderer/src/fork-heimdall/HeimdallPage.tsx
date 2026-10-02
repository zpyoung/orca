import { lazy, Suspense, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { ArrowLeft, Bot, Loader2, Plus, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type {
  WatcherDetailReader,
  WatcherFleetEntryReader
} from '../../../shared/fork-heimdall/remote-reader-schemas'
import { projectFleetActions } from './fleet-action-history'
import { isHeimdallAttentionRow, sortHeimdallFleetRows, sameWatcherTarget } from './fleet-selectors'
import { getHeimdallControlApi } from './heimdall-control-api'
import { HeimdallDetailPane } from './HeimdallDetailPane'
import { HeimdallFleetActivity } from './HeimdallFleetActivity'
import { HeimdallFleetList } from './HeimdallFleetList'
import { buildObjectiveWorkspaceOptions } from '../fork-heimdall-objective/objective-workspace-options'
import { PipelinesMenu } from '../fork-heimdall-pipeline/PipelinesMenu'

const ObjectiveEnrollmentSheet = lazy(() =>
  import('../fork-heimdall-objective/ObjectiveEnrollmentSheet').then((module) => ({
    default: module.ObjectiveEnrollmentSheet
  }))
)

function detailKey(detail: WatcherDetailReader): string {
  return `${detail.watcher.target.connectionId ?? 'local'}:${detail.watcher.target.pairingRevision ?? 'local'}:${detail.watcher.target.watcherId}`
}

function historyRowSignature(row: WatcherFleetEntryReader): string {
  return [
    `${row.target.connectionId ?? 'local'}:${row.target.pairingRevision ?? 'local'}:${row.target.watcherId}`,
    row.observedAtMs,
    row.ownerFence.revision,
    row.contact,
    row.readOnlyReason ?? '',
    ...row.capabilityNotes
  ].join(':')
}

export default function HeimdallPage(): React.JSX.Element {
  const snapshot = useAppStore((state) => state.heimdallFleet)
  const loading = useAppStore((state) => state.heimdallFleetLoading)
  const fleetError = useAppStore((state) => state.heimdallFleetError)
  const selectedTarget = useAppStore((state) => state.heimdallSelectedTarget)
  const selectWatcher = useAppStore((state) => state.selectHeimdallWatcher)
  const hydrateFleet = useAppStore((state) => state.hydrateHeimdallFleet)
  const closePage = useAppStore((state) => state.closeHeimdallPage)
  const rows = useMemo(() => sortHeimdallFleetRows(snapshot?.entries ?? []), [snapshot])
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeOrcaProfileId = useAppStore((state) => state.activeOrcaProfileId)
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => state.worktreesByRepo)
  const folderWorkspaces = useAppStore((state) => state.folderWorkspaces)
  const projectGroups = useAppStore((state) => state.projectGroups)
  const runtimeEnvironments = useAppStore((state) => state.runtimeEnvironments)
  const detectedAgentIds = useAppStore((state) => state.detectedAgentIds)
  const remoteDetectedAgentIds = useAppStore((state) => state.remoteDetectedAgentIds)
  const runtimeDetectedAgentIds = useAppStore((state) => state.runtimeDetectedAgentIds)
  const runtimeStatusByEnvironmentId = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  const settings = useAppStore((state) => state.settings)
  const pipelineWorkspaces = useMemo(
    () =>
      buildObjectiveWorkspaceOptions({
        repos,
        worktreesByRepo,
        folderWorkspaces,
        projectGroups,
        runtimeEnvironments,
        detectedAgentIds,
        remoteDetectedAgentIds,
        runtimeDetectedAgentIds,
        runtimeStatusByEnvironmentId,
        settings
      }),
    [
      detectedAgentIds,
      folderWorkspaces,
      projectGroups,
      remoteDetectedAgentIds,
      repos,
      runtimeDetectedAgentIds,
      runtimeStatusByEnvironmentId,
      runtimeEnvironments,
      settings,
      worktreesByRepo
    ]
  )
  const pipelineWorkspace =
    pipelineWorkspaces.find((workspace) => workspace.worktreeId === activeWorktreeId) ?? null
  const selectedRow = rows.find((row) => sameWatcherTarget(selectedTarget, row.target)) ?? null
  const activeCount = rows.filter(
    (row) =>
      row.entry.status.enabled &&
      !row.paused &&
      row.entry.status.state !== 'parked' &&
      row.entry.status.state !== 'terminal' &&
      row.entry.status.state !== 'disabled'
  ).length
  const attentionCount = rows.filter(isHeimdallAttentionRow).length
  const [detailsByKey, setDetailsByKey] = useState<Record<string, WatcherDetailReader>>({})
  const [historyLoading, setHistoryLoading] = useState(false)
  const [historyFailures, setHistoryFailures] = useState(0)
  const [historyAsOf, setHistoryAsOf] = useState<number | null>(null)
  const historyGeneration = useRef(0)
  const pageRef = useRef<HTMLElement>(null)
  const [wideDetailLayout, setWideDetailLayout] = useState(false)
  const [newRunSheetOpen, setNewRunSheetOpen] = useState(false)
  const detailSignature = rows.map(historyRowSignature).sort().join('|')

  const completedHistoryRowSignatures = useRef<Record<string, string>>({})
  // Equal snapshots (and StrictMode's repeated effect) must not cancel the only detail request.
  const lastHistorySignature = useRef<string | null>(null)
  const refreshHistory = useEffectEvent((signature: string) => {
    if (lastHistorySignature.current === signature) {
      return
    }
    lastHistorySignature.current = signature
    const generation = ++historyGeneration.current
    const rowSignatures = rows.map((row) => ({
      row,
      key: `${row.target.connectionId ?? 'local'}:${row.target.pairingRevision ?? 'local'}:${row.target.watcherId}`,
      signature: historyRowSignature(row)
    }))
    const activeKeys = new Set(rowSignatures.map(({ key }) => key))
    const completedSignatures = Object.fromEntries(
      Object.entries(completedHistoryRowSignatures.current).filter(([key]) => activeKeys.has(key))
    )
    completedHistoryRowSignatures.current = completedSignatures
    const rowsToRefresh = rowSignatures.filter(
      ({ key, signature: rowSignature }) => completedSignatures[key] !== rowSignature
    )
    if (rows.length === 0) {
      setDetailsByKey({})
      setHistoryFailures(0)
      setHistoryAsOf(null)
      setHistoryLoading(false)
      return
    }
    setDetailsByKey((current) => {
      const retained = Object.fromEntries(
        Object.entries(current).filter(([, detail]) =>
          rows.some((row) => sameWatcherTarget(detail.watcher.target, row.target))
        )
      )
      return Object.keys(retained).length === Object.keys(current).length ? current : retained
    })
    if (rowsToRefresh.length === 0) {
      setHistoryLoading(false)
      return
    }
    const api = getHeimdallControlApi()
    if (!api) {
      setHistoryLoading(false)
      return
    }
    setHistoryLoading(true)
    void Promise.allSettled(
      rowsToRefresh.map(({ row }) => Promise.resolve().then(() => api.detail(row.target)))
    ).then((results) => {
      if (historyGeneration.current !== generation) {
        return
      }
      let failures = 0
      const fulfilledDetails: WatcherDetailReader[] = []
      for (const [index, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          fulfilledDetails.push(result.value)
          const completed = rowsToRefresh[index]
          completedSignatures[completed.key] = completed.signature
        } else {
          failures += 1
        }
      }
      setDetailsByKey((current) => {
        const next: Record<string, WatcherDetailReader> = {}
        for (const detail of Object.values(current)) {
          if (rows.some((row) => sameWatcherTarget(detail.watcher.target, row.target))) {
            next[detailKey(detail)] = detail
          }
        }
        for (const detail of fulfilledDetails) {
          next[detailKey(detail)] = detail
        }
        return next
      })
      setHistoryFailures(failures)
      if (fulfilledDetails.length > 0) {
        setHistoryAsOf(Date.now())
      }
      setHistoryLoading(false)
    })
  })

  useEffect(() => {
    refreshHistory(detailSignature)
  }, [detailSignature])
  useEffect(() => {
    const page = pageRef.current
    if (!page) {
      return
    }
    if (typeof ResizeObserver === 'undefined') {
      return
    }
    const updateLayout = (): void => setWideDetailLayout(page.clientWidth >= 1_240)
    updateLayout()
    const observer = new ResizeObserver(updateLayout)
    observer.observe(page)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return
      }
      const target = event.target
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        (target instanceof HTMLElement && target.isContentEditable)
      ) {
        return
      }
      event.preventDefault()
      if (selectedTarget) {
        selectWatcher(null)
      } else {
        closePage()
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [closePage, selectWatcher, selectedTarget])

  const actions = useMemo(() => projectFleetActions(Object.values(detailsByKey)), [detailsByKey])
  return (
    <main ref={pageRef} className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3 md:px-6">
        <Button type="button" variant="outline" size="sm" onClick={closePage}>
          <ArrowLeft aria-hidden />
          {translate('fork.heimdall.page.back', 'Back')}
        </Button>
        <Bot className="size-4 text-muted-foreground" aria-hidden />
        <div className="min-w-0">
          <h1 className="text-sm font-semibold">
            {translate('fork.heimdall.page.title', 'Heimdall fleet')}
          </h1>
          <p className="text-[11px] text-muted-foreground">
            {translate(
              'fork.heimdall.page.summary',
              '{{active}} active · {{attention}} need attention',
              { active: activeCount, attention: attentionCount }
            )}
          </p>
        </div>
        <PipelinesMenu
          workspace={pipelineWorkspace}
          worktreeId={activeWorktreeId}
          profileId={activeOrcaProfileId}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="ml-auto"
          onClick={() => setNewRunSheetOpen(true)}
        >
          <Plus aria-hidden />
          {translate('fork.heimdall.page.newRun', 'New run')}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          disabled={loading}
          onClick={() => void hydrateFleet()}
          aria-label={translate('fork.heimdall.page.refresh', 'Refresh fleet')}
        >
          {loading ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw aria-hidden />}
        </Button>
      </header>
      <Suspense fallback={null}>
        <ObjectiveEnrollmentSheet open={newRunSheetOpen} onOpenChange={setNewRunSheetOpen} />
      </Suspense>
      {fleetError ? (
        <p
          className="shrink-0 border-b border-status-warning-border bg-status-warning-background px-4 py-2 text-xs text-status-warning-foreground"
          role="status"
        >
          {translate(
            'fork.heimdall.page.staleError',
            'Fleet refresh failed; showing the last confirmed snapshot: {{error}}',
            { error: fleetError }
          )}
        </p>
      ) : null}
      <div
        className={
          wideDetailLayout && selectedRow
            ? 'grid min-h-0 flex-1 grid-cols-[minmax(0,1.35fr)_minmax(360px,0.85fr)]'
            : 'grid min-h-0 flex-1 grid-cols-1'
        }
      >
        <section
          className={
            selectedRow && !wideDetailLayout
              ? 'hidden min-h-0 overflow-y-auto p-4 scrollbar-sleek md:p-6'
              : 'min-h-0 overflow-y-auto p-4 scrollbar-sleek md:p-6'
          }
          aria-label={translate('fork.heimdall.fleet.title', 'Watcher fleet')}
        >
          <HeimdallFleetList
            rows={rows}
            asOfMs={snapshot?.generatedAtMs ?? 0}
            selected={selectedTarget}
            onSelect={selectWatcher}
          />
          <HeimdallFleetActivity
            actions={actions}
            loading={historyLoading}
            partialFailures={historyFailures}
            asOfMs={historyAsOf}
          />
        </section>
        {selectedRow ? (
          <aside className={wideDetailLayout ? 'min-h-0 border-l border-border' : 'min-h-0'}>
            <HeimdallDetailPane row={selectedRow} onBack={() => selectWatcher(null)} />
          </aside>
        ) : null}
      </div>
    </main>
  )
}
