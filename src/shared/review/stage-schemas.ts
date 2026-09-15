import { z } from 'zod'
import { AGENT_FAMILIES } from './agent-family'
import {
  EvidenceSchema,
  FindingCategorySchema,
  FindingConfidenceSchema,
  FindingDispositionSchema,
  FindingIdSchema,
  FindingNonBlankTextSchema,
  FindingSchema,
  FindingSeveritySchema
} from './finding-schema'
import { REVIEW_CHAIN_STEPS, REVIEW_DEPTHS } from './run-shape'

export const ReviewDepthSchema = z.enum(REVIEW_DEPTHS)
export type ReviewDepth = z.infer<typeof ReviewDepthSchema>

export const ChainStepSchema = z.enum(REVIEW_CHAIN_STEPS)
export type ChainStepValue = z.infer<typeof ChainStepSchema>

export const REVIEW_VERDICTS = ['PASS', 'NEEDS_FIXES', 'CRITICAL_ISSUES', 'NOT_REVIEWABLE'] as const
export const ReviewVerdictSchema = z.enum(REVIEW_VERDICTS)
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>

export const REVIEW_PROFILES = ['code-diff', 'spec-design', 'plan', 'prose-claim'] as const
export const ReviewProfileSchema = z.enum(REVIEW_PROFILES)
export type ReviewProfile = z.infer<typeof ReviewProfileSchema>

export const RESOLVE_TARGET_KINDS = ['git-range', 'worktree', 'path', 'commit', 'hosted'] as const
export const ResolveTargetKindSchema = z.enum(RESOLVE_TARGET_KINDS)
export type ResolveTargetKind = z.infer<typeof ResolveTargetKindSchema>

/**
 * Names the run, the artifact, and the step that produced this payload, plus
 * (the port's addition) `attempt`: upstream has no retry identity, and a
 * retry must replace its predecessor under a fresh attempt rather than
 * reusing one. `predecessor` is null only for `resolve`, which mints `run_id`.
 */
export const ChainSchema = z.object({
  run_id: z.string().min(1),
  artifact_hash: z.string().min(1),
  step: ChainStepSchema,
  predecessor: z.string().nullable(),
  attempt: z.number().int().min(1)
})
export type Chain = z.infer<typeof ChainSchema>

export const MergeChainSchema = ChainSchema.extend({
  step: z.literal('merge'),
  stage: z.enum(['refute', 'tiebreak'])
})
export type MergeChain = z.infer<typeof MergeChainSchema>

export const ResolveResultSchema = z.object({
  profile: ReviewProfileSchema,
  target_kind: ResolveTargetKindSchema,
  target_ref: z.string(),
  artifact_hash: z.string(),
  diff_file: z.string().nullable(),
  untracked_paths: z.array(z.string()),
  size_metric: z.number().int().nonnegative(),
  depth_suggestion: ReviewDepthSchema,
  contract_surface: z.boolean(),
  chain: ChainSchema
})
export type ResolveResult = z.infer<typeof ResolveResultSchema>

export const REVIEW_RUN_STATES = [
  'running',
  'completed',
  'failed',
  'aborted',
  'interrupted'
] as const
export const ReviewRunStateSchema = z.enum(REVIEW_RUN_STATES)
export type ReviewRunState = z.infer<typeof ReviewRunStateSchema>

/**
 * `run.json`. `verdict`/`campaign_hash` are nullable because campaign
 * identity is only known once `resolve` succeeds (tech.md § Data models).
 */
export const RunRecordSchema = z.object({
  run_id: z.string().min(1),
  workspace_id: z.string().min(1),
  state: ReviewRunStateSchema,
  verdict: ReviewVerdictSchema.nullable(),
  campaign_hash: z.string().nullable(),
  orchestration_run_id: z.string().min(1),
  driver_terminal_handle: z.string().min(1),
  depth: ReviewDepthSchema,
  profile: ReviewProfileSchema,
  created_at: z.string().min(1),
  updated_at: z.string().min(1),
  protocol_version: z.string().min(1)
})
export type RunRecord = z.infer<typeof RunRecordSchema>

export const MODEL_SELECTION_INDEPENDENCE = ['full', 'reduced'] as const
export const ModelIndependenceSchema = z.enum(MODEL_SELECTION_INDEPENDENCE)
export type ModelIndependence = z.infer<typeof ModelIndependenceSchema>

const ModelLadderRungSchema = z.object({
  agent: z.string().min(1),
  checked: z.boolean(),
  resolved: z.boolean()
})

/**
 * Upstream's alias ladder rebuilt over Orca's `TuiAgent` catalog; `alias` is
 * renamed `agent` throughout the port. `family` reuses the same
 * `AgentFamily` vocabulary as `./agent-family.ts`. `independence` here is
 * provisional — the manifest recomputes it from effective launch receipts.
 */
export const ModelSelectionSchema = z.object({
  resolved: z.boolean(),
  agent: z.string().nullable(),
  family: z.enum(AGENT_FAMILIES).nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  independence: ModelIndependenceSchema,
  ladder: z.array(ModelLadderRungSchema),
  chain: ChainSchema
})
export type ModelSelection = z.infer<typeof ModelSelectionSchema>

export const ClaimsResultSchema = z.object({
  claims: z.array(
    z.object({
      id: FindingIdSchema,
      severity: FindingSeveritySchema,
      confidence: FindingConfidenceSchema,
      category: FindingCategorySchema,
      claim: FindingNonBlankTextSchema,
      evidence: z.array(EvidenceSchema).min(1)
    })
  ),
  findings: z.array(FindingSchema),
  carried_kinds: z.array(z.enum(['limitation', 'question'])),
  chain: ChainSchema.extend({ step: z.literal('claims') })
})
export type ClaimsResult = z.infer<typeof ClaimsResultSchema>

export const StageJudgmentSchema = z.object({
  id: FindingIdSchema,
  disposition: FindingDispositionSchema,
  reason: FindingNonBlankTextSchema,
  severity: FindingSeveritySchema.optional(),
  confidence: FindingConfidenceSchema.optional(),
  counter_evidence: z.array(EvidenceSchema).optional()
})
export type StageJudgment = z.infer<typeof StageJudgmentSchema>

export const MergeResultSchema = z
  .object({
    findings: z.array(FindingSchema),
    stage: z.enum(['refute', 'tiebreak']),
    judged: z.number().int().nonnegative(),
    chain: MergeChainSchema
  })
  .superRefine((result, ctx) => {
    if (result.stage !== result.chain.stage) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chain', 'stage'],
        message: 'merge envelope and chain stages must agree'
      })
    }
  })
export type MergeResult = z.infer<typeof MergeResultSchema>

export const QuickFindingsResultSchema = z.object({
  findings: z.array(FindingSchema),
  suppressed: z.array(
    z.object({
      id: FindingIdSchema.optional(),
      reason: z.string().min(1)
    })
  )
})
export type QuickFindingsResult = z.infer<typeof QuickFindingsResultSchema>
