import { describe, expect, it } from 'vitest'
import {
  clearMissingProjectGroupMemberships,
  createProjectGroup,
  getEffectiveProjectGroupManualRank,
  getNextProjectGroupOrder,
  getProjectGroupSubtreeIds,
  normalizeProjectGroupName,
  normalizeProjectGroups
} from './project-groups'
import type { Repo } from './types'

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: overrides.id ?? 'repo-1',
    path: overrides.path ?? '/repo',
    displayName: overrides.displayName ?? 'repo',
    badgeColor: '#999',
    addedAt: 1,
    kind: 'git',
    ...overrides
  }
}

/** Walks parentGroupId from every group and fails if any walk cannot reach a root (null) or loops. */
function assertAllGroupsReachRoot(
  groups: readonly { id: string; parentGroupId: string | null }[]
): void {
  const byId = new Map(groups.map((group) => [group.id, group]))
  for (const start of groups) {
    const seen = new Set<string>()
    let current: { id: string; parentGroupId: string | null } | undefined = start
    while (current) {
      expect(seen.has(current.id)).toBe(false)
      seen.add(current.id)
      if (current.parentGroupId === null) {
        break
      }
      current = byId.get(current.parentGroupId)
    }
    expect(current).toBeDefined()
  }
}

describe('project-groups', () => {
  it('creates a durable project group with normalized defaults', () => {
    const group = createProjectGroup({
      name: '  Platform  ',
      parentPath: '/srv/platform',
      createdFrom: 'folder-scan',
      tabOrder: 3,
      now: 100
    })

    expect(group).toMatchObject({
      name: 'Platform',
      parentPath: '/srv/platform',
      parentGroupId: null,
      createdFrom: 'folder-scan',
      tabOrder: 3,
      isCollapsed: false,
      color: null,
      createdAt: 100,
      updatedAt: 100
    })
  })

  it('trims empty group names to a fallback', () => {
    expect(normalizeProjectGroupName('   ', 'Existing')).toBe('Existing')
  })

  it('normalizes persisted groups and drops malformed entries', () => {
    const groups = normalizeProjectGroups([
      { id: 'b', name: 'B', tabOrder: 2 },
      {
        id: 'a',
        name: 'A',
        tabOrder: 1,
        parentGroupId: 'missing',
        createdFrom: 'folder-scan',
        isCollapsed: true
      },
      { id: 'a', name: 'duplicate' },
      { name: 'missing id' }
    ])

    expect(groups.map((group) => group.id)).toEqual(['a', 'b'])
    expect(groups[0]).toMatchObject({
      createdFrom: 'folder-scan',
      isCollapsed: true,
      parentGroupId: null
    })
  })

  it('clears a self-referencing parent and a parent naming a nonexistent group', () => {
    const groups = normalizeProjectGroups([
      { id: 'self', name: 'Self', tabOrder: 0, parentGroupId: 'self' },
      { id: 'orphan', name: 'Orphan', tabOrder: 1, parentGroupId: 'ghost' }
    ])

    expect(groups.find((group) => group.id === 'self')?.parentGroupId).toBeNull()
    expect(groups.find((group) => group.id === 'orphan')?.parentGroupId).toBeNull()
  })

  it('breaks a two-node parent cycle so both groups become reachable from a root', () => {
    const groups = normalizeProjectGroups([
      { id: 'a', name: 'A', tabOrder: 0, parentGroupId: 'b' },
      { id: 'b', name: 'B', tabOrder: 1, parentGroupId: 'a' }
    ])

    assertAllGroupsReachRoot(groups)
    expect(groups.some((group) => group.parentGroupId === null)).toBe(true)
  })

  it('breaks a longer parent cycle (A -> B -> C -> A) so every group is reachable from a root', () => {
    const groups = normalizeProjectGroups([
      { id: 'a', name: 'A', tabOrder: 0, parentGroupId: 'b' },
      { id: 'b', name: 'B', tabOrder: 1, parentGroupId: 'c' },
      { id: 'c', name: 'C', tabOrder: 2, parentGroupId: 'a' }
    ])

    assertAllGroupsReachRoot(groups)
    expect(groups.some((group) => group.parentGroupId === null)).toBe(true)
  })

  it('returns a valid group tree completely unchanged', () => {
    const groups = normalizeProjectGroups([
      { id: 'root', name: 'Root', tabOrder: 0, parentGroupId: null },
      { id: 'child', name: 'Child', tabOrder: 1, parentGroupId: 'root' },
      { id: 'grandchild', name: 'Grandchild', tabOrder: 2, parentGroupId: 'child' }
    ])

    expect(groups.find((group) => group.id === 'root')?.parentGroupId).toBeNull()
    expect(groups.find((group) => group.id === 'child')?.parentGroupId).toBe('root')
    expect(groups.find((group) => group.id === 'grandchild')?.parentGroupId).toBe('child')
  })

  it('breaks a two-node parent cycle when one group id is the empty string', () => {
    const groups = normalizeProjectGroups([
      { id: '', name: 'Empty', tabOrder: 0, parentGroupId: 'b' },
      { id: 'b', name: 'B', tabOrder: 1, parentGroupId: '' }
    ])

    assertAllGroupsReachRoot(groups)
    expect(groups.some((group) => group.parentGroupId === null)).toBe(true)
  })

  it('clears a parent naming a nonexistent empty-string group id', () => {
    const groups = normalizeProjectGroups([
      { id: 'orphan', name: 'Orphan', tabOrder: 0, parentGroupId: '' }
    ])

    expect(groups.find((group) => group.id === 'orphan')?.parentGroupId).toBeNull()
  })

  it('preserves an empty-string group id as a legitimate root', () => {
    const groups = normalizeProjectGroups([
      { id: '', name: 'Root', tabOrder: 0, parentGroupId: null },
      { id: 'child', name: 'Child', tabOrder: 1, parentGroupId: '' }
    ])

    expect(groups.find((group) => group.id === '')?.parentGroupId).toBeNull()
    expect(groups.find((group) => group.id === 'child')?.parentGroupId).toBe('')
  })

  it('normalizes a cycle alongside a group with a missing parent without throwing', () => {
    const groups = normalizeProjectGroups([
      { id: 'a', name: 'A', tabOrder: 0, parentGroupId: 'b' },
      { id: 'b', name: 'B', tabOrder: 1, parentGroupId: 'a' },
      { id: 'c', name: 'C', tabOrder: 2, parentGroupId: 'ghost' }
    ])

    expect(groups.find((group) => group.id === 'c')?.parentGroupId).toBeNull()
    assertAllGroupsReachRoot(groups)
  })

  it('preserves normalized execution ownership for persisted groups', () => {
    const groups = normalizeProjectGroups([
      { id: 'runtime', name: 'Runtime', tabOrder: 1, executionHostId: 'runtime:env-1' },
      { id: 'local', name: 'Local', tabOrder: 2, executionHostId: 'local' },
      { id: 'invalid', name: 'Invalid', tabOrder: 3, executionHostId: 'runtime:' }
    ])

    expect(groups.find((group) => group.id === 'runtime')?.executionHostId).toBe('runtime:env-1')
    expect(groups.find((group) => group.id === 'local')?.executionHostId).toBe('local')
    expect(groups.find((group) => group.id === 'invalid')?.executionHostId).toBeUndefined()
  })

  it('clears repo memberships whose group no longer exists', () => {
    const groups = [createProjectGroup({ name: 'Known', createdFrom: 'manual', tabOrder: 0 })]
    const repos = clearMissingProjectGroupMemberships(
      [
        repo({ id: 'known', projectGroupId: groups[0].id }),
        repo({ id: 'missing', projectGroupId: 'x' })
      ],
      groups
    )

    expect(repos.find((entry) => entry.id === 'known')?.projectGroupId).toBe(groups[0].id)
    expect(repos.find((entry) => entry.id === 'missing')?.projectGroupId).toBeNull()
  })

  it('falls back to global repo order when projectGroupOrder is unset', () => {
    const repoOrder = new Map([
      ['a', 0],
      ['b', 2]
    ])

    expect(
      getEffectiveProjectGroupManualRank(repo({ id: 'a', projectGroupOrder: 5 }), repoOrder)
    ).toBe(5)
    expect(getEffectiveProjectGroupManualRank(repo({ id: 'a' }), repoOrder)).toBe(0)
    expect(getEffectiveProjectGroupManualRank(repo({ id: 'b' }), repoOrder)).toBe(2000)
    expect(getEffectiveProjectGroupManualRank(repo({ id: 'c' }), repoOrder, 1)).toBe(1000)
  })

  it('computes the next order inside a group independently from ungrouped repos', () => {
    expect(
      getNextProjectGroupOrder(
        [
          repo({ id: 'a', projectGroupId: 'g', projectGroupOrder: 2 }),
          repo({ id: 'b', projectGroupId: null, projectGroupOrder: 9 })
        ],
        'g'
      )
    ).toBe(3)
  })

  it('collects descendant group ids for subtree deletion', () => {
    expect(
      [
        ...getProjectGroupSubtreeIds(
          [
            { id: 'root', parentGroupId: null },
            { id: 'child', parentGroupId: 'root' },
            { id: 'grandchild', parentGroupId: 'child' },
            { id: 'sibling', parentGroupId: null }
          ],
          'root'
        )
      ].sort()
    ).toEqual(['child', 'grandchild', 'root'])
  })

  it('collects wide descendant groups without overflowing argument limits', () => {
    const groups = [
      { id: 'root', parentGroupId: null },
      ...Array.from({ length: 130_000 }, (_, index) => ({
        id: `child-${index}`,
        parentGroupId: 'root'
      }))
    ]

    const subtreeIds = getProjectGroupSubtreeIds(groups, 'root')

    expect(subtreeIds.size).toBe(130_001)
    expect(subtreeIds.has('root')).toBe(true)
    expect(subtreeIds.has('child-129999')).toBe(true)
  })
})
