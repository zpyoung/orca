import { describe, expect, it } from 'vitest'
import type { Repo } from '../../../../../shared/repo-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  filterWorktreesByActivity,
  type WorkspaceActivityFilterContext
} from './workspace-activity-filter'

const DAY = 86_400_000
const NOW = 30 * DAY
const repo = { id: 'repo', path: '/repo', addedAt: 2 * DAY } as Repo
const baseWorktree = {
  id: 'workspace',
  repoId: 'repo',
  hostId: 'ssh:hostA',
  path: '/repo/.worktrees/workspace',
  lastActivityAt: 0,
  createdAt: undefined
} as unknown as Worktree

function context(
  overrides: Partial<WorkspaceActivityFilterContext> = {}
): WorkspaceActivityFilterContext {
  return {
    workspaceActivityWindow: 'week',
    workspaceActivityCustomDays: 30,
    lastVisitedAtByWorktreeId: {},
    workspaceActivityExitStamps: {},
    selectedWorkspaceId: null,
    selectedHostId: null,
    now: NOW,
    ...overrides
  }
}

function filter(
  worktree: Worktree,
  overrides: Partial<WorkspaceActivityFilterContext> = {}
): Worktree[] {
  return filterWorktreesByActivity([worktree], context(overrides), new Map([[repo.id, repo]]))
}

describe('filterWorktreesByActivity', () => {
  it('includes the week boundary and hides one millisecond older', () => {
    expect(filter({ ...baseWorktree, lastActivityAt: 23 * DAY } as Worktree)).toHaveLength(1)
    expect(filter({ ...baseWorktree, lastActivityAt: 23 * DAY - 1 } as Worktree)).toHaveLength(0)
  })

  it('uses the newer of activity and visit timestamps', () => {
    expect(
      filter({ ...baseWorktree, lastActivityAt: 1 * DAY } as Worktree, {
        lastVisitedAtByWorktreeId: { 'ssh:hostA|workspace': 29 * DAY }
      })
    ).toHaveLength(1)
  })

  it('counts a departure stamp as activity without touching focus recency', () => {
    expect(
      filter({ ...baseWorktree, lastActivityAt: 1 * DAY } as Worktree, {
        workspaceActivityExitStamps: { 'ssh:hostA|workspace': 29 * DAY }
      })
    ).toHaveLength(1)
  })

  it('reads an unqualified local row from the bare exit-stamp key', () => {
    const unqualified = { ...baseWorktree, hostId: undefined, lastActivityAt: 1 * DAY } as Worktree
    expect(
      filter(unqualified, { workspaceActivityExitStamps: { workspace: 29 * DAY } })
    ).toHaveLength(1)
  })

  it('falls back from createdAt to the repository added date', () => {
    expect(filter({ ...baseWorktree, createdAt: 24 * DAY } as Worktree)).toHaveLength(1)
    expect(filter({ ...baseWorktree, createdAt: undefined } as Worktree)).toHaveLength(0)
  })

  it('includes future activity and exempts only the selected host-qualified workspace', () => {
    expect(filter({ ...baseWorktree, lastActivityAt: NOW + DAY } as Worktree)).toHaveLength(1)
    const sameIdOtherHost = { ...baseWorktree, hostId: 'ssh:hostB', lastActivityAt: 0 } as Worktree
    expect(
      filter(sameIdOtherHost, { selectedWorkspaceId: 'workspace', selectedHostId: 'ssh:hostA' })
    ).toHaveLength(0)
  })

  it('exempts the selected workspace when either side is host-unqualified', () => {
    // a local row carries no hostId while the activation records 'local'
    const unqualified = { ...baseWorktree, hostId: undefined, lastActivityAt: 0 } as Worktree
    expect(
      filter(unqualified, { selectedWorkspaceId: 'workspace', selectedHostId: 'local' })
    ).toHaveLength(1)
    // an activation that passed no host records null while the row is qualified
    expect(
      filter({ ...baseWorktree, lastActivityAt: 0 } as Worktree, {
        selectedWorkspaceId: 'workspace',
        selectedHostId: null
      })
    ).toHaveLength(1)
  })
})
