import { describe, expect, it } from 'vitest'
import { withActiveTabTypeForWorktree } from './active-tab-type-record'

describe('withActiveTabTypeForWorktree', () => {
  it('sets the worktree entry to a concrete type', () => {
    const result = withActiveTabTypeForWorktree({}, 'wt-1', 'terminal')
    expect(result).toEqual({ 'wt-1': 'terminal' })
  })

  it('omits the key instead of writing null when type is null', () => {
    const result = withActiveTabTypeForWorktree({ 'wt-1': 'terminal' }, 'wt-1', null)
    expect('wt-1' in result).toBe(false)
  })

  it('returns the same reference when the value is already correct', () => {
    const record = { 'wt-1': 'terminal' as const }
    expect(withActiveTabTypeForWorktree(record, 'wt-1', 'terminal')).toBe(record)
  })

  it('returns the same reference when clearing a key that is already absent', () => {
    const record = { 'wt-2': 'browser' as const }
    expect(withActiveTabTypeForWorktree(record, 'wt-1', null)).toBe(record)
  })

  it('leaves other worktrees untouched when setting or clearing one entry', () => {
    const record = { 'wt-1': 'terminal' as const, 'wt-2': 'browser' as const }
    expect(withActiveTabTypeForWorktree(record, 'wt-1', null)).toEqual({ 'wt-2': 'browser' })
    expect(withActiveTabTypeForWorktree(record, 'wt-1', 'editor')).toEqual({
      'wt-1': 'editor',
      'wt-2': 'browser'
    })
  })
})
