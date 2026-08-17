import type { WorkspaceVisibleTabType } from '../../../../shared/types'

/**
 * Sets or clears a worktree's entry in an `activeTabTypeByWorktree` record.
 * `type: null` means no visible-tab-type surface is focused, which the record
 * (whose values can't be null) represents by omitting the key rather than by
 * writing a placeholder value.
 */
export function withActiveTabTypeForWorktree(
  record: Record<string, WorkspaceVisibleTabType>,
  worktreeId: string,
  type: WorkspaceVisibleTabType | null
): Record<string, WorkspaceVisibleTabType> {
  if (type === null) {
    if (!(worktreeId in record)) {
      return record
    }
    const next = { ...record }
    delete next[worktreeId]
    return next
  }
  if (record[worktreeId] === type) {
    return record
  }
  return { ...record, [worktreeId]: type }
}
