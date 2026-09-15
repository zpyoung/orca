import { createHash } from 'node:crypto'
import type { ResolveTargetKind, ReviewProfile } from './stage-schemas'
import { canonicalJson } from './stage-chain'

export type CampaignIdentity = {
  target_kind: ResolveTargetKind
  scope: string
  baseline: string | null
  profile: ReviewProfile
  criteria: string
  protocol_version: string
}

/** Depth is intentionally absent: deeper closure passes stay in the same campaign. */
export function canonicalCampaignIdentity(identity: CampaignIdentity): string {
  return canonicalJson({
    target_kind: identity.target_kind,
    scope: identity.scope,
    baseline: identity.baseline,
    profile: identity.profile,
    criteria: identity.criteria,
    protocol_version: identity.protocol_version
  })
}

export function computeCampaignHash(identity: CampaignIdentity): string {
  return createHash('sha256').update(canonicalCampaignIdentity(identity)).digest('hex')
}

export const campaignHash = computeCampaignHash
