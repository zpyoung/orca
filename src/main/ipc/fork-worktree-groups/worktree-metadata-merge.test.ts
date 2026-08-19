import { describe, expect, it } from 'vitest'
import type { WorktreeMeta } from '../../../shared/types'
import { mergeWorktree } from '../worktree-metadata-merge'

const baseMeta: WorktreeMeta = {
  displayName: 'Feature',
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}

describe('mergeWorktree projectGroupId', () => {
  const baseGit = {
    path: '/workspaces/feature',
    head: 'abc123',
    branch: 'refs/heads/feature-x',
    isBare: false,
    isMainWorktree: false
  }

  it('defaults to null when meta is undefined', () => {
    const result = mergeWorktree('repo1', baseGit, undefined)
    expect(result.projectGroupId).toBeNull()
  })

  it('defaults to null when meta is present but omits the key', () => {
    const result = mergeWorktree('repo1', baseGit, { ...baseMeta })
    expect(result.projectGroupId).toBeNull()
  })

  it('carries through a string group id', () => {
    const result = mergeWorktree('repo1', baseGit, { ...baseMeta, projectGroupId: 'group-1' })
    expect(result.projectGroupId).toBe('group-1')
  })

  it('preserves an explicit null', () => {
    const result = mergeWorktree('repo1', baseGit, { ...baseMeta, projectGroupId: null })
    expect(result.projectGroupId).toBeNull()
  })
})
