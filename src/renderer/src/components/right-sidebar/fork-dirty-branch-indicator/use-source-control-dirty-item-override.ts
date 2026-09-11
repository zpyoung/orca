import { useMemo } from 'react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import type { ActivityBarItem } from '../activity-bar-buttons'
import { countDirtyWorktreeChanges } from './dirty-worktree-change-count'
import { SourceControlDirtyIcon } from './source-control-dirty-icon'

const CLEAN_OVERRIDE: Partial<ActivityBarItem> = {}

function dirtyTitle(changeCount: number, isCapped: boolean): string {
  const value0 = changeCount.toLocaleString()
  if (isCapped) {
    return translate(
      'components.rightSidebar.dirtyBranchIndicator.cappedChanges',
      'Source Control — {{value0}}+ uncommitted changes',
      { value0 }
    )
  }
  return changeCount === 1
    ? translate(
        'components.rightSidebar.dirtyBranchIndicator.oneChange',
        'Source Control — 1 uncommitted change'
      )
    : translate(
        'components.rightSidebar.dirtyBranchIndicator.manyChanges',
        'Source Control — {{value0}} uncommitted changes',
        { value0 }
      )
}

/**
 * Activity-bar overrides that mark the Source Control tab while the active
 * worktree has uncommitted changes: a dot on the glyph, and a count folded into
 * the title so the tooltip and the button's accessible name both carry it —
 * color is never the only signal.
 *
 * When git status was truncated the retained entries are a floor, not a total,
 * so the count is published as "N+" rather than as an exact figure.
 *
 * A clean worktree yields an empty override, leaving upstream's icon and title
 * exactly as they were — including when the store snapshot carries no git-status
 * maps at all, which upstream's own activity-bar renders are entitled to do.
 */
export function useSourceControlDirtyItemOverride(): Partial<ActivityBarItem> {
  const changeCount = useAppStore((s) => {
    const worktreeId = s.activeWorktreeId
    return worktreeId ? countDirtyWorktreeChanges(s.gitStatusByWorktree?.[worktreeId] ?? []) : 0
  })
  const isCapped = useAppStore((s) => {
    const worktreeId = s.activeWorktreeId
    return worktreeId ? s.gitStatusHugeByWorktree?.[worktreeId] !== undefined : false
  })

  return useMemo(
    () =>
      changeCount > 0
        ? { icon: SourceControlDirtyIcon, title: dirtyTitle(changeCount, isCapped) }
        : CLEAN_OVERRIDE,
    [changeCount, isCapped]
  )
}
