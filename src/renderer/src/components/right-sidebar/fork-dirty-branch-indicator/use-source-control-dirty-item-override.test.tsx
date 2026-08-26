// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GitStatusEntry } from '../../../../../shared/git-status-types'
import { useSourceControlDirtyItemOverride } from './use-source-control-dirty-item-override'
import { SourceControlDirtyIcon } from './source-control-dirty-icon'

const mocks = vi.hoisted(() => ({ useAppStore: vi.fn() }))

// The hook takes a selector, so the mock has to run it against a fake state
// rather than return a fixed value.
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => mocks.useAppStore(selector)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace('{{value0}}', String(options?.value0 ?? ''))
}))

function renderOverride(state: {
  activeWorktreeId: string | null
  gitStatusByWorktree?: Record<string, GitStatusEntry[]>
  gitStatusHugeByWorktree?: Record<string, { limit: number }>
}) {
  mocks.useAppStore.mockImplementation((selector: (s: unknown) => unknown) => selector(state))
  return renderHook(() => useSourceControlDirtyItemOverride())
}

const CHANGE: GitStatusEntry = { path: 'a.ts', status: 'modified', area: 'unstaged' }

describe('useSourceControlDirtyItemOverride', () => {
  it('overrides nothing when the active worktree is clean', () => {
    const { result } = renderOverride({
      activeWorktreeId: 'wt-1',
      gitStatusByWorktree: { 'wt-1': [] }
    })
    expect(result.current).toEqual({})
  })

  it('overrides nothing when no worktree is active', () => {
    const { result } = renderOverride({ activeWorktreeId: null, gitStatusByWorktree: {} })
    expect(result.current).toEqual({})
  })

  it('swaps in the dotted icon and a singular title for one change', () => {
    const { result } = renderOverride({
      activeWorktreeId: 'wt-1',
      gitStatusByWorktree: { 'wt-1': [CHANGE] }
    })
    expect(result.current.icon).toBe(SourceControlDirtyIcon)
    expect(result.current.title).toBe('Source Control — 1 uncommitted change')
  })

  it('counts changes into the title so the tooltip and aria-label carry it', () => {
    const { result } = renderOverride({
      activeWorktreeId: 'wt-1',
      gitStatusByWorktree: { 'wt-1': [CHANGE, { ...CHANGE, path: 'b.ts' }] }
    })
    expect(result.current.title).toBe('Source Control — 2 uncommitted changes')
  })

  it('marks the count as a floor when git status was truncated', () => {
    const { result } = renderOverride({
      activeWorktreeId: 'wt-1',
      gitStatusByWorktree: { 'wt-1': [CHANGE, { ...CHANGE, path: 'b.ts' }] },
      gitStatusHugeByWorktree: { 'wt-1': { limit: 2 } }
    })
    expect(result.current.title).toBe('Source Control — 2+ uncommitted changes')
  })

  it('reports an exact count when another worktree is the truncated one', () => {
    const { result } = renderOverride({
      activeWorktreeId: 'wt-1',
      gitStatusByWorktree: { 'wt-1': [CHANGE] },
      gitStatusHugeByWorktree: { 'wt-2': { limit: 2 } }
    })
    expect(result.current.title).toBe('Source Control — 1 uncommitted change')
  })

  it('overrides nothing when the store snapshot carries no git-status maps', () => {
    const { result } = renderOverride({ activeWorktreeId: 'wt-1' })
    expect(result.current).toEqual({})
  })

  it('ignores dirt in a worktree that is not the active one', () => {
    const { result } = renderOverride({
      activeWorktreeId: 'wt-1',
      gitStatusByWorktree: { 'wt-1': [], 'wt-2': [CHANGE] }
    })
    expect(result.current).toEqual({})
  })
})
