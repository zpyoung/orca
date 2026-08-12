import { describe, expect, it } from 'vitest'
import type { ProjectGroup, Repo, Worktree } from '../../../../shared/types'
import { getEmptyProjectPlaceholderRepoIds } from './empty-project-placeholder-repos'

const projectGroup: ProjectGroup = {
  id: 'group-1',
  name: 'Group',
  parentPath: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 0,
  updatedAt: 0
}

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Project',
  badgeColor: '#000000',
  addedAt: 1
}

const worktree: Worktree = {
  id: 'wt-1',
  repoId: repo.id,
  path: '/repo/wt-1',
  displayName: 'main',
  branch: 'refs/heads/main',
  head: 'abc123',
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

describe('getEmptyProjectPlaceholderRepoIds', () => {
  it('returns empty repo placeholders in repo grouping without project groups', () => {
    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: { [repo.id]: [] },
          visibleWorktrees: [],
          filterRepoIds: [],
          projectGroups: []
        })
      )
    ).toEqual([repo.id])
  })

  it('treats missing worktreesByRepo keys as empty for the current render', () => {
    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: {},
          visibleWorktrees: [],
          filterRepoIds: [],
          projectGroups: []
        })
      )
    ).toEqual([repo.id])
  })

  it('applies repo filters to empty placeholder candidates', () => {
    const selectedRepo = { ...repo, id: 'repo-selected' }
    const hiddenRepo = { ...repo, id: 'repo-hidden' }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [selectedRepo, hiddenRepo],
          worktreesByRepo: { [selectedRepo.id]: [], [hiddenRepo.id]: [] },
          visibleWorktrees: [],
          filterRepoIds: [selectedRepo.id],
          projectGroups: []
        })
      )
    ).toEqual([selectedRepo.id])
  })

  it('does not create placeholders outside repo grouping', () => {
    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'none',
        repos: [repo],
        worktreesByRepo: { [repo.id]: [] },
        visibleWorktrees: [],
        filterRepoIds: [],
        projectGroups: []
      }).size
    ).toBe(0)
  })

  it('does not treat non-empty repos as empty when workspace filters hide their rows', () => {
    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'repo',
        repos: [repo],
        worktreesByRepo: { [repo.id]: [worktree] },
        visibleWorktrees: [],
        filterRepoIds: [],
        projectGroups: []
      }).size
    ).toBe(0)
  })

  it('keeps grouped repos visible when workspace filters hide all of their rows', () => {
    const groupedRepo: Repo = { ...repo, projectGroupId: 'group-1' }
    const groupedWorktree: Worktree = { ...worktree, repoId: groupedRepo.id }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [groupedRepo],
          worktreesByRepo: { [groupedRepo.id]: [groupedWorktree] },
          visibleWorktrees: [],
          filterRepoIds: [],
          projectGroups: []
        })
      )
    ).toEqual([groupedRepo.id])
  })

  it('does not create a grouped repo placeholder when one of its workspaces is visible', () => {
    const groupedRepo: Repo = { ...repo, projectGroupId: 'group-1' }
    const groupedWorktree: Worktree = { ...worktree, repoId: groupedRepo.id }

    expect(
      getEmptyProjectPlaceholderRepoIds({
        groupBy: 'repo',
        repos: [groupedRepo],
        worktreesByRepo: { [groupedRepo.id]: [groupedWorktree] },
        visibleWorktrees: [groupedWorktree],
        filterRepoIds: [],
        projectGroups: []
      }).size
    ).toBe(0)
  })

  it('still respects explicit project filters for sleep-filtered grouped members', () => {
    const selected: Repo = { ...repo, id: 'repo-selected', projectGroupId: 'group-1' }
    const filteredOut: Repo = { ...repo, id: 'repo-hidden', projectGroupId: 'group-1' }
    const selectedWt: Worktree = { ...worktree, id: 'wt-selected', repoId: selected.id }
    const hiddenWt: Worktree = { ...worktree, id: 'wt-hidden', repoId: filteredOut.id }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [selected, filteredOut],
          worktreesByRepo: {
            [selected.id]: [selectedWt],
            [filteredOut.id]: [hiddenWt]
          },
          // Why: simulate Hide sleeping removing every card while the project
          // filter still intentionally excludes `filteredOut`.
          visibleWorktrees: [],
          filterRepoIds: [selected.id],
          projectGroups: []
        })
      )
    ).toEqual([selected.id])
  })

  it('placeholders only the fully-filtered members of a multi-project group', () => {
    const sleeping: Repo = { ...repo, id: 'repo-sleeping', projectGroupId: 'group-1' }
    const awake: Repo = { ...repo, id: 'repo-awake', projectGroupId: 'group-1' }
    const sleepingWt: Worktree = { ...worktree, id: 'wt-sleeping', repoId: sleeping.id }
    const awakeWt: Worktree = { ...worktree, id: 'wt-awake', repoId: awake.id }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [sleeping, awake],
          worktreesByRepo: {
            [sleeping.id]: [sleepingWt],
            [awake.id]: [awakeWt]
          },
          visibleWorktrees: [awakeWt],
          filterRepoIds: [],
          projectGroups: []
        })
      )
    ).toEqual([sleeping.id])
  })

  it('does not placeholder ungrouped neighbors of a filtered grouped member', () => {
    const grouped: Repo = { ...repo, id: 'repo-grouped', projectGroupId: 'group-1' }
    const ungrouped: Repo = { ...repo, id: 'repo-ungrouped' }
    const groupedWt: Worktree = { ...worktree, id: 'wt-grouped', repoId: grouped.id }
    const ungroupedWt: Worktree = { ...worktree, id: 'wt-ungrouped', repoId: ungrouped.id }

    expect(
      Array.from(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [grouped, ungrouped],
          worktreesByRepo: {
            [grouped.id]: [groupedWt],
            [ungrouped.id]: [ungroupedWt]
          },
          visibleWorktrees: [],
          filterRepoIds: [],
          projectGroups: []
        })
      )
    ).toEqual([grouped.id])
  })

  describe('repos fully grouped elsewhere via worktree-level projectGroupId', () => {
    it('flags a repo whose only visible worktree is grouped elsewhere', () => {
      const groupedWt: Worktree = { ...worktree, projectGroupId: projectGroup.id }

      expect(
        Array.from(
          getEmptyProjectPlaceholderRepoIds({
            groupBy: 'repo',
            repos: [repo],
            worktreesByRepo: { [repo.id]: [groupedWt] },
            visibleWorktrees: [groupedWt],
            filterRepoIds: [],
            projectGroups: [projectGroup]
          })
        )
      ).toEqual([repo.id])
    })

    it('does not flag a repo with one grouped and one ungrouped visible worktree', () => {
      const groupedWt: Worktree = { ...worktree, id: 'wt-grouped', projectGroupId: projectGroup.id }
      const ungroupedWt: Worktree = { ...worktree, id: 'wt-ungrouped' }

      expect(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: { [repo.id]: [groupedWt, ungroupedWt] },
          visibleWorktrees: [groupedWt, ungroupedWt],
          filterRepoIds: [],
          projectGroups: [projectGroup]
        }).size
      ).toBe(0)
    })

    it('does not newly flag a repo whose visible worktrees are all hidden by a host filter (vacuous every guard)', () => {
      expect(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: { [repo.id]: [worktree] },
          // Why: `[].every(...)` is vacuously true; ownVisible.length > 0 must
          // gate isFullyGroupedElsewhere so a host-hidden repo isn't newly
          // flagged as a placeholder. hasNoWorktrees already covers the
          // genuinely empty repo.
          visibleWorktrees: [],
          filterRepoIds: [],
          projectGroups: [projectGroup]
        }).size
      ).toBe(0)
    })

    it('does not treat a projectGroupId naming a nonexistent group as grouped', () => {
      const ghostGroupedWt: Worktree = { ...worktree, projectGroupId: 'ghost-group' }

      expect(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: { [repo.id]: [ghostGroupedWt] },
          visibleWorktrees: [ghostGroupedWt],
          filterRepoIds: [],
          // Why: `ghost-group` does not exist in projectGroups, so it must not
          // count as "grouped elsewhere".
          projectGroups: []
        }).size
      ).toBe(0)
    })

    it('does not flag a repo whose only visible worktree names a group filtered out by the host filter', () => {
      const crossHostGroupedWt: Worktree = { ...worktree, projectGroupId: 'ssh-prod-group' }

      expect(
        getEmptyProjectPlaceholderRepoIds({
          groupBy: 'repo',
          repos: [repo],
          worktreesByRepo: { [repo.id]: [crossHostGroupedWt] },
          visibleWorktrees: [crossHostGroupedWt],
          filterRepoIds: [],
          // Why: mirrors the caller passing `visibleProjectGroupsForRows`
          // (host-filtered) rather than the full project-group list. A group
          // owned by a hidden host ("ssh-prod-group") can still hold a
          // locally-visible worktree, but filterProjectGroupsForVisibleHosts
          // keys on the GROUP's own host, so it is absent here even though it
          // exists in the store. buildRows can't find it either, so this
          // criterion must agree and NOT flag the repo.
          projectGroups: []
        }).size
      ).toBe(0)
    })
  })
})
