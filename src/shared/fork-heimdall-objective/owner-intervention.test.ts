import { describe, expect, it } from 'vitest'
import { describeObjectiveInterventions } from './owner-intervention'

describe('describeObjectiveInterventions', () => {
  it('tells the owner retry-node redispatches append-only, never rewriting node history', () => {
    const brief = describeObjectiveInterventions()
    const retryNodeEntry = brief.split('\n').find((line) => line.startsWith('{"kind":"retry-node"'))

    expect(retryNodeEntry).toBeDefined()
    expect(retryNodeEntry).toContain('append-only')
    expect(retryNodeEntry).toContain('never amend, rebase, squash or reset')
    expect(retryNodeEntry).toContain('a new commit')
  })
})
