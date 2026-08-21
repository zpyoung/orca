import { describe, expect, it } from 'vitest'
import type { ProjectGroup } from '../../../../../shared/project-group-types'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { getEmptyProjectPlaceholderRepoIds } from '../empty-project-placeholder-repos'

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: 1
}
const group: ProjectGroup = {
  id: 'group-1',
  name: 'Group',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}
const worktree: Worktree = {
  id: 'wt-1',
  repoId: repo.id,
  path: '/repo/wt',
  displayName: 'main',
  branch: 'main',
  head: '1',
  isBare: false,
  isMainWorktree: true,
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

function placeholders(own: Worktree[], visible: Worktree[], groups: ProjectGroup[]) {
  return getEmptyProjectPlaceholderRepoIds({
    groupBy: 'repo',
    repos: [repo],
    worktreesByRepo: { [repo.id]: own },
    visibleWorktrees: visible,
    filterRepoIds: [],
    projectGroups: groups
  })
}

describe('empty project placeholders for loose group members', () => {
  it('flags a repo whose only visible worktree is in a rendered group', () => {
    const grouped = { ...worktree, projectGroupId: group.id }
    expect([...placeholders([grouped], [grouped], [group])]).toEqual([repo.id])
  })

  it('keeps a repo with an ungrouped visible worktree out of placeholders', () => {
    const grouped = { ...worktree, id: 'grouped', projectGroupId: group.id }
    const ungrouped = { ...worktree, id: 'ungrouped' }
    expect(placeholders([grouped, ungrouped], [grouped, ungrouped], [group])).toHaveLength(0)
  })

  it('does not newly flag a host-hidden repo with no visible worktrees', () => {
    expect(placeholders([worktree], [], [group])).toHaveLength(0)
  })

  it.each([
    ['missing group', 'missing', []],
    ['host-filtered group', 'ssh-group', []]
  ])('does not count a %s as grouped elsewhere', (_name, projectGroupId, groups) => {
    const grouped = { ...worktree, projectGroupId }
    expect(placeholders([grouped], [grouped], groups)).toHaveLength(0)
  })
})
