import type { RepoKind } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { canWorktreeHoldGroupMembership } from '../../../../../shared/fork-worktree-groups/worktree-group-membership'

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

/**
 * The measured repo-header rect standing in for the dragged worktree's own
 * project section.
 *
 * A logical project header merges a project's host setups under a single anchor
 * repo, and the DOM carries only that anchor's id — so matching the dragged
 * worktree's own `repoId` against the rects misses every non-anchor sibling and
 * silently makes drag-to-leave unreachable for it. Both sides are compared on
 * the logical header key the row model built the header from instead.
 */
export function findWorktreeOwnProjectHeaderRect<TRect extends { repoId: string }>(args: {
  rects: readonly TRect[]
  ownProjectHeaderKey: string
  projectHeaderKeyByRepoId: ReadonlyMap<string, string>
}): TRect | null {
  return (
    args.rects.find(
      (rect) => args.projectHeaderKeyByRepoId.get(rect.repoId) === args.ownProjectHeaderKey
    ) ?? null
  )
}

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
  ownRepoKind?: RepoKind
}): WorktreeGroupMembershipDropTarget {
  // Why: gated in the drop decision rather than at each caller so preview,
  // highlight and commit all inherit it from one place.
  if (!canWorktreeHoldGroupMembership({ folderWorkspaceId: null, repoKind: args.ownRepoKind })) {
    return { kind: 'none' }
  }
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
