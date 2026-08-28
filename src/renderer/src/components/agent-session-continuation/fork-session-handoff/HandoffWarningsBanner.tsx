import { AlertTriangle, KeyRound, RefreshCw, Server, Timer, TriangleAlert } from 'lucide-react'
import type { DetachStaleReason } from '@/lib/fork-session-handoff/handoff-preview-detach'
import type { SecretScanHit } from '@/lib/fork-session-handoff/handoff-secret-scan'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
export type HandoffDialogWarning =
  | { kind: 'source-busy' }
  | { kind: 'host-changed' }
  | { kind: 'secret-hits'; hits: SecretScanHit[] }
  | { kind: 'transcript-unreachable' }
  | { kind: 'transcript-unverifiable' }
  | { kind: 'no-transcript-context' }
  | { kind: 'diff-truncated' }
  | { kind: 'no-context' }
  | { kind: 'stale-preview'; reasons: DetachStaleReason[] }
  | { kind: 'operation-error'; message: string }

type HandoffWarningsBannerProps = {
  warnings: HandoffDialogWarning[]
  waitingForIdle: boolean
  onWaitForIdle: () => void
  onCaptureAnyway: () => void
}

export function HandoffWarningsBanner({
  warnings,
  waitingForIdle,
  onWaitForIdle,
  onCaptureAnyway
}: HandoffWarningsBannerProps): React.JSX.Element | null {
  if (warnings.length === 0) {
    return null
  }
  return (
    <section
      className="space-y-2 rounded-md border border-border bg-muted/40 px-3 py-2"
      aria-label={translate(
        'components.agentSessionContinuation.forkSessionHandoff.warnings',
        'Handoff warnings'
      )}
      aria-live="polite"
    >
      {warnings.map((warning) => (
        <WarningRow
          key={
            warning.kind === 'operation-error' ? `${warning.kind}-${warning.message}` : warning.kind
          }
          warning={warning}
          waitingForIdle={waitingForIdle}
          onWaitForIdle={onWaitForIdle}
          onCaptureAnyway={onCaptureAnyway}
        />
      ))}
    </section>
  )
}

function WarningRow({
  warning,
  waitingForIdle,
  onWaitForIdle,
  onCaptureAnyway
}: {
  warning: HandoffDialogWarning
  waitingForIdle: boolean
  onWaitForIdle: () => void
  onCaptureAnyway: () => void
}): React.JSX.Element {
  if (warning.kind === 'source-busy') {
    return (
      <div className="flex items-start gap-2 text-xs">
        <Timer aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1 space-y-1.5">
          <p>
            {waitingForIdle
              ? translate(
                  'components.agentSessionContinuation.forkSessionHandoff.waitingForIdle',
                  'Waiting for the source session to go idle. You can still start now.'
                )
              : translate(
                  'components.agentSessionContinuation.forkSessionHandoff.sourceBusy',
                  'The source Agent is working. Capture now or wait for newer context.'
                )}
          </p>
          <div className="flex flex-wrap gap-1.5">
            <Button
              type="button"
              variant="outline"
              size="xs"
              disabled={waitingForIdle}
              onClick={onWaitForIdle}
            >
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.waitForIdle',
                'Wait for idle'
              )}
            </Button>
            <Button type="button" variant="ghost" size="xs" onClick={onCaptureAnyway}>
              {translate(
                'components.agentSessionContinuation.forkSessionHandoff.captureAnyway',
                'Capture anyway'
              )}
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const { icon, message, destructive } = warningPresentation(warning)
  return (
    <div
      className={
        destructive
          ? 'flex items-start gap-2 text-xs text-destructive'
          : 'flex items-start gap-2 text-xs'
      }
      role={destructive ? 'alert' : undefined}
    >
      {icon}
      <span className="min-w-0 flex-1">{message}</span>
    </div>
  )
}

function warningPresentation(warning: Exclude<HandoffDialogWarning, { kind: 'source-busy' }>): {
  icon: React.JSX.Element
  message: string
  destructive: boolean
} {
  switch (warning.kind) {
    case 'host-changed':
      return row(
        <Server aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />,
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.hostChanged',
          'The brief will be sent to a different execution host.'
        )
      )
    case 'secret-hits':
      return row(
        <KeyRound aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />,
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.secretHits',
          '{{count}} potential secrets found. Review the inline preview markers before starting.',
          { count: warning.hits.length }
        ),
        true
      )
    case 'transcript-unreachable':
      return row(
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />,
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.transcriptUnreachable',
          'The transcript is not reachable from the target. A bounded capture will be used when available.'
        )
      )
    case 'transcript-unverifiable':
      return row(
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />,
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.transcriptUnverifiable',
          'The transcript could not be verified on the target. A bounded capture will be used when available.'
        )
      )
    case 'no-transcript-context':
      return row(
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />,
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.noTranscriptContext',
          'No transcript context will travel. The brief uses repository state, status hints, and your note only.'
        )
      )
    case 'diff-truncated':
      return row(
        <AlertTriangle
          aria-hidden="true"
          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
        />,
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.diffTruncated',
          'Diff bodies were truncated at the character cap.'
        )
      )
    case 'no-context':
      return row(
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />,
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.noContext',
          'Add a steering note or include session or repository context before starting.'
        ),
        true
      )
    case 'stale-preview':
      return row(
        <RefreshCw aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />,
        translate(
          'components.agentSessionContinuation.forkSessionHandoff.stalePreview',
          'The edited preview is stale relative to newer controls, target data, or session context.'
        )
      )
    case 'operation-error':
      return row(
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" />,
        warning.message,
        true
      )
  }
}

function row(
  icon: React.JSX.Element,
  message: string,
  destructive = false
): { icon: React.JSX.Element; message: string; destructive: boolean } {
  return { icon, message, destructive }
}
