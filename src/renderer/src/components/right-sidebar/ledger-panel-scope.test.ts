import { describe, expect, it } from 'vitest'
import {
  getLedgerPanelFilters,
  getLedgerPanelScope,
  getLedgerPanelTarget,
  getLedgerPanelTiers,
  isLedgerEntryFiledHere,
  type LedgerPanelScope
} from './ledger-panel-scope'

describe('ledger panel scope', () => {
  it.each([
    ['repo/worktree', false],
    ['folder:folder-id', true]
  ])('sends %s verbatim', (id, isFolderWorkspace) => {
    expect(getLedgerPanelScope(id, { activeRuntimeEnvironmentId: null }, false)).toEqual({
      workspaceId: id,
      isFolderWorkspace,
      hasGroup: false
    })
  })
  it('has no target without a workspace', () => {
    expect(getLedgerPanelScope(null, { activeRuntimeEnvironmentId: 'paired' }, true)).toBeNull()
  })
  it('preserves the resolved paired owner', () => {
    expect(getLedgerPanelScope('remote', { activeRuntimeEnvironmentId: 'paired' }, true)).toEqual({
      workspaceId: 'remote',
      isFolderWorkspace: false,
      hasGroup: true,
      environmentId: 'paired'
    })
  })
  it.each(['local', 'ssh'])('uses the local runtime for a resolved %s workspace', (id) => {
    expect(getLedgerPanelScope(id, { activeRuntimeEnvironmentId: null }, false)).not.toHaveProperty(
      'environmentId'
    )
  })
  it.each([
    ['folder:x', 'x', true],
    ['x', 'folder:x', true],
    ['folder:x', 'folder:x', true],
    ['folder:x', 'y', false],
    ['worktree', 'worktree', true],
    ['worktree', 'other', false],
    ['worktree', undefined, false],
    [null, 'worktree', false]
  ])('compares workspace %s with origin %s', (workspaceId, originId, expected) => {
    expect(isLedgerEntryFiledHere({ workspaceId: originId ?? undefined }, workspaceId)).toBe(
      expected
    )
  })

  const worktreeScope: LedgerPanelScope = {
    workspaceId: 'repo/worktree',
    isFolderWorkspace: false,
    hasGroup: true
  }
  const folderScope: LedgerPanelScope = {
    workspaceId: 'folder:x',
    isFolderWorkspace: true,
    hasGroup: true
  }

  it('offers the project tier only to git workspaces', () => {
    expect(getLedgerPanelTiers(worktreeScope)).toEqual(['workspace', 'project', 'group'])
    expect(getLedgerPanelTiers(folderScope)).toEqual(['workspace', 'group'])
  })
  it('hides the group tier when the workspace has no group', () => {
    expect(getLedgerPanelTiers({ ...worktreeScope, hasGroup: false })).toEqual([
      'workspace',
      'project'
    ])
    expect(getLedgerPanelTiers(null)).toEqual(['workspace', 'project'])
  })
  it('reads the owning ledger for the workspace and project tiers, the group ledger for group', () => {
    expect(getLedgerPanelTarget(worktreeScope, 'workspace')).toEqual({
      workspaceId: 'repo/worktree'
    })
    expect(getLedgerPanelTarget(worktreeScope, 'project')).toEqual({ workspaceId: 'repo/worktree' })
    expect(getLedgerPanelTarget(worktreeScope, 'group')).toEqual({
      workspaceId: 'repo/worktree',
      group: true
    })
  })
  it('narrows to the filing workspace only on the workspace tier', () => {
    expect(getLedgerPanelFilters(worktreeScope, 'workspace', { type: 'bug' })).toEqual({
      type: 'bug',
      workspaceId: 'repo/worktree'
    })
    expect(getLedgerPanelFilters(worktreeScope, 'project', { type: 'bug' })).toEqual({
      type: 'bug'
    })
    expect(getLedgerPanelFilters(worktreeScope, 'group', { type: 'bug' })).toEqual({ type: 'bug' })
  })
})
