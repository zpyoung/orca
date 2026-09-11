import { isSidebarSectionSeparatorEnabled } from '../../../../../shared/fork-sidebar-section-separator/sidebar-section-separator-setting'
import type { RenderRow } from '../worktree-list/listing/render-row'
import { shouldUseHeaderTopSpacing } from '../worktree-list/viewport/virtual-rows'

const SIDEBAR_SECTION_SEPARATOR_CLASS =
  'before:absolute before:inset-x-2 before:top-0 before:h-px before:bg-worktree-sidebar-border'

export function sidebarSectionSeparatorClass(args: {
  settings: Parameters<typeof isSidebarSectionSeparatorEnabled>[0]
  rows: readonly RenderRow[]
  index: number
  firstHeaderIndex: number
  isActiveStickyHeader: boolean
  projectGroupDepth?: number
}): string | false {
  const previousRow = args.rows[args.index - 1]
  if (
    !isSidebarSectionSeparatorEnabled(args.settings) ||
    !shouldUseHeaderTopSpacing(args) ||
    previousRow?.type === 'host-header' ||
    args.isActiveStickyHeader ||
    (args.projectGroupDepth ?? 0) !== 0
  ) {
    return false
  }

  // Why: a pseudo-element draws the separator without changing row layout height.
  return SIDEBAR_SECTION_SEPARATOR_CLASS
}
