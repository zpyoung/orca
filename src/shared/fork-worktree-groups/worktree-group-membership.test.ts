import { describe, expect, it } from 'vitest'
import { canWorktreeHoldGroupMembership } from './worktree-group-membership'

describe('canWorktreeHoldGroupMembership', () => {
  it('rejects writes that folder workspace projections cannot retain', () => {
    expect(canWorktreeHoldGroupMembership({ folderWorkspaceId: null, repoKind: 'git' })).toBe(true)
    expect(canWorktreeHoldGroupMembership({ folderWorkspaceId: 'folder-1', repoKind: 'git' })).toBe(
      false
    )
    expect(canWorktreeHoldGroupMembership({ folderWorkspaceId: null, repoKind: 'folder' })).toBe(
      false
    )
    expect(canWorktreeHoldGroupMembership({ folderWorkspaceId: null, repoKind: undefined })).toBe(
      true
    )
  })
})
