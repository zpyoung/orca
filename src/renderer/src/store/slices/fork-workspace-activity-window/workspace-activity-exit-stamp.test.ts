import { describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { WorktreeSliceGet } from '@/store/slices/worktrees/listing/worktree-slice-types'
import { markWorkspaceActivityExitOnActivation } from './workspace-activity-exit-stamp'

function createGet(rows: Worktree[]): {
  get: WorktreeSliceGet
  markWorkspaceActivityExit: ReturnType<typeof vi.fn>
} {
  const markWorkspaceActivityExit = vi.fn()
  const state = {
    getKnownWorktreeById: (id: string) => rows.find((row) => row.id === id),
    markWorkspaceActivityExit
  }
  return { get: (() => state) as unknown as WorktreeSliceGet, markWorkspaceActivityExit }
}

const localRow = { id: 'workspace', hostId: undefined } as unknown as Worktree
const remoteRow = { id: 'workspace', hostId: 'ssh:hostA' } as unknown as Worktree

describe('markWorkspaceActivityExitOnActivation', () => {
  it('stamps a local row unqualified even though the activation records a host', () => {
    const { get, markWorkspaceActivityExit } = createGet([localRow])
    markWorkspaceActivityExitOnActivation(get, 'workspace', 'local', 'next', 'local')
    expect(markWorkspaceActivityExit).toHaveBeenCalledWith('workspace', undefined)
  })

  it('stamps a hosted row under its own host', () => {
    const { get, markWorkspaceActivityExit } = createGet([remoteRow])
    markWorkspaceActivityExitOnActivation(get, 'workspace', 'ssh:hostA', 'next', 'local')
    expect(markWorkspaceActivityExit).toHaveBeenCalledWith('workspace', 'ssh:hostA')
  })

  it('falls back to the activation host for a row that is not a worktree', () => {
    const { get, markWorkspaceActivityExit } = createGet([])
    markWorkspaceActivityExitOnActivation(get, 'folder:abc', 'ssh:hostB', 'next', 'local')
    expect(markWorkspaceActivityExit).toHaveBeenCalledWith('folder:abc', 'ssh:hostB')
  })

  it('does not stamp when the activation stays on the same workspace', () => {
    const { get, markWorkspaceActivityExit } = createGet([remoteRow])
    markWorkspaceActivityExitOnActivation(get, 'workspace', 'ssh:hostA', 'workspace', 'ssh:hostA')
    expect(markWorkspaceActivityExit).not.toHaveBeenCalled()
  })
})
