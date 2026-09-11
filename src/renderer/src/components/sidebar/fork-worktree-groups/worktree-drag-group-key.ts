import { LOOSE_WORKTREE_SECTION_KEY_SUFFIX } from './worktree-loose-group-membership'

export function needsWorktreeDragGroup(currentKey: string | null, sectionKey: string): boolean {
  return (
    currentKey === null ||
    (currentKey !== sectionKey && sectionKey.endsWith(LOOSE_WORKTREE_SECTION_KEY_SUFFIX))
  )
}
