import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getProjectHeaderRevealTarget, type ProjectGroupingModel } from '../worktree-list-groups'
import { measureProjectHeaderDragRects } from '../project-header-drop'
import { measureProjectGroupHeaderDragRects } from '../project-group-header-drop'
import {
  findWorktreeOwnProjectHeaderRect,
  getWorktreeGroupMembershipDropTarget,
  type WorktreeGroupMembershipDropTarget
} from './worktree-group-membership-drop'

// Why: pairs the hit-test result with the dragged worktree's repoId so the
// render pass can tell "leave" apart from "join" without re-deriving it.
export type WorktreeGroupMembershipDragPreview = {
  target: WorktreeGroupMembershipDropTarget
  repoId: string | null
}

export const WORKTREE_GROUP_MEMBERSHIP_DRAG_PREVIEW_NONE: WorktreeGroupMembershipDragPreview = {
  target: { kind: 'none' },
  repoId: null
}

export function areWorktreeGroupMembershipDragPreviewsEqual(
  a: WorktreeGroupMembershipDragPreview,
  b: WorktreeGroupMembershipDragPreview
): boolean {
  if (a.repoId !== b.repoId || a.target.kind !== b.target.kind) {
    return false
  }
  return a.target.kind === 'join' && b.target.kind === 'join'
    ? a.target.groupId === b.target.groupId
    : true
}

// Why: measureProject{,Group}HeaderDragRects report a header's LOGICAL content
// position, which is what header reordering needs but is scrolled out of view for
// the header that is currently pinned — so hit-testing a pointer against it never
// matches the pinned header the user is actually pointing at. Returns the painted
// position, in the same content space, for the pinned headers only.
function measureStickySidebarHeaderContentRects(
  container: HTMLElement,
  containerRect: DOMRect,
  idAttribute: string
): Map<string, { top: number; bottom: number }> {
  const rectsById = new Map<string, { top: number; bottom: number }>()
  container
    .querySelectorAll<HTMLElement>(`[data-worktree-sticky-header-active] [${idAttribute}]`)
    .forEach((element) => {
      const id = element.getAttribute(idAttribute)
      if (!id) {
        return
      }
      const rect = element.getBoundingClientRect()
      const top = rect.top - containerRect.top + container.scrollTop
      rectsById.set(id, { top, bottom: top + rect.height })
    })
  return rectsById
}

// Why: the hit-test module speaks for a single worktree; a multi-select drag
// has no well-defined "current group" to compare against, so it opts out
// entirely rather than silently reparenting only the primary card.
export function getPointerWorktreeGroupMembershipDragPreview(args: {
  container: HTMLElement | null
  clientX: number
  clientY: number
  draggedIds: readonly string[]
  worktreeId: string
  worktreeMap: ReadonlyMap<string, Worktree>
  repoMap: Map<string, Repo>
  projectGrouping?: ProjectGroupingModel
}): WorktreeGroupMembershipDragPreview {
  if (!args.container || args.draggedIds.length !== 1) {
    return WORKTREE_GROUP_MEMBERSHIP_DRAG_PREVIEW_NONE
  }
  // Why: header hit-testing below is vertical-only and pointerup is a
  // window-capture listener, so without a containment check a release far
  // outside the sidebar still commits a membership change whenever it shares a
  // header's y. Same guard shape as getPointerDropStatusTarget.
  const pointerTarget = document.elementFromPoint(args.clientX, args.clientY)
  if (!(pointerTarget instanceof Element) || !args.container.contains(pointerTarget)) {
    return WORKTREE_GROUP_MEMBERSHIP_DRAG_PREVIEW_NONE
  }
  const draggedWorktree = args.worktreeMap.get(args.worktreeId)
  if (!draggedWorktree) {
    return WORKTREE_GROUP_MEMBERSHIP_DRAG_PREVIEW_NONE
  }
  const containerRect = args.container.getBoundingClientRect()
  const pointerY = args.clientY - containerRect.top + args.container.scrollTop
  const stickyGroupHeaderRects = measureStickySidebarHeaderContentRects(
    args.container,
    containerRect,
    'data-project-group-header-id'
  )
  const stickyProjectHeaderRects = measureStickySidebarHeaderContentRects(
    args.container,
    containerRect,
    'data-repo-header-id'
  )
  const groupHeaderRects = measureProjectGroupHeaderDragRects(args.container).map((rect) => ({
    groupId: rect.groupId,
    ...(stickyGroupHeaderRects.get(rect.groupId) ?? { top: rect.top, bottom: rect.bottom })
  }))
  const projectHeaderRects = measureProjectHeaderDragRects(args.container)
  const ownRepoHeaderRect = findWorktreeOwnProjectHeaderRect({
    rects: projectHeaderRects,
    ownProjectHeaderKey: getProjectHeaderRevealTarget(
      draggedWorktree.repoId,
      args.repoMap,
      args.projectGrouping
    ).key,
    projectHeaderKeyByRepoId: new Map(
      projectHeaderRects.map((rect) => [
        rect.repoId,
        getProjectHeaderRevealTarget(rect.repoId, args.repoMap, args.projectGrouping).key
      ])
    )
  })
  const target = getWorktreeGroupMembershipDropTarget({
    pointerY,
    groupHeaderRects,
    draggedWorktree,
    ownRepoKind: args.repoMap.get(draggedWorktree.repoId)?.kind,
    ownRepoSectionRect: ownRepoHeaderRect
      ? (stickyProjectHeaderRects.get(ownRepoHeaderRect.repoId) ?? {
          top: ownRepoHeaderRect.top,
          bottom: ownRepoHeaderRect.bottom
        })
      : null
  })
  // Why: the leave highlight draws on the header actually hit-tested, which for
  // a merged logical project is the anchor repo rather than the dragged one.
  return { target, repoId: ownRepoHeaderRect?.repoId ?? null }
}
