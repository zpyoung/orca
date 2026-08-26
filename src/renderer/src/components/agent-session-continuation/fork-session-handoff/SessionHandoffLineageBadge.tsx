import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { ArrowRight } from 'lucide-react'
import { useShallow } from 'zustand/react/shallow'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import {
  activateAndRevealFolderWorkspace,
  activateAndRevealWorktree
} from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { getIndexedWorktreesById } from '@/store/worktree-repo-index'
import { resolveOriginalPaneTarget } from '@/components/right-sidebar/ai-vault-original-pane'
import type {
  ForkHandoffRelationship,
  ForkSessionHandoffLineageRecord,
  LineageEndpointIdentity
} from '../../../../../shared/fork-session-handoff/session-lineage-types'
import { parsePaneKey } from '../../../../../shared/stable-pane-id'
import { parseWorkspaceKey } from '../../../../../shared/workspace-scope'
import {
  enrichSessionLineage,
  getSessionLineageSnapshot,
  listSessionLineage,
  subscribeSessionLineage
} from '@/lib/fork-session-handoff/session-lineage-actions'

export type SessionLineageMatch = {
  record: ForkSessionHandoffLineageRecord
  side: 'parent' | 'child'
  target: LineageEndpointIdentity
}

type LiveLineageState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'sleepingAgentSessionsByPaneKey'
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
>

function newestMatch(
  records: readonly ForkSessionHandoffLineageRecord[],
  predicate: (record: ForkSessionHandoffLineageRecord) => 'parent' | 'child' | null
): SessionLineageMatch | null {
  let match: SessionLineageMatch | null = null
  for (const record of records) {
    const side = predicate(record)
    if (!side || (match && match.record.createdAt >= record.createdAt)) {
      continue
    }
    match = {
      record,
      side,
      target: side === 'parent' ? record.child : record.parent
    }
  }
  return match
}

function providerIdentityMatches(
  endpoint: LineageEndpointIdentity,
  agent: string | null,
  providerSessionId: string | null
): boolean {
  return Boolean(
    endpoint.agent &&
    endpoint.providerSessionId &&
    endpoint.agent === agent &&
    endpoint.providerSessionId === providerSessionId
  )
}

export function findAgentSessionLineage(
  records: readonly ForkSessionHandoffLineageRecord[],
  paneKey: string,
  identity: { agent: string | null; providerSessionId: string | null; soleTabPane?: boolean }
): SessionLineageMatch | null {
  const paneMatch = newestMatch(records, (record) => {
    if (record.parent.paneKey === paneKey) {
      return 'parent'
    }
    return record.child.paneKey === paneKey ? 'child' : null
  })
  if (paneMatch) {
    return paneMatch
  }

  // Why: a record whose child pane is still unobserved can only be placed by its tab, which
  // every pane of a split tab shares — claiming it there would attribute lineage to the
  // wrong pane and persist that guess through enrichment.
  const tabId = identity.soleTabPane === true ? (parsePaneKey(paneKey)?.tabId ?? null) : null
  const pendingChildMatch = newestMatch(records, (record) => {
    if (
      tabId !== null &&
      record.child.paneKey === null &&
      record.child.tabId === tabId &&
      (!record.child.agent || record.child.agent === identity.agent)
    ) {
      return 'child'
    }
    return null
  })
  if (pendingChildMatch) {
    return pendingChildMatch
  }

  return newestMatch(records, (record) => {
    if (providerIdentityMatches(record.parent, identity.agent, identity.providerSessionId)) {
      return 'parent'
    }
    return providerIdentityMatches(record.child, identity.agent, identity.providerSessionId)
      ? 'child'
      : null
  })
}

function resolveLineagePaneCandidate(
  state: LiveLineageState,
  paneKey: string,
  worktreeIdHint?: string,
  tabIdHint?: string
): ReturnType<typeof resolveOriginalPaneTarget> {
  return resolveOriginalPaneTarget({ state, paneKey, worktreeIdHint, tabIdHint })
}

export function resolveLiveLineagePane(
  state: LiveLineageState,
  endpoint: LineageEndpointIdentity
): ReturnType<typeof resolveOriginalPaneTarget> {
  if (endpoint.paneKey) {
    const direct = resolveLineagePaneCandidate(
      state,
      endpoint.paneKey,
      endpoint.worktreeId ?? undefined
    )
    if (direct) {
      return direct
    }
  }

  if (!endpoint.agent || !endpoint.providerSessionId) {
    return null
  }

  for (const entry of Object.values(state.agentStatusByPaneKey ?? {})) {
    if (
      !providerIdentityMatches(endpoint, entry.agentType ?? null, entry.providerSession?.id ?? null)
    ) {
      continue
    }
    const target = resolveLineagePaneCandidate(state, entry.paneKey, entry.worktreeId, entry.tabId)
    if (target) {
      return target
    }
  }

  for (const retained of Object.values(state.retainedAgentsByPaneKey ?? {})) {
    if (
      !providerIdentityMatches(
        endpoint,
        retained.agentType,
        retained.entry.providerSession?.id ?? null
      )
    ) {
      continue
    }
    const target = resolveLineagePaneCandidate(
      state,
      retained.entry.paneKey,
      retained.worktreeId,
      retained.entry.tabId ?? retained.tab.id
    )
    if (target) {
      return target
    }
  }

  for (const record of Object.values(state.sleepingAgentSessionsByPaneKey ?? {})) {
    if (!providerIdentityMatches(endpoint, record.agent, record.providerSession.id)) {
      continue
    }
    const target = resolveLineagePaneCandidate(
      state,
      record.paneKey,
      record.worktreeId,
      record.tabId
    )
    if (target) {
      return target
    }
  }

  return null
}

export function useSessionLineageRecords(): readonly ForkSessionHandoffLineageRecord[] {
  const records = useSyncExternalStore(
    subscribeSessionLineage,
    getSessionLineageSnapshot,
    getSessionLineageSnapshot
  )
  useEffect(() => {
    void listSessionLineage()
  }, [])
  return records
}

export function useLiveLineagePaneKey(endpoint: LineageEndpointIdentity | null): string | null {
  return useAppStore((state) =>
    endpoint ? (resolveLiveLineagePane(state, endpoint)?.paneKey ?? null) : null
  )
}

export function useLineageWorktreeRemoved(endpoint: LineageEndpointIdentity | null): boolean {
  return useAppStore((state) => {
    if (!endpoint?.worktreeId) {
      return false
    }
    const workspaceScope = parseWorkspaceKey(endpoint.worktreeId)
    if (workspaceScope?.type === 'folder') {
      if (
        state.folderWorkspaces.some(
          (workspace) => workspace.id === workspaceScope.folderWorkspaceId
        )
      ) {
        return false
      }
      return state.hasHydratedWorktreePurge
    }
    if (!state.hasHydratedWorktreePurge) {
      return false
    }
    return getIndexedWorktreesById(state.worktreesByRepo, endpoint.worktreeId).length === 0
  })
}

export function activateLineageEndpoint(endpoint: LineageEndpointIdentity): void {
  const target = resolveLiveLineagePane(useAppStore.getState(), endpoint)
  if (!target) {
    return
  }
  const workspaceScope = parseWorkspaceKey(target.worktreeId)
  const activationResult =
    workspaceScope?.type === 'folder'
      ? activateAndRevealFolderWorkspace(workspaceScope.folderWorkspaceId)
      : activateAndRevealWorktree(target.worktreeId)
  if (!activationResult) {
    return
  }
  useAppStore.getState().setActiveTabType('terminal')
  activateTabAndFocusPane(target.tabId, target.leafId, {
    flashFocusedPane: true,
    scrollToBottomIfOutputSinceLastView: true
  })
}

function relationshipText(relationship: ForkHandoffRelationship): string {
  if (relationship === 'branches-from') {
    return translate('forkSessionHandoff.lineage.relationship.branchesFrom', 'branches from')
  }
  if (relationship === 'reviews') {
    return translate('forkSessionHandoff.lineage.relationship.reviews', 'reviews')
  }
  return translate('forkSessionHandoff.lineage.relationship.continues', 'continues')
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

export function SessionHandoffLineageBadge({ paneKey }: { paneKey: string }) {
  const records = useSessionLineageRecords()
  const identity = useAppStore(
    useShallow((state) => {
      const live = state.agentStatusByPaneKey?.[paneKey]
      const retained = state.retainedAgentsByPaneKey?.[paneKey]
      const entry = live ?? retained?.entry
      const tabId = parsePaneKey(paneKey)?.tabId ?? null
      const layout = tabId ? state.terminalLayoutsByTabId?.[tabId] : null
      return {
        agent: entry?.agentType ?? retained?.agentType ?? null,
        providerSessionId: entry?.providerSession?.id ?? null,
        soleTabPane: Object.keys(layout?.ptyIdsByLeafId ?? {}).length === 1
      }
    })
  )
  const match = useMemo(
    () => findAgentSessionLineage(records, paneKey, identity),
    [identity, paneKey, records]
  )
  const liveTargetPaneKey = useLiveLineagePaneKey(match?.target ?? null)
  const worktreeRemoved = useLineageWorktreeRemoved(match?.target ?? null)

  useEffect(() => {
    if (!match || match.side !== 'child') {
      return
    }
    const live = useAppStore.getState().agentStatusByPaneKey?.[paneKey]
    const paneKeyPatch = match.record.child.paneKey === null ? paneKey : undefined
    const providerSessionId =
      match.record.child.providerSessionId === null ? live?.providerSession?.id : undefined
    if (!paneKeyPatch && !providerSessionId) {
      return
    }
    void enrichSessionLineage({
      recordId: match.record.id,
      paneKey: paneKeyPatch,
      providerSessionId
    })
  }, [match, paneKey])

  if (!match) {
    return null
  }

  const targetTitle = endpointTitle(match.target)
  const canJump = Boolean(liveTargetPaneKey) && !worktreeRemoved
  const unavailableText = worktreeRemoved
    ? translate('forkSessionHandoff.lineage.worktreeRemoved', 'worktree removed')
    : translate('forkSessionHandoff.lineage.noLivePane', 'No live pane is available.')
  const prefix =
    match.side === 'parent'
      ? translate('forkSessionHandoff.lineage.handedOff', 'Handed off')
      : translate('forkSessionHandoff.lineage.fromHandoff', 'From handoff')

  return (
    <span
      data-testid="session-handoff-lineage-badge"
      className="inline-flex h-5 max-w-36 shrink-0 items-center overflow-hidden rounded-sm border border-border/70 bg-background text-[10px] font-medium leading-none text-muted-foreground"
      title={`${prefix} · ${relationshipText(match.record.relationship)}`}
      onClick={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <span className="min-w-0 truncate px-1">
        {prefix} · {relationshipText(match.record.relationship)}
      </span>
      {worktreeRemoved ? (
        <span className="shrink-0 border-l border-border/70 px-1 text-muted-foreground/75">
          {unavailableText}
        </span>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              className="inline-flex size-5 shrink-0 items-center justify-center border-l border-border/70 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-disabled:cursor-not-allowed aria-disabled:opacity-50 aria-disabled:hover:bg-transparent aria-disabled:hover:text-muted-foreground"
              aria-label={
                match.side === 'parent'
                  ? translate(
                      'forkSessionHandoff.lineage.jumpToChild',
                      'Jump to handed-off session'
                    )
                  : translate('forkSessionHandoff.lineage.jumpToParent', 'Jump to source session')
              }
              aria-disabled={!canJump}
              onClick={(event) => {
                event.stopPropagation()
                if (canJump) {
                  activateLineageEndpoint(match.target)
                }
              }}
            >
              <ArrowRight className="size-3" aria-hidden />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {canJump ? targetTitle : unavailableText}
          </TooltipContent>
        </Tooltip>
      )}
    </span>
  )
}
