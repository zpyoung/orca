import React, { useState } from 'react'
import { Loader2, OctagonX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { getHeimdallControlApi } from '@/fork-heimdall/heimdall-control-api'
import { isActiveHeimdallWatcher } from '@/fork-heimdall/active-watcher-registry'

/** Always-mounted emergency stop for all hosted-review watchers, routed through each owner fence. */
export function HostedReviewSitterGlobalStopControl(): React.JSX.Element {
  const api = getHeimdallControlApi()
  const fleet = useAppStore((state) => state.heimdallFleet)
  const hydrateFleet = useAppStore((state) => state.hydrateHeimdallFleet)
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const activeRows =
    fleet?.entries.filter(
      (row) => row.entry.enrollment.kind === 'hosted-review' && isActiveHeimdallWatcher(row.entry)
    ) ?? []

  const disarmActiveSitters = async (): Promise<void> => {
    if (!api || stopping || activeRows.length === 0) {
      return
    }
    setStopping(true)
    setError(null)
    try {
      const settled = await Promise.allSettled(
        activeRows.map((row) =>
          Promise.resolve().then(() =>
            api.command({
              target: row.target,
              expectedOwner: row.ownerFence,
              command: { kind: 'disarm' }
            })
          )
        )
      )
      const results = settled.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value] : []
      )
      const refused = results.filter((result) => result.status === 'refused').length
      const indeterminate =
        results.filter((result) => result.status === 'indeterminate').length +
        settled.filter((result) => result.status === 'rejected').length
      const outcomes: string[] = []
      if (indeterminate > 0) {
        outcomes.push(
          translate(
            'fork.heimdall.command.stopAllIndeterminate',
            '{{count}} stop commands may or may not have applied. Owner state is being re-read.',
            { count: indeterminate }
          )
        )
      }
      if (refused > 0) {
        outcomes.push(
          translate(
            'fork.heimdall.command.stopAllRefused',
            '{{count}} owners refused the stop command.',
            { count: refused }
          )
        )
      }
      setError(outcomes.length > 0 ? outcomes.join(' ') : null)
      await hydrateFleet()
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : translate(
              'fork.hostedReviewSitter.error.stopAllFailed',
              'PR Sitter could not stop all active sitters.'
            )
      )
      await hydrateFleet()
    } finally {
      setStopping(false)
    }
  }

  return (
    <div className="shrink-0 border-b border-border bg-muted/10 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-medium text-foreground">
          {translate('fork.hostedReviewSitter.global.title', 'PR Sitter safety')}
        </span>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={!api || stopping || activeRows.length === 0}
          onClick={() => void disarmActiveSitters()}
        >
          {stopping ? <Loader2 className="animate-spin" /> : <OctagonX />}
          {api
            ? translate('fork.hostedReviewSitter.global.stopAll', 'Stop all PR Sitters')
            : translate('fork.hostedReviewSitter.global.unavailable', 'PR Sitter unavailable')}
        </Button>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">
        {translate(
          'fork.hostedReviewSitter.stopEffect',
          'Stopping prevents new actions; an in-flight provider operation may finish.'
        )}
      </p>
      {error ? (
        <p className="mt-1 text-[10px] leading-relaxed text-status-warning" role="status">
          {error}
        </p>
      ) : null}
    </div>
  )
}

/** Keeps the checks-panel seam free of fork-owned layout and control logic. */
export function withHostedReviewSitterStopControl(content: React.ReactNode): React.JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <HostedReviewSitterGlobalStopControl />
      {content}
    </div>
  )
}
