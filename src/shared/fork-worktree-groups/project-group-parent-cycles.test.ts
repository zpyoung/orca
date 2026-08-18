import { describe, expect, it } from 'vitest'

import { normalizeProjectGroups } from '../project-groups'

function expectEveryGroupToReachRoot(
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

describe('project group parent cycles', () => {
  it('clears self-referencing and nonexistent parents', () => {
    const groups = normalizeProjectGroups([
      { id: 'self', name: 'Self', tabOrder: 0, parentGroupId: 'self' },
      { id: 'orphan', name: 'Orphan', tabOrder: 1, parentGroupId: 'ghost' }
    ])

    expect(groups.find((group) => group.id === 'self')?.parentGroupId).toBeNull()
    expect(groups.find((group) => group.id === 'orphan')?.parentGroupId).toBeNull()
  })

  it('breaks two-node and three-node cycles', () => {
    for (const input of [
      [
        { id: 'a', name: 'A', tabOrder: 0, parentGroupId: 'b' },
        { id: 'b', name: 'B', tabOrder: 1, parentGroupId: 'a' }
      ],
      [
        { id: 'a', name: 'A', tabOrder: 0, parentGroupId: 'b' },
        { id: 'b', name: 'B', tabOrder: 1, parentGroupId: 'c' },
        { id: 'c', name: 'C', tabOrder: 2, parentGroupId: 'a' }
      ]
    ]) {
      const groups = normalizeProjectGroups(input)
      expectEveryGroupToReachRoot(groups)
      expect(groups.some((group) => group.parentGroupId === null)).toBe(true)
    }
  })

  it('leaves an acyclic tree unchanged', () => {
    const groups = normalizeProjectGroups([
      { id: 'root', name: 'Root', tabOrder: 0, parentGroupId: null },
      { id: 'child', name: 'Child', tabOrder: 1, parentGroupId: 'root' },
      { id: 'grandchild', name: 'Grandchild', tabOrder: 2, parentGroupId: 'child' }
    ])

    expect(groups.map(({ id, parentGroupId }) => ({ id, parentGroupId }))).toEqual([
      { id: 'root', parentGroupId: null },
      { id: 'child', parentGroupId: 'root' },
      { id: 'grandchild', parentGroupId: 'child' }
    ])
  })

  it('handles empty-string ids without treating them as absent', () => {
    const cyclic = normalizeProjectGroups([
      { id: '', name: 'Empty', tabOrder: 0, parentGroupId: 'b' },
      { id: 'b', name: 'B', tabOrder: 1, parentGroupId: '' }
    ])
    expectEveryGroupToReachRoot(cyclic)

    const rooted = normalizeProjectGroups([
      { id: '', name: 'Root', tabOrder: 0, parentGroupId: null },
      { id: 'child', name: 'Child', tabOrder: 1, parentGroupId: '' }
    ])
    expect(rooted.find((group) => group.id === 'child')?.parentGroupId).toBe('')
  })

  it('clears a missing empty-string parent without clearing a real one', () => {
    const missing = normalizeProjectGroups([
      { id: 'orphan', name: 'Orphan', tabOrder: 0, parentGroupId: '' }
    ])
    expect(missing[0]?.parentGroupId).toBeNull()

    const present = normalizeProjectGroups([
      { id: '', name: 'Root', tabOrder: 0, parentGroupId: null },
      { id: 'child', name: 'Child', tabOrder: 1, parentGroupId: '' }
    ])
    expect(present.find((group) => group.id === 'child')?.parentGroupId).toBe('')
  })

  it('normalizes a cycle alongside a missing parent', () => {
    const groups = normalizeProjectGroups([
      { id: 'a', name: 'A', tabOrder: 0, parentGroupId: 'b' },
      { id: 'b', name: 'B', tabOrder: 1, parentGroupId: 'a' },
      { id: 'c', name: 'C', tabOrder: 2, parentGroupId: 'ghost' }
    ])

    expect(groups.find((group) => group.id === 'c')?.parentGroupId).toBeNull()
    expectEveryGroupToReachRoot(groups)
  })
})
