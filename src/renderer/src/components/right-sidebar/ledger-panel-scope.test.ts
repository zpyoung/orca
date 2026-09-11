import { describe, expect, it } from 'vitest'
import { getLedgerPanelScope, isLedgerEntryFiledHere } from './ledger-panel-scope'

describe('ledger panel scope', () => {
  it.each(['repo/worktree', 'folder:folder-id'])('sends %s verbatim', (id) => {
    expect(getLedgerPanelScope(id, { activeRuntimeEnvironmentId: null })).toEqual({
      target: { workspaceId: id }
    })
  })
  it('has no target without a workspace', () => {
    expect(getLedgerPanelScope(null, { activeRuntimeEnvironmentId: 'paired' })).toBeNull()
  })
  it('preserves the resolved paired owner', () => {
    expect(getLedgerPanelScope('remote', { activeRuntimeEnvironmentId: 'paired' })).toEqual({
      target: { workspaceId: 'remote' },
      environmentId: 'paired'
    })
  })
  it.each(['local', 'ssh'])('uses the local runtime for a resolved %s workspace', (id) => {
    expect(getLedgerPanelScope(id, { activeRuntimeEnvironmentId: null })).not.toHaveProperty(
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
})
