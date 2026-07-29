import type { Worktree } from '../../../../shared/types'

/** Hit-test rect for one project-group header row in the sidebar. */
export type WorktreeGroupHeaderDropRect = {
  groupId: string
  top: number
  bottom: number
}

/** Hit-test rect for the dragged worktree's own repo section — its ungrouped home. */
export type WorktreeOwnRepoSectionRect = {
  top: number
  bottom: number
}

export type WorktreeGroupMembershipDropTarget =
  | { kind: 'join'; groupId: string }
  | { kind: 'leave' }
  | { kind: 'none' }

function isPointerWithinRect(pointerY: number, rect: { top: number; bottom: number }): boolean {
  // Inclusive both edges, matching the rest of the sidebar's drag hit-testing
  // (worktree-lineage-drag-drop.ts, worktree-sidebar-header-drop-preview.ts).
  return pointerY >= rect.top && pointerY <= rect.bottom
}

/**
 * Overlapping header rects (e.g. mid-animation) resolve to the topmost one —
 * smallest `top` wins; an exact tie keeps whichever rect was measured first.
 */
function findHoveredGroupHeaderRect(
  pointerY: number,
  rects: readonly WorktreeGroupHeaderDropRect[]
): WorktreeGroupHeaderDropRect | null {
  let hovered: WorktreeGroupHeaderDropRect | null = null
  for (const rect of rects) {
    if (!isPointerWithinRect(pointerY, rect)) {
      continue
    }
    if (!hovered || rect.top < hovered.top) {
      hovered = rect
    }
  }
  return hovered
}

export function getWorktreeGroupMembershipDropTarget(args: {
  pointerY: number
  groupHeaderRects: readonly WorktreeGroupHeaderDropRect[]
  draggedWorktree: Pick<Worktree, 'id' | 'repoId' | 'projectGroupId'>
  ownRepoSectionRect: WorktreeOwnRepoSectionRect | null
}): WorktreeGroupMembershipDropTarget {
  const currentGroupId = args.draggedWorktree.projectGroupId ?? null

  // A header hit always wins over the leave check below, regardless of which
  // group it belongs to: the current group's header means none (not leave),
  // any other group's header means join. Only when no header is hit does the
  // own-repo-section rect get considered.
  const hoveredGroup = findHoveredGroupHeaderRect(args.pointerY, args.groupHeaderRects)
  if (hoveredGroup) {
    return hoveredGroup.groupId !== currentGroupId
      ? { kind: 'join', groupId: hoveredGroup.groupId }
      : { kind: 'none' }
  }

  if (
    currentGroupId !== null &&
    args.ownRepoSectionRect !== null &&
    isPointerWithinRect(args.pointerY, args.ownRepoSectionRect)
  ) {
    return { kind: 'leave' }
  }

  return { kind: 'none' }
}
