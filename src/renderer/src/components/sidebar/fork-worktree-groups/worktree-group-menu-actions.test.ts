import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../shared/worktree/types'
import {
  addWorktreeToGroup,
  createGroupFromWorktree,
  getWorktreeGroupMenuVisibility,
  removeWorktreeFromGroup,
  shouldShowRemoveWorktreeFromGroup
} from './worktree-group-menu-actions'

const worktree = { id: 'wt-1', instanceId: 'instance-1', projectGroupId: null }

describe('worktree group menu actions', () => {
  it('writes add and remove membership to the selected worktree', () => {
    const update = vi.fn()
    addWorktreeToGroup(worktree.id, 'group-1', update)
    removeWorktreeFromGroup(worktree.id, update)
    expect(update).toHaveBeenNthCalledWith(1, worktree.id, { projectGroupId: 'group-1' })
    expect(update).toHaveBeenNthCalledWith(2, worktree.id, { projectGroupId: null })
  })

  it('shows remove only for a present membership', () => {
    expect(shouldShowRemoveWorktreeFromGroup({ projectGroupId: 'group-1' })).toBe(true)
    expect(shouldShowRemoveWorktreeFromGroup({ projectGroupId: null })).toBe(false)
    expect(shouldShowRemoveWorktreeFromGroup({ projectGroupId: undefined })).toBe(false)
  })

  it.each([
    [
      null,
      [{ id: 'group-1' }],
      'git',
      true,
      { showWorktreeCreate: true, showAddSubmenu: true, showProjectCreate: false }
    ],
    [
      'folder-1',
      [{ id: 'group-1' }],
      'git',
      true,
      { showWorktreeCreate: false, showAddSubmenu: false, showProjectCreate: true }
    ],
    [
      null,
      [{ id: 'group-1' }],
      'folder',
      true,
      { showWorktreeCreate: false, showAddSubmenu: false, showProjectCreate: true }
    ],
    [
      null,
      [],
      'git',
      true,
      { showWorktreeCreate: true, showAddSubmenu: false, showProjectCreate: false }
    ],
    [
      null,
      [{ id: 'group-1' }],
      undefined,
      true,
      { showWorktreeCreate: true, showAddSubmenu: true, showProjectCreate: false }
    ],
    [
      'folder-1',
      [{ id: 'group-1' }],
      undefined,
      false,
      { showWorktreeCreate: false, showAddSubmenu: false, showProjectCreate: false }
    ]
  ] as const)(
    'uses the correct visibility matrix',
    (folderWorkspaceId, groups, kind, hasRepo, expected) => {
      expect(getWorktreeGroupMenuVisibility(folderWorkspaceId, groups, kind, hasRepo)).toEqual(
        expected
      )
    }
  )

  it('does not write membership when group creation fails', async () => {
    const update = vi.fn().mockResolvedValue({ ok: true })
    await createGroupFromWorktree(worktree, 'Solo', vi.fn().mockResolvedValue(null), update)
    expect(update).not.toHaveBeenCalled()
  })

  it('creates a group and assigns only the captured worktree', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'group-new' })
    const update = vi.fn().mockResolvedValue({ ok: true })
    await createGroupFromWorktree(worktree, 'Solo', create, update)
    expect(create).toHaveBeenCalledWith('Solo')
    expect(update).toHaveBeenCalledWith(
      worktree.id,
      { projectGroupId: 'group-new' },
      expect.objectContaining({ shouldApply: expect.any(Function) })
    )
  })

  it.each([
    ['unchanged worktree', { ...worktree }, true],
    ['deleted worktree', undefined, false],
    ['replacement instance', { ...worktree, instanceId: 'instance-2' }, false],
    ['changed membership', { ...worktree, projectGroupId: 'other' }, false],
    ['pre-grouped unchanged membership', { ...worktree, projectGroupId: 'old' }, true]
  ] as const)('guards the async assignment against %s', async (_name, current, expected) => {
    const captured =
      current?.projectGroupId === 'old' ? { ...worktree, projectGroupId: 'old' } : worktree
    const update = vi.fn().mockResolvedValue({ ok: true })
    await createGroupFromWorktree(
      captured,
      'Solo',
      vi.fn().mockResolvedValue({ id: 'group-new' }),
      update
    )
    const shouldApply = update.mock.calls[0]?.[2]?.shouldApply as
      | ((candidate: Worktree | undefined) => boolean)
      | undefined
    expect(shouldApply?.(current as Worktree | undefined)).toBe(expected)
  })
})
