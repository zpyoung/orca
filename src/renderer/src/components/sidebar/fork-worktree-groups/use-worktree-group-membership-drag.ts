import { useCallback, useMemo, useState } from 'react'
import type React from 'react'
import { useAppStore } from '@/store'
import { measureProjectGroupHeaderDragRects } from '../project-group-header-drop'
import type { VirtualizedWorktreeViewportProps } from '../worktree-list/viewport/viewport-props'
import type { WorktreePointerDrag } from '../worktree-list/drag/row-state'
import { canWorktreeHoldGroupMembership } from '../../../../../shared/fork-worktree-groups/worktree-group-membership'
import {
  areWorktreeGroupMembershipDragPreviewsEqual,
  getPointerWorktreeGroupMembershipDragPreview,
  WORKTREE_GROUP_MEMBERSHIP_DRAG_PREVIEW_NONE,
  type WorktreeGroupMembershipDragPreview
} from './worktree-group-membership-drag-preview'

export type WorktreeGroupMembershipDrag = ReturnType<typeof useWorktreeGroupMembershipDrag>

/**
 * The pointer-drag surface of drag-to-join/leave a Project Group: the preview
 * state the header highlight renders from, the drag-start gate, the per-frame
 * tracker, and the release commit.
 */
export function useWorktreeGroupMembershipDrag(args: {
  scrollRef: React.RefObject<HTMLDivElement | null>
  viewport: Pick<
    VirtualizedWorktreeViewportProps,
    'groupBy' | 'worktreeMap' | 'repoMap' | 'projectGrouping'
  >
}) {
  const { scrollRef } = args
  const { groupBy, worktreeMap, repoMap, projectGrouping } = args.viewport
  const updateWorktreeMeta = useAppStore((s) => s.updateWorktreeMeta)
  const [preview, setPreview] = useState<WorktreeGroupMembershipDragPreview>(
    WORKTREE_GROUP_MEMBERSHIP_DRAG_PREVIEW_NONE
  )

  const resetPreview = useCallback(() => {
    setPreview((prev) =>
      areWorktreeGroupMembershipDragPreviewsEqual(prev, WORKTREE_GROUP_MEMBERSHIP_DRAG_PREVIEW_NONE)
        ? prev
        : WORKTREE_GROUP_MEMBERSHIP_DRAG_PREVIEW_NONE
    )
  }, [])

  // Why: the reorder gate treats a lone row as having nowhere to drag, but
  // group membership gives it somewhere — leaving its group, or joining one.
  const canStartDrag = useCallback(
    (container: HTMLElement, worktreeId: string): boolean => {
      const draggedWorktree = worktreeMap.get(worktreeId)
      return (
        groupBy === 'repo' &&
        canWorktreeHoldGroupMembership({
          // Folder-workspace rows never reach here — they are absent from worktreeMap,
          // so the lookup above misses before this gate matters.
          folderWorkspaceId: null,
          repoKind: repoMap.get(draggedWorktree?.repoId ?? '')?.kind
        }) &&
        (draggedWorktree?.projectGroupId != null ||
          measureProjectGroupHeaderDragRects(container).length > 0)
      )
    },
    [groupBy, repoMap, worktreeMap]
  )

  const trackPointerDragFrame = useCallback(
    (drag: WorktreePointerDrag): boolean => {
      const membershipPreview = getPointerWorktreeGroupMembershipDragPreview({
        container: scrollRef.current,
        clientX: drag.currentX,
        clientY: drag.currentY,
        draggedIds: drag.draggedIds,
        worktreeId: drag.worktreeId,
        worktreeMap,
        repoMap,
        projectGrouping
      })
      setPreview((prev) =>
        areWorktreeGroupMembershipDragPreviewsEqual(prev, membershipPreview)
          ? prev
          : membershipPreview
      )
      return membershipPreview.target.kind !== 'none'
    },
    [projectGrouping, repoMap, scrollRef, worktreeMap]
  )

  const commitPointerDrop = useCallback(
    (event: PointerEvent, drag: WorktreePointerDrag): boolean => {
      const target = getPointerWorktreeGroupMembershipDragPreview({
        container: scrollRef.current,
        clientX: event.clientX,
        clientY: event.clientY,
        draggedIds: drag.draggedIds,
        worktreeId: drag.worktreeId,
        worktreeMap,
        repoMap,
        projectGrouping
      }).target
      if (target.kind === 'join') {
        void updateWorktreeMeta(drag.worktreeId, { projectGroupId: target.groupId })
        return true
      }
      if (target.kind === 'leave') {
        void updateWorktreeMeta(drag.worktreeId, { projectGroupId: null })
        return true
      }
      return false
    },
    [projectGrouping, repoMap, scrollRef, updateWorktreeMeta, worktreeMap]
  )

  return useMemo(
    () => ({ preview, resetPreview, canStartDrag, trackPointerDragFrame, commitPointerDrop }),
    [canStartDrag, commitPointerDrop, preview, resetPreview, trackPointerDragFrame]
  )
}
