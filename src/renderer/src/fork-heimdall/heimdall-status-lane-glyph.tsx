import React from 'react'
import { Bot } from 'lucide-react'
import StatusIndicator from '@/components/sidebar/StatusIndicator'
import { StateIndicatorTooltip } from '@/components/StateIndicatorTooltip'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type { WorktreeStatus } from '@/lib/worktree-status'
import type { WatcherKindId, WatcherStatusState } from '../../../shared/fork-heimdall/watcher-types'
import { useActiveHeimdallWatcherState } from './active-watcher-registry'

// These statuses carry no live agent condition of their own, so a watcher may own the lane.
const REPLACEABLE_STATUSES = new Set<WorktreeStatus>(['active', 'done', 'inactive'])

function watcherKindLabel(kind: WatcherKindId): string {
  switch (kind) {
    case 'hosted-review':
      return translate('fork.hostedReviewSitter.title', 'PR Sitter')
    case 'objective':
      return translate('fork.heimdall.kind.objective', 'Objective watcher')
  }
}

function watcherStatusLabel(state: WatcherStatusState): string {
  switch (state) {
    case 'watching':
      return translate('fork.heimdall.status.watching', 'Watching')
    case 'held':
      return translate('fork.heimdall.status.held', 'Held')
    case 'acting':
      return translate('fork.heimdall.status.acting', 'Acting')
    case 'escalated':
      return translate('fork.heimdall.status.escalated', 'Escalated')
    case 'parked':
      return translate('fork.heimdall.status.parked', 'Parked')
    case 'terminal':
      return translate('fork.heimdall.status.terminal', 'Complete')
    case 'disabled':
      return translate('fork.heimdall.status.disabled', 'Stopped')
    case 'unreachable':
      return translate('fork.heimdall.status.unreachable', 'Host unreachable')
  }
}

export function useHeimdallGlyph(
  worktreeId: string,
  status: WorktreeStatus,
  announcement: string,
  className?: string
): React.JSX.Element | null {
  const watcher = useActiveHeimdallWatcherState(worktreeId)
  if (!watcher || !REPLACEABLE_STATUSES.has(status)) {
    return null
  }
  const label = translate('fork.heimdall.indicator.tooltip', '{{kind}} · {{state}}', {
    kind: watcherKindLabel(watcher.kind),
    state: watcherStatusLabel(watcher.state)
  })
  return (
    <StateIndicatorTooltip label={label} side="right">
      <span
        className={cn('inline-flex size-5 items-center justify-center p-0.5', className)}
        data-heimdall-watcher-lane=""
      >
        <Bot
          className={cn(
            'size-[13px]',
            status === 'done' || status === 'active'
              ? 'text-status-success'
              : 'text-muted-foreground/40'
          )}
          aria-hidden="true"
        />
        <span className="sr-only">{`${announcement} · ${label}`}</span>
      </span>
    </StateIndicatorTooltip>
  )
}

/** Preserves the legacy hover lane while keeping the watcher glyph decision fork-owned. */
export function withHeimdallGlyph(
  glyph: React.JSX.Element | null,
  status: WorktreeStatus
): React.JSX.Element {
  return (
    <span className="transition-opacity group-hover/unread:opacity-0 group-focus-within/unread:opacity-0">
      {glyph ?? <StatusIndicator status={status} aria-hidden="true" showTooltip={false} />}
    </span>
  )
}
