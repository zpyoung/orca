import { z } from 'zod'

export const EffectCertaintySchema = z.enum(['landed', 'not-landed', 'indeterminate'])
export type EffectCertainty = z.infer<typeof EffectCertaintySchema>

export const ActionOutcomeSchema = z
  .object({
    effect: EffectCertaintySchema,
    result: z.unknown().optional(),
    expectedBefore: z.string().optional(),
    expectedAfter: z.string().optional(),
    reason: z.string().optional()
  })
  .strict()

export type ActionOutcome = z.infer<typeof ActionOutcomeSchema>

/** Resolves an effect only when the authority shows one of the two expected states. */
export function resolveByExpectedState(
  observed: string,
  expectedBefore: string,
  expectedAfter: string
): EffectCertainty {
  if (observed === expectedAfter) {
    return 'landed'
  }
  if (observed === expectedBefore) {
    return 'not-landed'
  }
  return 'indeterminate'
}
