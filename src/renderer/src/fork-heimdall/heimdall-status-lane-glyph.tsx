import React from 'react'
import { Bot } from 'lucide-react'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { StateIndicatorTooltip } from '@/components/StateIndicatorTooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { WorktreeStatus } from '@/lib/worktree-status'
import { formatHeimdallAge } from './fleet-format'
import { useActiveHeimdallWatcherState } from './active-watcher-registry'
import { watcherKindLabel, watcherStatusLabel } from './watcher-status-copy'

const REPLACEABLE_STATUSES: readonly WorktreeStatus[] = ['active', 'done', 'inactive']

type HeimdallLaneGlyphProps = {
  announcement: string
  className?: string
  kindLabel: string
  stateLabel: string
  attention: boolean
  lostContact: boolean
  withTooltip?: boolean
}

function HeimdallLaneGlyph({
  announcement,
  className,
  kindLabel,
  stateLabel,
  attention,
  lostContact,
  withTooltip = true
}: HeimdallLaneGlyphProps): React.JSX.Element {
  const label = translate('fork.heimdall.indicator.tooltip', '{{kind}} · {{state}}', {
    kind: kindLabel,
    state: stateLabel
  })
  const glyph = (
    <span
      className={cn('inline-flex size-5 items-center justify-center p-0.5', className)}
      data-heimdall-watcher-lane=""
      data-heimdall-attention={attention ? '' : undefined}
    >
      <Bot
        className={cn(
          'size-[13px]',
          attention
            ? 'text-status-warning'
            : lostContact
              ? 'text-status-warning'
              : 'text-status-success'
        )}
        aria-hidden="true"
      />
      <span className="sr-only">{`${announcement} · ${label}`}</span>
    </span>
  )
  return withTooltip ? (
    <StateIndicatorTooltip label={label} side="right">
      {glyph}
    </StateIndicatorTooltip>
  ) : (
    glyph
  )
}

export function useHeimdallGlyph(
  worktreeId: string,
  status: WorktreeStatus,
  announcement: string,
  className?: string
): React.JSX.Element | null {
  const watcher = useActiveHeimdallWatcherState(worktreeId)
  if (!watcher) {
    return null
  }
  const attention = watcher.attention
  if (!attention && !REPLACEABLE_STATUSES.includes(status)) {
    return null
  }
  const lostContact = watcher.contact === 'unverifiable' || watcher.state === 'unreachable'
  return (
    <HeimdallLaneGlyph
      announcement={announcement}
      className={className}
      kindLabel={watcherKindLabel(watcher.kind)}
      stateLabel={
        lostContact
          ? translate(
              'fork.heimdall.indicator.lostContact',
              'Host unreachable · last confirmed {{age}}',
              { age: formatHeimdallAge(watcher.observedAtMs) }
            )
          : watcherStatusLabel(watcher.state)
      }
      attention={attention}
      lostContact={lostContact}
    />
  )
}

/** The legacy lane already owns a tooltip, so clone only the fork glyph without its tooltip. */
export function withHeimdallGlyph(
  glyph: React.JSX.Element | null,
  status: WorktreeStatus
): React.JSX.Element {
  const laneGlyph =
    glyph?.type === HeimdallLaneGlyph
      ? React.cloneElement(glyph as React.ReactElement<HeimdallLaneGlyphProps>, {
          withTooltip: false
        })
      : glyph
  return (
    <span className="transition-opacity group-hover/unread:opacity-0 group-focus-within/unread:opacity-0">
      {laneGlyph ?? <StatusIndicator status={status} aria-hidden="true" showTooltip={false} />}
    </span>
  )
}
