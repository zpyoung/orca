import { describe, expect, it } from 'vitest'
import type { GitStatusEntry } from '../../../../../shared/git-status-types'
import { countDirtyWorktreeChanges } from './dirty-worktree-change-count'

function entry(overrides: Partial<GitStatusEntry> & { path: string }): GitStatusEntry {
  return { status: 'modified', area: 'unstaged', ...overrides }
}

describe('countDirtyWorktreeChanges', () => {
  it('reports zero for a clean worktree', () => {
    expect(countDirtyWorktreeChanges([])).toBe(0)
  })

  it('counts staged, unstaged, and untracked entries alike', () => {
    const entries = [
      entry({ path: 'a.ts', area: 'staged' }),
      entry({ path: 'b.ts', area: 'unstaged' }),
      entry({ path: 'c.ts', area: 'untracked', status: 'untracked' })
    ]
    expect(countDirtyWorktreeChanges(entries)).toBe(3)
  })

  it('counts the same path once per staging area, matching the panel rows', () => {
    const entries = [
      entry({ path: 'a.ts', area: 'staged' }),
      entry({ path: 'a.ts', area: 'unstaged' })
    ]
    expect(countDirtyWorktreeChanges(entries)).toBe(2)
  })

  it('ignores rows lazily loaded from inside an expanded submodule', () => {
    const entries = [
      entry({
        path: 'vendor/lib',
        submodule: { commitChanged: false, trackedChanges: true, untrackedChanges: false }
      }),
      entry({ path: 'vendor/lib/src/x.ts', submoduleRoot: 'vendor/lib' })
    ]
    expect(countDirtyWorktreeChanges(entries)).toBe(1)
  })
})
