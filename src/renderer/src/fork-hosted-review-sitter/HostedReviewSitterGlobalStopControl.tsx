import React, { useState } from 'react'
import { Loader2, OctagonX } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { HeimdallApi } from '../../../shared/fork-heimdall/api'

function getGlobalDisarmApi(): Pick<HeimdallApi, 'disarmAll'> | null {
  const candidate: unknown = window.api?.heimdall
  if (!candidate || typeof candidate !== 'object') {
    return null
  }
  const disarmAll = (candidate as Partial<HeimdallApi>).disarmAll
  return typeof disarmAll === 'function' ? { disarmAll } : null
}

/** Always-mounted emergency stop for all watchers, independent of review selection. */
export function HostedReviewSitterGlobalStopControl(): React.JSX.Element {
  const api = getGlobalDisarmApi()
  const [stopping, setStopping] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const disarmAll = async (): Promise<void> => {
    if (!api || stopping) {
      return
    }
    setStopping(true)
    setError(null)
    try {
      await api.disarmAll()
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message.trim()
          ? cause.message
          : translate(
              'fork.hostedReviewSitter.error.stopAllFailed',
              'PR Sitter could not stop all active sitters.'
            )
      )
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
          disabled={!api || stopping}
          onClick={() => void disarmAll()}
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
        <p className="mt-1 text-[10px] leading-relaxed text-destructive" role="alert">
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
