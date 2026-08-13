import { z } from 'zod'
import { FindingSeveritySchema } from './finding-schema'
import { ResolveTargetKindSchema, ReviewProfileSchema } from './stage-schemas'

const DismissedFindingSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  claim: z.string().min(1),
  category: z.string().min(1),
  effective_severity: FindingSeveritySchema,
  reason: z.string().min(1),
  dismissed_at: z.string().min(1)
})

const AcceptedOpenFindingSchema = z.object({
  id: z.string().min(1),
  run_id: z.string().min(1),
  claim: z.string().min(1),
  category: z.string().min(1),
  effective_severity: FindingSeveritySchema,
  evidence_refs: z.array(z.string())
})

/**
 * `campaigns/<campaign-hash>.json` — the closure-round ledger keyed by
 * `campaign_hash` (sha256 of the identity components; depth excluded).
 * Dismissal reasons live only here and in the panel — never in a stage
 * input.
 */
export const CampaignSchema = z.object({
  campaign_hash: z.string().min(1),
  target_kind: ResolveTargetKindSchema,
  scope: z.string(),
  baseline: z.string().nullable(),
  profile: ReviewProfileSchema,
  criteria: z.string(),
  protocol_version: z.string().min(1),
  dismissed: z.array(DismissedFindingSchema),
  accepted_open: z.array(AcceptedOpenFindingSchema),
  runs: z.array(z.string().min(1))
})
export type Campaign = z.infer<typeof CampaignSchema>
