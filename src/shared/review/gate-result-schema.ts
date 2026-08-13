import { z } from 'zod'
import { FindingIdSchema, FindingSchema, FindingSeveritySchema } from './finding-schema'
import { ChainSchema, ReviewDepthSchema, ReviewVerdictSchema } from './stage-schemas'

const SuppressedFindingSchema = z.object({
  id: FindingIdSchema,
  reason: z.string().min(1),
  ruling: z.string().min(1).optional()
})
export type SuppressedFinding = z.infer<typeof SuppressedFindingSchema>

const GateResultShape = z.object({
  verdict: ReviewVerdictSchema.nullable().optional(),
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

/**
 * `GateResult` — the evidence gate's output. `chain` is always present in
 * the port, including at `quick` depth where upstream emits none
 * (`run-shape.ts`): the manifest can then refuse a disordered pipeline the
 * same way regardless of depth.
 *
 * Orca deviation from upstream, deliberate: a non-empty `contested[]` result
 * carries no verdict at all (logic.md "no verdict at all"; upstream's own
 * `compute_verdict` would return `NEEDS_FIXES` for the same input) — the
 * mapping runs only once tiebreak clears `contested[]`. A later differential
 * golden test against the pinned script must name this divergence.
 */
export const GateResultSchema = GateResultShape.superRefine((value, ctx) => {
  const hasVerdict = value.verdict !== null && value.verdict !== undefined
  if (value.contested.length > 0 && hasVerdict) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verdict'],
      message: 'a gate result with a non-empty contested[] carries no verdict'
    })
  } else if (value.contested.length === 0 && !hasVerdict) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['verdict'],
      message: 'verdict is required once contested[] is empty'
    })
  }
})
export type GateResult = z.infer<typeof GateResultSchema>
