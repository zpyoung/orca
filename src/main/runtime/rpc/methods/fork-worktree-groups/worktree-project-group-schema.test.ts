import { describe, expect, it } from 'vitest'
import { WorktreeSet } from '../worktree-schemas'

describe('worktree.set projectGroupId schema', () => {
  it.each([
    ['string', 'group-1', true],
    ['null', null, true],
    ['omitted', undefined, true],
    ['invalid', 42, false]
  ])('accepts %s values only when valid', (_name, projectGroupId, success) => {
    const payload =
      projectGroupId === undefined
        ? { worktree: 'id:wt-1' }
        : { worktree: 'id:wt-1', projectGroupId }
    const parsed = WorktreeSet.safeParse(payload)
    expect(parsed.success).toBe(success)
    if (parsed.success) {
      expect(parsed.data.projectGroupId).toBe(projectGroupId)
    }
  })
})
