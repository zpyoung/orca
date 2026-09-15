import { describe, expect, it } from 'vitest'
import { canonicalCampaignIdentity, computeCampaignHash } from './campaign-identity'

const identity = {
  target_kind: 'worktree' as const,
  scope: 'WORKTREE',
  baseline: null,
  profile: 'code-diff' as const,
  criteria: 'Ship safely.',
  protocol_version: 'quirk-2026.7.31+orca.1'
}

describe('campaign identity', () => {
  it('hashes the six sorted identity components', () => {
    expect(canonicalCampaignIdentity(identity)).toBe(
      '{"baseline":null,"criteria":"Ship safely.","profile":"code-diff","protocol_version":"quirk-2026.7.31+orca.1","scope":"WORKTREE","target_kind":"worktree"}'
    )
    expect(computeCampaignHash(identity)).toBe(
      'f399d5593bec826ebaf87904a0ace5af8f3c596bcf29cd5047cb0d6e518a111e'
    )
  })

  it('changes with criteria or protocol, while depth is structurally absent', () => {
    expect(computeCampaignHash({ ...identity, criteria: 'Different.' })).not.toBe(
      computeCampaignHash(identity)
    )
    expect(computeCampaignHash({ ...identity, protocol_version: 'next' })).not.toBe(
      computeCampaignHash(identity)
    )
    expect('depth' in identity).toBe(false)
  })
})
