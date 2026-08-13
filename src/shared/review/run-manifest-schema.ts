import { z } from 'zod'
import { AGENT_FAMILIES } from './agent-family'
import { FindingSeveritySchema } from './finding-schema'
import { PrepassCheckStatusSchema, PrepassStatusSchema } from './prepass-result-schema'
import {
  ModelIndependenceSchema,
  ResolveTargetKindSchema,
  ReviewDepthSchema,
  ReviewProfileSchema,
  ReviewVerdictSchema
} from './stage-schemas'

// A narrower check shape than PrepassResult's — no `output` — matching
// upstream `build_manifest`'s field allowlist for the replay record.
const ManifestPrepassCheckSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  exit_code: z.number().int(),
  status: PrepassCheckStatusSchema
})

const ReviewerSummarySchema = z.object({
  agent: z.string().nullable(),
  family: z.enum(AGENT_FAMILIES).nullable(),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  thinking: z.string().nullable(),
  independence: ModelIndependenceSchema
})

const TargetSummarySchema = z.object({
  kind: ResolveTargetKindSchema,
  ref: z.string(),
  artifact_hash: z.string(),
  size_metric: z.number().int().nonnegative()
})

const PrepassSummarySchema = z.object({
  status: PrepassStatusSchema,
  checks: z.array(ManifestPrepassCheckSchema)
})

/**
 * `manifest.trust` — the recorded trust basis for stage workers this port
 * ships (tech.md § Stage worker bounding); `workspace_trust` names the
 * agent-trust preset in force, or null when none applies.
 */
export const RunManifestTrustSchema = z.object({
  worker_bound: z.literal('prompt'),
  output_channel: z.literal('driver-written'),
  artifact_snapshot: z.literal('diff+materialized-tree'),
  workspace_trust: z.string().nullable()
})

// Mirrors the shape of the orchestration worker-start launch selection
// without importing it: src/shared/ cannot depend on src/main/.
const LaunchSelectionSchema = z.object({
  agent: z.string().nullable(),
  model: z.string().nullable(),
  effort: z.string().nullable()
})

const LaunchReceiptSchema = z.object({
  stage: z.string().min(1),
  attempt: z.number().int().min(1),
  requested: LaunchSelectionSchema,
  effective: LaunchSelectionSchema.nullable()
})

/**
 * `manifest.json` — the replay record a run's surfaces read from. `verdict`
 * and every count come from the gate; `reviewer.independence` is
 * recomputed here from effective launch receipts and is the only
 * independence value any surface may read (`ModelSelection.independence`
 * is provisional).
 */
export const RunManifestSchema = z.object({
  reviewer: ReviewerSummarySchema,
  target: TargetSummarySchema,
  profile: ReviewProfileSchema,
  depth: ReviewDepthSchema,
  lens: z.string().nullable(),
  prepass: PrepassSummarySchema,
  suppressed_count: z.number().int().nonnegative(),
  severity_histogram: z.partialRecord(FindingSeveritySchema, z.number().int().nonnegative()),
  blocking_count: z.number().int().nonnegative(),
  advisory_count: z.number().int().nonnegative(),
  regrade_count: z.number().int().nonnegative(),
  limitation_count: z.number().int().nonnegative(),
  question_count: z.number().int().nonnegative(),
  unreviewed_paths: z.array(z.string()),
  verdict: ReviewVerdictSchema,
  trust: RunManifestTrustSchema,
  launch_receipts: z.array(LaunchReceiptSchema)
})
export type RunManifest = z.infer<typeof RunManifestSchema>
