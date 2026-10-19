import { describe, expect, it } from 'vitest'
import {
  getDivertedWorktreeProjectGroupId,
  getLooseSectionProjectGroupId,
  isLooseProjectGroupTopRow
} from './worktree-loose-group-membership'

describe('loose worktree group membership', () => {
  it('only diverts worktrees to groups that are rendered', () => {
    const worktree = { id: 'worktree-1', projectGroupId: 'group-1' } as never
    expect(getDivertedWorktreeProjectGroupId(worktree, new Map())).toBeNull()
    expect(getDivertedWorktreeProjectGroupId(worktree, new Map([['group-1', {} as never]]))).toBe(
      'group-1'
    )
  })

  it('identifies top-level loose sections', () => {
    expect(getLooseSectionProjectGroupId('project-group:group-1::loose')).toBe('group-1')
    expect(isLooseProjectGroupTopRow('project-group:group-1::loose', false)).toBe(true)
  })
})
