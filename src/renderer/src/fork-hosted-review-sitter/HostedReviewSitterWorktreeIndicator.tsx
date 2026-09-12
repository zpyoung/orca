import React from 'react'
import { Bot } from 'lucide-react'
import { cn } from '@/lib/utils'
import { StateIndicatorTooltip } from '@/components/StateIndicatorTooltip'
import { translate } from '@/i18n/i18n'
import type { HostedReviewSitterStatusState } from '../../../shared/fork-hosted-review-sitter/types'
import { useActiveHostedReviewSitterState } from './active-sitter-registry'
import { hostedReviewSitterStatusLabel } from './hosted-review-sitter-format'

const ATTENTION_STATES = new Set<HostedReviewSitterStatusState>([
  'escalated',
  'budget-exhausted',
  'held'
])

/**
 * Sidebar pip marking a worktree whose PR Sitter is armed.
 *
 * Renders nothing when no sitter owns the worktree, so it costs one empty node per card in the
 * common case. Sits beside the upstream agent-status dot rather than inside it: sitter activity and
 * agent activity are independent axes, and a worktree can be idle while its sitter is acting.
 */
export function HostedReviewSitterWorktreeIndicator({
  worktreeId,
  className
}: {
  worktreeId: string
  className?: string
}): React.JSX.Element | null {
  const state = useActiveHostedReviewSitterState(worktreeId)
  if (!state) {
    return null
  }
  const label = translate('fork.hostedReviewSitter.indicator.tooltip', 'PR Sitter · {{state}}', {
    state: hostedReviewSitterStatusLabel(state)
  })
  return (
    <StateIndicatorTooltip label={label} side="right">
      <span
        className={cn('inline-flex h-3 w-3 shrink-0 items-center justify-center', className)}
        data-hosted-review-sitter-indicator=""
      >
        <Bot
          className={cn(
            'size-3',
            ATTENTION_STATES.has(state) ? 'text-destructive' : 'text-emerald-500'
          )}
          aria-hidden="true"
        />
        <span className="sr-only">{label}</span>
      </span>
    </StateIndicatorTooltip>
  )
}
