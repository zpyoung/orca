import { describe, expect, it } from 'vitest'
import { ObjectiveDetailSchema, ObjectiveLandingProjectionSchema } from './detail-types'

const CONTRACT = {
  objectiveText: 'Implement the objective',
  tier: 'standard' as const,
  landingBar: 'hosted-review' as const,
  maxConcurrency: 1,
  workspaceKind: 'git' as const,
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

describe('objective landing projection boundaries', () => {
  it('retains owner-only lineage and rung payload fields in the internal projection', () => {
    expect(
      ObjectiveLandingProjectionSchema.parse({
        rung: 'hosted-review',
        revisionId: 'revision-1',
        contentIdentity: 'content-1',
        fromContentIdentity: 'checked-content',
        provider: 'github',
        reviewNumber: 42,
        reviewUrl: 'https://github.com/acme/repo/pull/42',
        branch: 'feature/objective',
        headSha: 'commit-1',
        base: 'main',
        atMs: 100
      })
    ).toMatchObject({
      fromContentIdentity: 'checked-content',
      provider: 'github',
      reviewNumber: 42
    })
  })

  it('keeps objective detail landing rows on the strict three-key wire pick', () => {
    const detail = {
      contract: CONTRACT,
      revisions: [],
      nodes: [],
      verdicts: [],
      landing: [{ rung: 'hosted-review', contentIdentity: 'content-1', atMs: 100 }],
      asOfMs: 100
    }
    expect(ObjectiveDetailSchema.safeParse(detail).success).toBe(true)
    expect(
      ObjectiveDetailSchema.safeParse({
        ...detail,
        landing: [{ ...detail.landing[0], fromContentIdentity: 'checked-content' }]
      }).success
    ).toBe(false)
  })
})
