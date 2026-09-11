import { describe, expect, it } from 'vitest'

import { getWorktreeDragUnitGroups } from '../worktree-drag-units'
import { needsWorktreeDragGroup } from './worktree-drag-group-key'

describe('worktree drag group keys', () => {
  it('keeps ordinary rows in their rendered header group', () => {
    expect(needsWorktreeDragGroup('repo:one', 'all')).toBe(false)
  })

  it('gives loose worktrees their own drag group', () => {
    const groups = getWorktreeDragUnitGroups([
      { type: 'header', key: 'project-group:g1' },
      {
        type: 'item',
        worktree: { id: 'loose' },
        depth: 0,
        sectionKey: 'project-group:g1::loose'
      }
    ])

    expect(groups).toEqual([
      {
        key: 'project-group:g1::loose',
        worktreeIds: ['loose'],
        units: [{ worktreeId: 'loose', worktreeIds: ['loose'] }]
      }
    ])
  })
})
