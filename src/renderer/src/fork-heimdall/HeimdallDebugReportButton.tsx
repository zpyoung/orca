import { useEffect, useState } from 'react'
import { Check, ClipboardCopy, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { assertClipboardTextWriteWithinLimitWithYield } from '../../../shared/clipboard-text'
import type { WatcherTarget } from '../../../shared/fork-heimdall/fleet-types'
import { getHeimdallControlApi } from './heimdall-control-api'

function describeCopyError(cause: unknown): string {
  const detail =
    cause instanceof Error && cause.message.trim()
      ? cause.message.trim()
      : typeof cause === 'string' && cause.trim()
        ? cause.trim()
        : null
  return detail
    ? translate(
        'fork.heimdall.debugReport.copyErrorWithDetail',
        'Could not copy the debug report: {{error}}',
        { error: detail }
      )
    : translate('fork.heimdall.debugReport.copyError', 'Could not copy the debug report.')
}

export function HeimdallDebugReportButton({
  target
}: {
  target: WatcherTarget
}): React.JSX.Element {
  const [copying, setCopying] = useState(false)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = window.setTimeout(() => setCopied(false), 2_000)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copyDebugReport = async (): Promise<void> => {
    if (copying) {
      return
    }
    setCopying(true)
    setCopied(false)
    setError(null)
    try {
      const api = getHeimdallControlApi()
      if (!api) {
        throw new Error(
          translate('fork.heimdall.error.unavailable', 'Heimdall control plane is unavailable.')
        )
      }
      const report = await api.debugReport({
        watcherId: target.watcherId,
        connectionId: target.connectionId,
        pairingRevision: target.pairingRevision
      })
      const serialized = JSON.stringify(report, null, 2)
      const text = await assertClipboardTextWriteWithinLimitWithYield(serialized ?? String(report))
      await window.api.ui.writeClipboardText(text)
      setCopied(true)
    } catch (cause) {
      setError(describeCopyError(cause))
    } finally {
      setCopying(false)
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={copying}
        onClick={() => void copyDebugReport()}
      >
        {copying ? (
          <Loader2 className="animate-spin" aria-hidden />
        ) : copied ? (
          <Check aria-hidden />
        ) : (
          <ClipboardCopy aria-hidden />
        )}
        {copied
          ? translate('fork.heimdall.debugReport.copied', 'Debug report copied')
          : translate('fork.heimdall.debugReport.copy', 'Copy debug report')}
      </Button>
      {error ? (
        <p className="max-w-64 text-right text-xs leading-snug text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  )
}
