import { describe, expect, it } from 'vitest'
import { CampaignSchema } from './campaign-schema'

describe('CampaignSchema', () => {
  const campaign = {
    campaign_hash: 'campaign-hash',
    target_kind: 'worktree',
    scope: 'WORKTREE',
    baseline: null,
    profile: 'code-diff',
    criteria: 'Focus on the new auth flow.',
    protocol_version: 'quirk-2026.7.31+orca.1',
    dismissed: [
      {
        id: 'F1',
        run_id: 'run-1',
        claim: 'Token is logged in plaintext.',
        category: 'secret-exposure',
        effective_severity: 'HIGH',
        reason: 'Fixed in a follow-up commit before this run.',
        dismissed_at: '2026-08-13T00:00:00Z'
      }
    ],
    accepted_open: [
      {
        id: 'F2',
        run_id: 'run-1',
        claim: 'No rate limit on the login endpoint.',
        category: 'missing-rate-limit',
        effective_severity: 'MEDIUM',
        evidence_refs: ['src/auth/login.ts:40']
      }
    ],
    runs: ['run-1']
  }

  it('round-trips a campaign with a dismissal and an accepted-open finding', () => {
    expect(CampaignSchema.parse(campaign)).toEqual(campaign)
  })

  it('round-trips a fresh campaign with nothing dismissed or accepted yet', () => {
    const fresh = { ...campaign, dismissed: [], accepted_open: [], runs: [] }
    expect(CampaignSchema.safeParse(fresh).success).toBe(true)
  })

  it('round-trips a commit-baseline campaign', () => {
    expect(
      CampaignSchema.safeParse({ ...campaign, target_kind: 'commit', baseline: 'a'.repeat(40) })
        .success
    ).toBe(true)
  })

  it('rejects a dismissed entry with an invalid severity', () => {
    expect(
      CampaignSchema.safeParse({
        ...campaign,
        dismissed: [{ ...campaign.dismissed[0], effective_severity: 'URGENT' }]
      }).success
    ).toBe(false)
  })
})
