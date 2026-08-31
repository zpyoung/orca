import type { GitStatusEntry } from '../../../../../shared/git-status-types'

/**
 * Counts a worktree's own uncommitted entries for the Source Control dirty dot.
 *
 * Rows that live inside a submodule are excluded: expanding a dirty submodule
 * appends them next to the submodule's own entry, so counting both would report
 * one change twice and make the count jump on expand.
 */
export function countDirtyWorktreeChanges(entries: readonly GitStatusEntry[]): number {
  let count = 0
  for (const entry of entries) {
    if (!entry.submoduleRoot) {
      count += 1
    }
  }
  return count
}
