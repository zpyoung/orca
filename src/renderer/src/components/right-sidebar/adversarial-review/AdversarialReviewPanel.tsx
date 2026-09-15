import { useEffect, useState, useSyncExternalStore } from 'react'
import { Play, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import type { Finding } from '../../../../../shared/review/finding-schema'
import { ReviewFindingRow } from './ReviewFindingRow'
import { ReviewRunHeader } from './ReviewRunHeader'
import type {
  ReviewFixAgentSession,
  ReviewLaunchRequest,
  ReviewPanelRun,
  ReviewRunTailSource
} from './adversarial-review-model'
import { useReviewRunTail } from './useReviewRunTail'
import { AdversarialReviewLaunchDialog } from './AdversarialReviewLaunchDialog'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import { translate } from '@/i18n/i18n'
import {
  consumeAdversarialReviewLaunchRequest,
  getAdversarialReviewLaunchRequestVersion,
  subscribeAdversarialReviewLaunchRequests,
  type AdversarialReviewLaunchPreset
} from './adversarial-review-launch-request'

const EMPTY_RUNS: ReviewPanelRun[] = []
const EMPTY_SESSIONS: ReviewFixAgentSession[] = []

export type AdversarialReviewPanelProps = {
  isVisible: boolean
  source?: ReviewRunTailSource | null
  sessions?: ReviewFixAgentSession[]
  onLaunch?: (request: ReviewLaunchRequest) => void | Promise<void>
  onAbort?: (run: ReviewPanelRun) => void | Promise<void>
  onShowDriverTerminal?: (run: ReviewPanelRun) => void
  onOpenEvidence?: (finding: Finding) => void
  onDismissFinding?: (finding: Finding, reason: string) => void | Promise<void>
  onSendFindingToAgent?: React.ComponentProps<typeof ReviewFindingRow>['onSendToAgent']
}

export function AdversarialReviewPanel({
  isVisible,
  source = null,
  sessions = EMPTY_SESSIONS,
  onLaunch,
  onAbort,
  onShowDriverTerminal,
  onOpenEvidence,
  onDismissFinding,
  onSendFindingToAgent
}: AdversarialReviewPanelProps): React.JSX.Element {
  const [launchOpen, setLaunchOpen] = useState(false)
  const [launchPreset, setLaunchPreset] = useState<AdversarialReviewLaunchPreset | null>(null)
  const selectedRunId = useAppStore((state) => state.selectedAdversarialReviewRunId)
  const setSelectedRunId = useAppStore((state) => state.setSelectedAdversarialReviewRunId)
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeWorktree = useAppStore((state) =>
    state.activeWorktreeId ? state.getKnownWorktreeById(state.activeWorktreeId) : null
  )
  const settings = useAppStore((state) => state.settings)
  const updateSettings = useAppStore((state) => state.updateSettings)
  const isFolderWorkspace = parseWorkspaceKey(activeWorktreeId ?? '')?.type === 'folder'
  const launchRequestVersion = useSyncExternalStore(
    subscribeAdversarialReviewLaunchRequests,
    getAdversarialReviewLaunchRequestVersion,
    getAdversarialReviewLaunchRequestVersion
  )
  const { snapshot, loading, error, refresh } = useReviewRunTail(source, isVisible)
  const runs = snapshot?.runs ?? EMPTY_RUNS
  const selectedRun = runs.find((run) => run.id === selectedRunId) ?? runs[0] ?? null

  useEffect(() => {
    const request = consumeAdversarialReviewLaunchRequest()
    if (request !== undefined) {
      setLaunchPreset(request)
      setLaunchOpen(true)
    }
  }, [launchRequestVersion])

  useEffect(() => {
    if (selectedRun && selectedRun.id !== selectedRunId) {
      setSelectedRunId(selectedRun.id)
    }
  }, [selectedRun, selectedRunId, setSelectedRunId])

  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={translate('adversarialReview.panel.label', 'Adversarial review')}
    >
      <header className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-[0.05em]">
          {translate('adversarialReview.panel.title', 'Adversarial review')}
        </h2>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={refresh}
          disabled={!source || loading}
          aria-label={translate('adversarialReview.panel.refresh', 'Refresh review runs')}
        >
          <RefreshCw className={loading ? 'animate-spin' : undefined} />
        </Button>
        <Button type="button" variant="outline" size="xs" onClick={() => setLaunchOpen(true)}>
          <Play className="size-3.5" />
          {translate('adversarialReview.panel.new', 'New')}
        </Button>
      </header>

      {error ? (
        <div className="border-b border-border px-3 py-2 text-xs text-destructive">{error}</div>
      ) : null}

      {runs.length > 1 ? (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border p-2 scrollbar-sleek">
          {runs.map((run) => (
            <Button
              key={run.id}
              type="button"
              variant={selectedRun?.id === run.id ? 'secondary' : 'ghost'}
              size="xs"
              onClick={() => setSelectedRunId(run.id)}
              className="font-mono"
            >
              {run.id.slice(0, 8)}
            </Button>
          ))}
        </div>
      ) : null}

      {!selectedRun ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
          <div>
            <p className="text-sm font-medium">
              {translate('adversarialReview.panel.emptyTitle', 'No review runs yet')}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {translate(
                'adversarialReview.panel.emptyDescription',
                'Launch an independent review of the current worktree, a branch, or a path.'
              )}
            </p>
          </div>
          <Button type="button" size="sm" onClick={() => setLaunchOpen(true)}>
            {translate('adversarialReview.panel.start', 'Start adversarial review')}
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
          <ReviewRunHeader run={selectedRun} />
          <div className="flex items-center gap-2 border-b border-border px-3 py-2">
            {selectedRun.state === 'running' ? (
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={!onAbort}
                onClick={() => void onAbort?.(selectedRun)}
              >
                {translate('adversarialReview.panel.abort', 'Abort')}
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={!onShowDriverTerminal}
              onClick={() => onShowDriverTerminal?.(selectedRun)}
            >
              {translate('adversarialReview.panel.showDriver', 'Show driver terminal')}
            </Button>
          </div>
          {selectedRun.findings.length === 0 ? (
            <p className="px-3 py-5 text-center text-xs text-muted-foreground">
              {selectedRun.state === 'running'
                ? translate('adversarialReview.panel.running', 'Review is still running…')
                : translate('adversarialReview.panel.noFindings', 'No findings')}
            </p>
          ) : (
            selectedRun.findings.map((finding, index) => (
              <ReviewFindingRow
                key={finding.id || `${finding.category}-${index}`}
                finding={finding}
                sessions={sessions}
                onOpenEvidence={onOpenEvidence}
                onDismiss={onDismissFinding}
                onSendToAgent={onSendFindingToAgent}
              />
            ))
          )}
        </div>
      )}
      <AdversarialReviewLaunchDialog
        open={launchOpen}
        onOpenChange={setLaunchOpen}
        isFolderWorkspace={isFolderWorkspace}
        initialTargetKind={launchPreset?.targetKind ?? (isFolderWorkspace ? 'path' : 'worktree')}
        initialTarget={
          launchPreset?.target ?? (isFolderWorkspace ? (activeWorktree?.path ?? '') : 'WORKTREE')
        }
        settings={settings}
        launchDisabledReason={
          onLaunch ? null : 'Review runtime is not available for this workspace.'
        }
        onLaunch={async (request) => {
          if (onLaunch) {
            await onLaunch(request)
          }
        }}
        onSaveDefaults={(adversarialReview) => updateSettings({ adversarialReview })}
      />
    </section>
  )
}

export default AdversarialReviewPanel
