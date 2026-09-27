import { useMemo } from 'react'
import { ArrowRight } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { AiVaultSession } from '../../../../../shared/ai-vault-types'
import type {
  ForkHandoffRelationship,
  ForkSessionHandoffLineageRecord,
  LineageEndpointIdentity
} from '../../../../../shared/fork-session-handoff/session-lineage-types'
import {
  activateLineageEndpoint,
  type SessionLineageMatch,
  useLineageWorktreeRemoved,
  useLiveLineagePaneKey,
  useSessionLineageRecords
} from './SessionHandoffLineageBadge'

function newestVaultMatch(
  records: readonly ForkSessionHandoffLineageRecord[],
  predicate: (endpoint: LineageEndpointIdentity) => boolean
): SessionLineageMatch | null {
  let match: SessionLineageMatch | null = null
  for (const record of records) {
    if (match && match.record.createdAt >= record.createdAt) {
      continue
    }
    const side = predicate(record.parent) ? 'parent' : predicate(record.child) ? 'child' : null
    if (side) {
      match = {
        record,
        side,
        target: side === 'parent' ? record.child : record.parent
      }
    }
  }
  return match
}

export function findAiVaultSessionLineage(
  records: readonly ForkSessionHandoffLineageRecord[],
  session: Pick<AiVaultSession, 'agent' | 'sessionId' | 'filePath'>
): SessionLineageMatch | null {
  const providerMatch = newestVaultMatch(
    records,
    (endpoint) =>
      endpoint.agent === session.agent && endpoint.providerSessionId === session.sessionId
  )
  if (providerMatch) {
    return providerMatch
  }
  return newestVaultMatch(
    records,
    (endpoint) => endpoint.agent === session.agent && endpoint.transcriptPath === session.filePath
  )
}

function relationshipLabel(
  side: SessionLineageMatch['side'],
  relationship: ForkHandoffRelationship
): string {
  if (side === 'parent') {
    const relationshipText =
      relationship === 'branches-from'
        ? translate('forkSessionHandoff.lineage.relationship.branchesFrom', 'branches from')
        : relationship === 'reviews'
          ? translate('forkSessionHandoff.lineage.relationship.reviews', 'reviews')
          : translate('forkSessionHandoff.lineage.relationship.continues', 'continues')
    return translate(
      'forkSessionHandoff.lineage.vault.handedOffRelationship',
      'Handed off · {{value0}}',
      { value0: relationshipText }
    )
  }
  if (relationship === 'reviews') {
    return translate('forkSessionHandoff.lineage.vault.reviews', 'Reviews')
  }
  if (relationship === 'branches-from') {
    return translate('forkSessionHandoff.lineage.vault.branchesFrom', 'Branches from')
  }
  return translate('forkSessionHandoff.lineage.vault.continuesFrom', 'Continues from')
}

function endpointTitle(endpoint: LineageEndpointIdentity): string {
  return (
    endpoint.title?.trim() ||
    (endpoint.agent
      ? translate('forkSessionHandoff.lineage.agentSession', '{{value0}} session', {
          value0: endpoint.agent
        })
      : translate('forkSessionHandoff.lineage.relatedSession', 'related session'))
  )
}

export function ForkAiVaultLineageLine({ session }: { session: AiVaultSession }) {
  const records = useSessionLineageRecords()
  const match = useMemo(() => findAiVaultSessionLineage(records, session), [records, session])
  const liveTargetPaneKey = useLiveLineagePaneKey(match?.target ?? null)
  const worktreeRemoved = useLineageWorktreeRemoved(match?.target ?? null)

  if (!match) {
    return null
  }

  const label = relationshipLabel(match.side, match.record.relationship)
  const targetTitle = endpointTitle(match.target)
  const canJump = Boolean(liveTargetPaneKey) && !worktreeRemoved
  const unavailableText = worktreeRemoved
    ? translate('forkSessionHandoff.lineage.worktreeRemoved', 'worktree removed')
    : translate('forkSessionHandoff.lineage.noLivePane', 'No live pane is available.')

  return (
    <div
      data-testid="ai-vault-lineage-line"
      className="mt-1 flex min-w-0 items-center gap-1.5 pl-5 text-[11px] leading-4 text-muted-foreground"
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="shrink-0">{label}</span>
      <ArrowRight className="size-3 shrink-0 text-muted-foreground/60" aria-hidden />
      {worktreeRemoved ? (
        <span className="min-w-0 truncate text-muted-foreground/75">{unavailableText}</span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="min-w-0 truncate rounded-sm text-left text-foreground/80 underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-disabled:cursor-not-allowed aria-disabled:text-muted-foreground/65 aria-disabled:hover:no-underline"
              aria-disabled={!canJump}
              aria-label={
                match.side === 'parent'
                  ? translate(
                      'forkSessionHandoff.lineage.jumpToChild',
                      'Jump to handed-off session'
                    )
                  : translate('forkSessionHandoff.lineage.jumpToParent', 'Jump to source session')
              }
              onClick={(event) => {
                event.stopPropagation()
                if (canJump) {
                  activateLineageEndpoint(match.target)
                }
              }}
            >
              {targetTitle}
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {canJump ? targetTitle : unavailableText}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}
