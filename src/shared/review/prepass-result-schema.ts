import { z } from 'zod'
import { FindingSchema } from './finding-schema'
import { ChainSchema } from './stage-schemas'

export const PREPASS_STATUSES = ['pass', 'fail', 'could-not-run'] as const
export const PrepassStatusSchema = z.enum(PREPASS_STATUSES)
export type PrepassStatus = z.infer<typeof PrepassStatusSchema>

export const PREPASS_CHECK_STATUSES = ['pass', 'fail', 'not-applicable'] as const
export const PrepassCheckStatusSchema = z.enum(PREPASS_CHECK_STATUSES)
export type PrepassCheckStatus = z.infer<typeof PrepassCheckStatusSchema>

export const PrepassCheckSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  exit_code: z.number().int(),
  status: PrepassCheckStatusSchema,
  output: z.string()
})
export type PrepassCheck = z.infer<typeof PrepassCheckSchema>

/**
 * `PrepassResult` — the ground-truth layer's output; every failed check
 * becomes a `failing-check` finding at HIGH/HIGH, `stage: 'prepass'`
 * (upstream `failed_check_finding`). `observed_artifact_hash` is null only
 * when the artifact could not be read at all (`status: 'could-not-run'`).
 */
export const PrepassResultSchema = z.object({
  status: PrepassStatusSchema,
  checks: z.array(PrepassCheckSchema),
  findings: z.array(FindingSchema),
  observed_artifact_hash: z.string().nullable(),
  chain: ChainSchema
})
export type PrepassResult = z.infer<typeof PrepassResultSchema>
