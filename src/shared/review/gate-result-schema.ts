import { z } from 'zod'
import { FindingIdSchema, FindingSchema, FindingSeveritySchema } from './finding-schema'
import { ChainSchema, ReviewDepthSchema, ReviewVerdictSchema } from './stage-schemas'

const SuppressedFindingSchema = z.object({
  id: FindingIdSchema,
  reason: z.string().min(1),
  ruling: z.string().min(1).optional()
})
export type SuppressedFinding = z.infer<typeof SuppressedFindingSchema>

/**
 * `GateResult` — the evidence gate's output. `chain` is always present in
 * the port, including at `quick` depth where upstream emits none
 * (`run-shape.ts`): the manifest can then refuse a disordered pipeline the
 * same way regardless of depth.
 */
export const GateResultSchema = z.object({
  verdict: ReviewVerdictSchema,
  findings: z.array(FindingSchema),
  limitations: z.array(FindingSchema),
  questions: z.array(FindingSchema),
  contested: z.array(FindingSchema),
  suppressed: z.array(SuppressedFindingSchema),
  suppressed_count: z.number().int().nonnegative(),
  depth: ReviewDepthSchema,
  severity_histogram: z.partialRecord(FindingSeveritySchema, z.number().int().nonnegative()),
  blocking_count: z.number().int().nonnegative(),
  advisory_count: z.number().int().nonnegative(),
  contested_count: z.number().int().nonnegative(),
  unreviewed_paths: z.array(z.string()),
  regrade_count: z.number().int().nonnegative(),
  chain: ChainSchema
})
export type GateResult = z.infer<typeof GateResultSchema>
