import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Tab, TabGroup, Worktree } from '../../../shared/types'
import { isClipboardTextByteLengthOverLimit } from '../../../shared/clipboard-text'
import type { PipelineRunSummary } from '@/store/slices/pipeline-runs'
import { selectPaletteTypeAliasMatch } from './palette-type-alias-match'
import { resolveWorktreeDisplayName } from './worktree-default-display-name'
import type { MatchRange } from './worktree-palette-search'

export type SearchablePipelineTab = {
  tab: Tab
  worktree: Worktree
  repoName: string
  worktreeSortIndex: number
  isCurrentTab: boolean
  isCurrentWorktree: boolean
  run: PipelineRunSummary | null
}

export type PipelinePaletteSearchResult = {
  /** Worktree ids collide across hosts; activation must not resolve by id alone. */
  executionHostId?: ExecutionHostId
  tabId: string
  worktreeId: string
  groupId: string
  title: string
  secondaryText: string
  repoName: string
  worktreeName: string
  titleRange: MatchRange | null
  secondaryRange: MatchRange | null
  repoRange: MatchRange | null
  worktreeRange: MatchRange | null
  typeAliasMatch?: { text: string; range: MatchRange } | null
  isCurrentTab: boolean
  isCurrentWorktree: boolean
  score: number
}

export const PIPELINE_PALETTE_QUERY_MAX_BYTES = 2 * 1024

const PIPELINE_TYPE_SEARCH_ALIASES = ['pipeline run', 'pipeline'] as const

export function isPipelinePaletteQueryTooLarge(
  query: string,
  maxBytes = PIPELINE_PALETTE_QUERY_MAX_BYTES
): boolean {
  return isClipboardTextByteLengthOverLimit(query, maxBytes)
}

export type BuildSearchablePipelineTabsOptions = {
  worktrees: readonly Worktree[]
  repoMap: ReadonlyMap<string, { displayName?: string | null }>
  worktreeOrder: ReadonlyMap<string, number>
  unifiedTabsByWorktree: Record<string, readonly Tab[] | undefined>
  activeGroupIdByWorktree: Record<string, string | undefined>
  groupsByWorktree: Record<string, readonly TabGroup[] | undefined>
  activeWorktreeId: string | null
  pipelineRunsById: Record<string, PipelineRunSummary>
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base' })
}

function findRange(text: string, query: string): MatchRange | null {
  if (!query) {
    return null
  }
  const start = text.toLowerCase().indexOf(query)
  if (start === -1) {
    return null
  }
  return { start, end: start + query.length }
}

function compareEmptyQueryResults(
  a: PipelinePaletteSearchResult,
  b: PipelinePaletteSearchResult
): number {
  if (a.isCurrentTab !== b.isCurrentTab) {
    return a.isCurrentTab ? -1 : 1
  }
  if (a.isCurrentWorktree !== b.isCurrentWorktree) {
    return a.isCurrentWorktree ? -1 : 1
  }
  if (a.score !== b.score) {
    return a.score - b.score
  }
  const worktreeCmp = compareText(a.worktreeName, b.worktreeName)
  if (worktreeCmp !== 0) {
    return worktreeCmp
  }
  return compareText(a.title, b.title)
}

function scorePipelineTabMatch({
  fieldWeight,
  matchIndex,
  entry
}: {
  fieldWeight: number
  matchIndex: number
  entry: SearchablePipelineTab
}): number {
  let score = fieldWeight + matchIndex + entry.worktreeSortIndex * 100
  if (entry.isCurrentTab) {
    score -= 40
  } else if (entry.isCurrentWorktree) {
    score -= 10
  }
  return score
}

// pipeline has no WorkspaceVisibleTabType member (deliberately not widened), so
// "current tab" is read straight off the active group instead of gating on it.
function getActivePipelineTabId({
  worktreeId,
  activeWorktreeId,
  activeGroupIdByWorktree,
  groupsByWorktree
}: Pick<
  BuildSearchablePipelineTabsOptions,
  'activeGroupIdByWorktree' | 'activeWorktreeId' | 'groupsByWorktree'
> & {
  worktreeId: string
}): string | null {
  if (activeWorktreeId !== worktreeId) {
    return null
  }
  const activeGroupId = activeGroupIdByWorktree[worktreeId]
  const activeGroup = activeGroupId
    ? (groupsByWorktree[worktreeId] ?? []).find((group) => group.id === activeGroupId)
    : undefined
  return activeGroup?.activeTabId ?? null
}

export function buildSearchablePipelineTabs({
  worktrees,
  repoMap,
  worktreeOrder,
  unifiedTabsByWorktree,
  activeGroupIdByWorktree,
  groupsByWorktree,
  activeWorktreeId,
  pipelineRunsById
}: BuildSearchablePipelineTabsOptions): SearchablePipelineTab[] {
  const entries: SearchablePipelineTab[] = []
  for (const worktree of worktrees) {
    const repoName = repoMap.get(worktree.repoId)?.displayName ?? ''
    const worktreeSortIndex = worktreeOrder.get(worktree.id) ?? Number.MAX_SAFE_INTEGER
    const activePipelineTabId = getActivePipelineTabId({
      worktreeId: worktree.id,
      activeWorktreeId,
      activeGroupIdByWorktree,
      groupsByWorktree
    })
    const tabs = unifiedTabsByWorktree[worktree.id] ?? []
    for (const tab of tabs) {
      if (tab.contentType !== 'pipeline') {
        continue
      }
      entries.push({
        tab,
        worktree,
        repoName,
        worktreeSortIndex,
        isCurrentTab: activePipelineTabId === tab.id,
        isCurrentWorktree: activeWorktreeId === worktree.id,
        run: pipelineRunsById[tab.entityId] ?? null
      })
    }
  }
  return entries
}

export function searchPipelineTabs(
  entries: SearchablePipelineTab[],
  query: string
): PipelinePaletteSearchResult[] {
  if (isPipelinePaletteQueryTooLarge(query)) {
    return []
  }
  const trimmed = query.trim()
  const trimmedQuery = trimmed.toLowerCase()
  const results: PipelinePaletteSearchResult[] = []

  for (const entry of entries) {
    // Why the run summary and not tab.label: pipelineRunsById is the single source for
    // the run's template/run-number, so a stale unified-tab label never outranks it.
    const title = entry.run
      ? `${entry.run.templateName} #${entry.run.runNumber}`
      : entry.tab.label || 'Pipeline'
    const secondaryText = ''
    // Why: a cleared display name leaves this undefined at runtime; findRange would throw.
    const worktreeName = resolveWorktreeDisplayName(entry.worktree)
    const baseResult = {
      executionHostId: entry.worktree.hostId,
      tabId: entry.tab.id,
      worktreeId: entry.worktree.id,
      groupId: entry.tab.groupId,
      title,
      secondaryText,
      repoName: entry.repoName,
      worktreeName,
      isCurrentTab: entry.isCurrentTab,
      isCurrentWorktree: entry.isCurrentWorktree
    }

    if (!trimmedQuery) {
      results.push({
        ...baseResult,
        titleRange: null,
        secondaryRange: null,
        repoRange: null,
        worktreeRange: null,
        score: entry.isCurrentTab
          ? -2
          : entry.isCurrentWorktree
            ? -1
            : entry.worktreeSortIndex * 100
      })
      continue
    }

    const titleRange = findRange(title, trimmedQuery)
    if (titleRange) {
      results.push({
        ...baseResult,
        titleRange,
        secondaryRange: null,
        repoRange: null,
        worktreeRange: null,
        score: scorePipelineTabMatch({ fieldWeight: 0, matchIndex: titleRange.start, entry })
      })
      continue
    }

    const typeAliasHit = selectPaletteTypeAliasMatch(PIPELINE_TYPE_SEARCH_ALIASES, trimmedQuery)
    if (typeAliasHit) {
      results.push({
        ...baseResult,
        titleRange: null,
        secondaryRange: null,
        repoRange: null,
        worktreeRange: null,
        typeAliasMatch: typeAliasHit,
        score: scorePipelineTabMatch({
          fieldWeight: 20,
          matchIndex: typeAliasHit.range.start,
          entry
        })
      })
      continue
    }

    const worktreeRange = findRange(worktreeName, trimmedQuery)
    if (worktreeRange) {
      results.push({
        ...baseResult,
        titleRange: null,
        secondaryRange: null,
        repoRange: null,
        worktreeRange,
        score: scorePipelineTabMatch({
          fieldWeight: 40,
          matchIndex: worktreeRange.start,
          entry
        })
      })
      continue
    }

    const repoRange = findRange(entry.repoName, trimmedQuery)
    if (repoRange) {
      results.push({
        ...baseResult,
        titleRange: null,
        secondaryRange: null,
        repoRange,
        worktreeRange: null,
        score: scorePipelineTabMatch({ fieldWeight: 60, matchIndex: repoRange.start, entry })
      })
    }
  }

  return results.sort((a, b) => {
    if (!trimmedQuery) {
      return compareEmptyQueryResults(a, b)
    }
    if (a.score !== b.score) {
      return a.score - b.score
    }
    return compareEmptyQueryResults(a, b)
  })
}
